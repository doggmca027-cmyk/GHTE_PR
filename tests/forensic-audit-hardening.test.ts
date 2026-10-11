// Forensic verification V1-V5 follow-up: every finding is reproduced here first (red), then fixed (green).
//   #1 one transaction hash in two encodings (hex / base64) must be ONE hash      #6 provider host must not resolve to a private address
//   #2 service_role cannot write wallets / treasury_state directly                  #7 a referral clawback after a payout is a tracked debt
//   #3 a user without a wallet counts as ledger drift                                (#8 ad postbacks: the ad module was removed, 20261120000000)
//   #4 only finalized, non-emulated Toncenter transactions count                     #9 a banned customer gets nothing from the remaining endpoints
//   #5 PROVIDER_KEY_SECRET rotation without an outage (previous key as fallback)     (#10 lives in scripts/concurrency-test.ts, scenario V)
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkResolvedHost, isBlockedIp } from '../supabase/functions/_shared/admin-providers.ts'
import { mapQuoteError } from '../supabase/functions/_shared/discounts.ts'
import { decryptSecret, encryptSecret, resolveProviderApiKey } from '../supabase/functions/_shared/secrets.ts'
import { canonicalTxHash, normalizeToncenterTransactions } from '../supabase/functions/_shared/ton.ts'

const ROOT = path.resolve(__dirname, '..')

async function world(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`)
  const dir = path.join(ROOT, 'supabase', 'migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  await db.exec(`
    insert into providers(id, name, api_url, routing_enabled, health_status, provider_balance, last_balance_sync) values
      ('00000000-0000-0000-0000-0000000000a2', 'A', 'https://a.example', true, 'healthy', 1000, now());
    insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', (select id from platforms where slug = 'telegram'), 'V', 'v');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
      ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000000a2', '1', 'A', 1.0, 100, 100000);
    insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', 'V', '00000000-0000-0000-0000-000000000a01', 4.0, 100, 100000);
    delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values
      ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000a01', 1.0, 100, 100000);`)
  return db
}

let tg = 70_000
const newUser = async (db: PGlite, funds = 0, admin = false) => {
  const { id } = (await db.query<{ id: string }>(`insert into users(telegram_id, is_admin) values ($1, $2) returning id`, [++tg, admin])).rows[0]
  if (funds > 0) await db.query(`select process_wallet_transaction($1::uuid,'deposit',$2::numeric,null,'f','f-'||$1::text)`, [id, funds])
  return id
}
const err = async (p: Promise<unknown>): Promise<string> => { try { await p } catch (e) { return e instanceof Error ? e.message : String(e) } return '' }
const bal = async (db: PGlite, u: string) => Number((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [u])).rows[0].b)
let memoSeq = 0
const deposit = async (db: PGlite, u: string) => (await db.query<{ id: string }>(
  `insert into deposits (user_id, amount_usd, amount_crypto, rate_usd, memo, recipient_address, valid_until)
   values ($1, 10, 2, 5, $2, 'UQr', now() + interval '30 minutes') returning id`, [u, `dep_${(++memoSeq).toString(16).padStart(32, 'f')}`])).rows[0].id
const asAdmin = (db: PGlite, id: string | null) => db.query(`select set_config('request.jwt.sub', $1, false)`, [id ?? ''])
const placeCompleted = async (db: PGlite, user: string, key: string) => {
  const o = (await db.query<{ id: string }>(`select id from place_order($1::uuid,'00000000-0000-0000-0000-0000000000f1','https://t.me/x',10000,
    '00000000-0000-0000-0000-00000000aa01','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000a01',10,$2)`, [user, key])).rows[0].id
  await db.query(`update orders set status = 'processing' where id = $1`, [o])
  await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [o, `P-${key}`])
  await db.query(`update orders set status = 'completed' where id = $1`, [o])
  return o
}

describe('forensic hardening (database)', () => {
  let db: PGlite
  beforeAll(async () => { db = await world() }, 120_000)
  afterAll(async () => { await db.close() })

  describe('#1 one transaction, one hash, whatever its encoding', () => {
    const raw = randomBytes(32)
    const b64 = raw.toString('base64'), hex = raw.toString('hex')

    it('normalize_ton_tx_hash gives every encoding the same canonical form, and agrees with ton.ts', async () => {
      const forms = [b64, hex, hex.toUpperCase(), `0x${hex}`, raw.toString('base64url'), b64.replace(/=$/, '')]
      for (const f of forms) {
        expect((await db.query<{ h: string }>(`select normalize_ton_tx_hash($1) h`, [f])).rows[0].h).toBe(b64)
        expect(canonicalTxHash(f)).toBe(b64)
      }
      for (const bad of ['', 'H', 'TX-1', 'a b', hex.slice(2), `${b64}AA`, 'z'.repeat(64)]) {
        expect(await err(db.query(`select normalize_ton_tx_hash($1)`, [bad]))).toMatch(/invalid_tx_hash/)
        expect(canonicalTxHash(bad)).toBeNull()
      }
    })

    it('a deposit paid with base64 X cannot be credited again with hex X, by the admin or by the verifier', async () => {
      const admin = await newUser(db, 0, true)
      const user = await newUser(db)
      const a = await deposit(db, user), b = await deposit(db, user), c = await deposit(db, user)
      await db.query(`select complete_deposit($1::uuid, $2, null, 2000000000)`, [a, b64])
      await asAdmin(db, admin)
      expect(await err(db.query(`select admin_resolve_deposit($1::uuid, 'credit', $2, 2000000000, 'hex of the same tx')`, [b, hex]))).toMatch(/tx_already_used/)
      await asAdmin(db, null)
      expect(await err(db.query(`select complete_deposit($1::uuid, $2, null, 2000000000)`, [c, `0x${hex.toUpperCase()}`]))).toMatch(/tx_already_used/)
      expect(await bal(db, user)).toBe(10)
      expect((await db.query<{ h: string }>(`select tx_hash h from deposits where id = $1`, [a])).rows[0].h).toBe(b64)
    })

    it('the replay of a completed deposit is recognised in any encoding', async () => {
      const admin = await newUser(db, 0, true)
      const user = await newUser(db)
      const d = await deposit(db, user)
      const h = randomBytes(32)
      await db.query(`select complete_deposit($1::uuid, $2, null, 2000000000)`, [d, h.toString('base64')])
      await asAdmin(db, admin)
      const r = (await db.query<{ r: { replayed: boolean; credited: number } }>(`select admin_resolve_deposit($1::uuid, 'credit', $2, 2000000000, 'x') r`, [d, h.toString('hex')])).rows[0].r
      await asAdmin(db, null)
      expect(r).toMatchObject({ replayed: true, credited: 0 })
      expect(await bal(db, user)).toBe(10)
    })

    it('a stored hash is always canonical (the column refuses anything else)', async () => {
      const user = await newUser(db)
      const d = await deposit(db, user)
      expect(await err(db.query(`update deposits set status = 'completed', completed_at = now(), tx_hash = $2 where id = $1`, [d, randomBytes(32).toString('hex')]))).toMatch(/deposits_tx_hash_canonical/)
    })
  })

  describe('#2 wallets and treasury_state are written only by their ledger functions', () => {
    it('service_role (which bypasses RLS on Supabase) can neither insert, update, delete nor truncate them', async () => {
      const user = await newUser(db, 5)
      await db.exec(`set role service_role`)
      try {
        for (const sql of [
          `update wallets set balance = 999 where user_id = '${user}'`, `delete from wallets where user_id = '${user}'`,
          `insert into wallets (user_id) values (gen_random_uuid())`, `truncate wallets`,
          `update treasury_state set balance = 999`, `insert into treasury_state (id) values (2)`, `delete from treasury_state`, `truncate treasury_state`,
        ]) expect(await err(db.query(sql)), sql).toMatch(/permission denied/)
        // ...while signing up, money movements and the treasury ledger still work for it
        const fresh = (await db.query<{ id: string }>(`insert into users (telegram_id) values ($1) returning id`, [++tg])).rows[0].id
        expect((await db.query(`select 1 from wallets where user_id = $1`, [fresh])).rows).toHaveLength(1)
        await db.query(`select process_wallet_transaction($1::uuid, 'bonus', 1, null, 'ok', 'ok-' || $1::text)`, [user])
        await db.query(`select process_treasury_transaction('deposit', 3, 'top up', 'probe-1')`)
      } finally {
        await db.exec(`reset role`)
      }
      expect(Number((await db.query<{ b: string }>(`select balance::text b from treasury_state`)).rows[0].b)).toBe(3)
    })

    it('even the owner cannot move the treasury balance outside process_treasury_transaction', async () => {
      expect(await err(db.query(`update treasury_state set balance = balance + 100`))).toMatch(/treasury balance can only be changed/)
      expect(await err(db.query(`do $$ begin perform set_config('app.wallet_op','on',true); update treasury_state set balance = 1; end $$`))).toMatch(/treasury balance can only be changed/)
    })
  })

  describe('#3 ledger drift also counts users without a wallet', () => {
    it('a deleted wallet is drift', async () => {
      const before = Number((await db.query<{ n: number }>(`select ledger_drift_count() n`)).rows[0].n)
      const user = await newUser(db)
      await db.query(`delete from wallets where user_id = $1`, [user]) // only the table owner can still do this
      expect(Number((await db.query<{ n: number }>(`select ledger_drift_count() n`)).rows[0].n)).toBe(before + 1)
      await db.query(`insert into wallets (user_id) values ($1)`, [user])
      expect(Number((await db.query<{ n: number }>(`select ledger_drift_count() n`)).rows[0].n)).toBe(before)
    })
  })

  describe('#7 a referral clawback after the payout is a tracked debt', () => {
    it('shows the debt, blocks payouts until it is repaid, and repays it from the next reward', async () => {
      await db.query(`update platform_settings set referral_hold_days = 0, referral_reward_percentage = 10`)
      const referrer = await newUser(db)
      const buyer = await newUser(db, 1000)
      const code = (await db.query<{ c: string }>(`select referral_code c from users where id = $1`, [referrer])).rows[0].c
      await db.query(`select apply_referral($1::uuid, $2)`, [buyer, code])

      const o1 = await placeCompleted(db, buyer, 'ref-1')
      const b1 = (await db.query<{ b: { available: number; debt: number } }>(`select referral_balance($1::uuid) b`, [referrer])).rows[0].b
      expect(Number(b1.available)).toBeGreaterThan(0)
      const reward = Number(b1.available)
      await db.query(`select transfer_affiliate_balance_to_wallet($1::uuid, null, 'payout-1')`, [referrer])
      expect(await bal(db, referrer)).toBe(reward)

      await db.query(`select refund_order($1::uuid, null, 'admin refund after completion')`, [o1]) // completed -> refunded: clawback
      const b2 = (await db.query<{ b: { total: number; available: number; debt: number } }>(`select referral_balance($1::uuid) b`, [referrer])).rows[0].b
      expect(Number(b2.debt)).toBe(reward)
      expect(Number(b2.available)).toBe(0)
      expect(Number(b2.total)).toBe(-reward)
      expect(await err(db.query(`select transfer_affiliate_balance_to_wallet($1::uuid, null, 'payout-2')`, [referrer]))).toMatch(/insufficient_affiliate_balance/)

      await placeCompleted(db, buyer, 'ref-2') // the next reward pays the debt back first
      const b3 = (await db.query<{ b: { available: number; debt: number } }>(`select referral_balance($1::uuid) b`, [referrer])).rows[0].b
      expect(Number(b3.debt)).toBe(0)
      expect(Number(b3.available)).toBe(0) // reward - debt = 0: same order size, same reward
      await db.query(`update platform_settings set referral_hold_days = 7, referral_reward_percentage = 5`)
    })
  })

  describe('#9 a banned customer gets nothing from the remaining endpoints', () => {
    it('analytics, quotes, referral summary and ticket reads refuse (or ignore) a banned user', async () => {
      const user = await newUser(db)
      await db.query(`select support_create_ticket($1::uuid, 'Hello there', 'help', null)`, [user])
      const ticket = (await db.query<{ id: string }>(`select id from support_tickets where user_id = $1`, [user])).rows[0].id
      await db.query(`update users set is_banned = true where id = $1`, [user])

      expect(Number((await db.query<{ n: number }>(`select record_client_events($1::uuid, '[{"name":"screen_view","properties":{}}]'::jsonb) n`, [user])).rows[0].n)).toBe(0)
      expect(await err(db.query(`select quote_order_price($1::uuid, '00000000-0000-0000-0000-0000000000f1', 1000, null)`, [user]))).toMatch(/user_banned/)
      expect(await err(db.query(`select referral_summary($1::uuid, 5)`, [user]))).toMatch(/user_banned/)
      expect(await err(db.query(`select support_list_my_tickets($1::uuid, 10, 0)`, [user]))).toMatch(/user_banned/)
      expect(await err(db.query(`select support_get_ticket($1::uuid, $2::uuid)`, [user, ticket]))).toMatch(/user_banned/)
      // the customer can still read their own row, so the app can show "account suspended"
      await db.exec(`set role authenticated; select set_config('request.jwt.sub', '${user}', false)`)
      expect((await db.query<{ is_banned: boolean }>(`select is_banned from users`)).rows).toEqual([{ is_banned: true }])
      await db.exec(`reset role`)
      await db.query(`select set_config('request.jwt.sub', '', false)`)
    })

    it('the quote endpoint maps the refusal to 403', () => {
      expect(mapQuoteError('user_banned: this account is suspended')).toMatchObject({ status: 403, error: 'banned' })
    })
  })
})

describe('#4 only finalized, non-emulated transactions count', () => {
  const tx = (over: Record<string, unknown>) => ({
    hash: randomBytes(32).toString('base64'), now: 1_700_000_000, description: { aborted: false },
    in_msg: { source: '0:' + 'cd'.repeat(32), destination: '0:' + 'ab'.repeat(32), value: '1', bounce: false, bounced: false, message_content: null },
    ...over,
  })
  it('drops emulated and non-finalized transactions, keeps finalized ones (and old payloads without the fields)', () => {
    const out = normalizeToncenterTransactions({ transactions: [
      tx({ finality: 'finalized', emulated: false }), tx({ finality: 'pending' }), tx({ finality: 'confirmed' }),
      tx({ emulated: true }), tx({ finality: 'finalized', emulated: true }), tx({}),
    ] })
    expect(out).toHaveLength(2)
  })
  it('stores the canonical (base64) hash, and skips a transaction whose hash is not a 32-byte hash', () => {
    const raw = randomBytes(32)
    const out = normalizeToncenterTransactions({ transactions: [tx({ hash: raw.toString('hex') }), tx({ hash: 'nonsense' })] })
    expect(out.map((t) => t.hash)).toEqual([raw.toString('base64')])
  })
})

describe('#5 PROVIDER_KEY_SECRET rotation without an outage', () => {
  const key = () => randomBytes(32).toString('base64')
  it('decrypts with the previous key when the current one does not fit, and only then', async () => {
    const oldKey = key(), newKey = key()
    const stored = await encryptSecret('panel-key', oldKey)
    expect(await decryptSecret(stored, newKey, oldKey)).toBe('panel-key')
    await expect(decryptSecret(stored, newKey)).rejects.toThrow()
    await expect(decryptSecret(stored, newKey, Buffer.alloc(16).toString('base64'))).rejects.toThrow() // an invalid previous key is ignored
    await expect(decryptSecret('v9:x:y', newKey, oldKey)).rejects.toThrow(/unsupported secret format/) // no fallback for malformed input
  })
  it('resolveProviderApiKey uses PROVIDER_KEY_SECRET_PREVIOUS while the stored ciphertext is still the old one', async () => {
    const oldKey = key(), newKey = key()
    const stored = await encryptSecret('panel-key', oldKey)
    const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] })
    expect(await resolveProviderApiKey({ name: 'P', api_key_encrypted: stored }, env({ PROVIDER_KEY_SECRET: newKey, PROVIDER_KEY_SECRET_PREVIOUS: oldKey }))).toBe('panel-key')
    await expect(resolveProviderApiKey({ name: 'P', api_key_encrypted: stored }, env({ PROVIDER_KEY_SECRET: newKey }))).rejects.toThrow()
  })
})

describe('#6 the provider host must resolve to public addresses only', () => {
  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])
      expect(isBlockedIp(ip), ip).toBe(true)
    for (const ip of ['1.1.1.1', '104.21.3.4', '2606:4700::6810:1503']) expect(isBlockedIp(ip), ip).toBe(false)
  })
  it('refuses a name that resolves to a private address, or does not resolve; accepts a public one', async () => {
    const resolver = (map: Record<string, string[]>) => async (host: string, type: 'A' | 'AAAA') => map[`${host}/${type}`] ?? []
    expect(await checkResolvedHost('https://panel.example/api/v2', resolver({ 'panel.example/A': ['104.21.3.4'] }))).toEqual({ ok: true })
    expect(await checkResolvedHost('https://evil.example/api', resolver({ 'evil.example/A': ['104.21.3.4'], 'evil.example/AAAA': ['::1'] }))).toMatchObject({ error: expect.stringMatching(/private|internal/) })
    expect(await checkResolvedHost('https://meta.example/api', resolver({ 'meta.example/A': ['169.254.169.254'] }))).toMatchObject({ error: expect.any(String) })
    expect(await checkResolvedHost('https://nothing.example/api', resolver({}))).toMatchObject({ error: expect.stringMatching(/resolve/) })
    expect(await checkResolvedHost('https://panel.example/api', null)).toEqual({ ok: true, skipped: true })
  })
  it('is wired into admin-providers before a URL is saved', () => {
    expect(fs.readFileSync(path.join(ROOT, 'supabase/functions/admin-providers/index.ts'), 'utf8')).toMatch(/checkResolvedHost\(/)
  })
})
