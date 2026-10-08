import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { hmacSha256Hex, md5Hex, verifyHmacSha256, verifyMd5 } from '../supabase/functions/_shared/ad-signatures.ts'
import { AD_PROTOCOLS, checkPostback, secretEnvName, signedString } from '../supabase/functions/_shared/ad-postback.ts'

describe('MD5 (RFC 1321 vectors) and HMAC-SHA-256 (RFC 4231) through Web Crypto', () => {
  it('md5 matches the RFC test suite and Node', () => {
    const vectors: Record<string, string> = {
      '': 'd41d8cd98f00b204e9800998ecf8427e',
      a: '0cc175b9c0f1b6a831c399e269772661',
      abc: '900150983cd24fb0d6963f7d28e17f72',
      'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
      'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b',
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a',
    }
    for (const [input, hash] of Object.entries(vectors)) expect(md5Hex(input)).toBe(hash)
    for (const input of ['x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'привіт 🚀', '1:2:secret']) {
      expect(md5Hex(input)).toBe(crypto.createHash('md5').update(input).digest('hex'))
    }
  })

  it('hmac matches RFC 4231 test case 2 and Node', async () => {
    expect(await hmacSha256Hex('what do ya want for nothing?', 'Jefe')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    for (const [payload, secret] of [['123:abc', 's3cret'], ['', 'k'], ['привіт', 'ключ']]) {
      expect(await hmacSha256Hex(payload, secret)).toBe(crypto.createHmac('sha256', secret).update(payload).digest('hex'))
    }
  })

  it('verifyHmacSha256: right signature passes; wrong secret, payload, length, case tricks and junk fail', async () => {
    const good = crypto.createHmac('sha256', 'topsecret').update('42:tx1').digest('hex')
    expect(await verifyHmacSha256('42:tx1', 'topsecret', good)).toBe(true)
    expect(await verifyHmacSha256('42:tx1', 'topsecret', good.toUpperCase())).toBe(true) // hex case is not a difference
    expect(await verifyHmacSha256('42:tx1', 'topsecret', `sha256=${good}`)).toBe(true)
    expect(await verifyHmacSha256('42:tx2', 'topsecret', good)).toBe(false)
    expect(await verifyHmacSha256('42:tx1', 'other', good)).toBe(false)
    expect(await verifyHmacSha256('42:tx1', '', good)).toBe(false)
    for (const bad of ['', 'zz', good.slice(1), good + '0', undefined, null, 5, {}, '0'.repeat(64)]) expect(await verifyHmacSha256('42:tx1', 'topsecret', bad)).toBe(false)
  })

  it('verifyMd5: right hash passes; anything else fails', () => {
    const good = crypto.createHash('md5').update('42:tx1:topsecret').digest('hex')
    expect(verifyMd5('42:tx1:topsecret', good)).toBe(true)
    expect(verifyMd5('42:tx1:topsecret2', good)).toBe(false)
    for (const bad of ['', 'zz', good.slice(1), good + '0', undefined, null, 5]) expect(verifyMd5('42:tx1:topsecret', bad)).toBe(false)
  })
})

describe('checkPostback', () => {
  const env = (vars: Record<string, string>) => ({ get: (n: string) => vars[n] })
  const sign = async (provider: string, user: string, tx: string, secret: string) => {
    const p = AD_PROTOCOLS[provider]
    const text = signedString(p, user, tx, secret)
    return p.method === 'md5' ? crypto.createHash('md5').update(text).digest('hex') : crypto.createHmac('sha256', secret).update(text).digest('hex')
  }
  const query = (provider: string, user: string, tx: string, sig: string, extra = '') => {
    const p = AD_PROTOCOLS[provider]
    return new URLSearchParams(`${p.userParam}=${user}&${p.txParam}=${encodeURIComponent(tx)}&${p.signatureParam}=${sig}${extra}`)
  }

  it('accepts a correctly signed postback for every network, md5 and hmac', async () => {
    for (const provider of Object.keys(AD_PROTOCOLS)) {
      const secret = `${provider}-secret`
      const sig = await sign(provider, '777', 'tx-1', secret)
      expect(await checkPostback(provider, query(provider, '777', 'tx-1', sig), env({ [secretEnvName(provider)]: secret }))).toEqual({ ok: true, provider, telegramId: 777, txId: 'tx-1' })
    }
  })

  it('a payload that carries its own reward cannot change anything: the amount is not part of the decision', async () => {
    const sig = await sign('gigapub', '5', 'e1', 's')
    const d = await checkPostback('gigapub', query('gigapub', '5', 'e1', sig, '&reward=1000000&amount=999'), env({ GIGAPUB_SECRET: 's' }))
    expect(d).toEqual({ ok: true, provider: 'gigapub', telegramId: 5, txId: 'e1' })
    expect(JSON.stringify(d)).not.toMatch(/1000000|999/)
  })

  it('refuses in a fixed order: unknown network 404, no secret 503, malformed 400, bad signature 401', async () => {
    expect(await checkPostback('nope', new URLSearchParams(), env({}))).toMatchObject({ ok: false, status: 404 })
    expect(await checkPostback(null, new URLSearchParams(), env({}))).toMatchObject({ ok: false, status: 404 })
    expect(await checkPostback('adsgram; drop', new URLSearchParams(), env({}))).toMatchObject({ ok: false, status: 404 })
    const sig = await sign('adsgram', '7', 'a', 's')
    expect(await checkPostback('adsgram', query('adsgram', '7', 'a', sig), env({}))).toMatchObject({ ok: false, status: 503 })
    const e = env({ ADSGRAM_SECRET: 's' })
    expect(await checkPostback('adsgram', new URLSearchParams('userid=7'), e)).toMatchObject({ ok: false, status: 400 })
    expect(await checkPostback('adsgram', query('adsgram', '0', 'a', sig), e)).toMatchObject({ ok: false, status: 400 })
    expect(await checkPostback('adsgram', query('adsgram', 'abc', 'a', sig), e)).toMatchObject({ ok: false, status: 400 })
    expect(await checkPostback('adsgram', query('adsgram', '7', "a'; --", sig), e)).toMatchObject({ ok: false, status: 400 })
    expect(await checkPostback('adsgram', query('adsgram', '7', 'a', 'f'.repeat(32)), e)).toMatchObject({ ok: false, status: 401 })
  })

  it('a signature cannot be moved to another user or another transaction, nor made with another network\'s secret', async () => {
    const e = env({ ADSGRAM_SECRET: 's', MONETAG_SECRET: 's' })
    const sig = await sign('adsgram', '7', 'a', 's')
    expect(await checkPostback('adsgram', query('adsgram', '8', 'a', sig), e)).toMatchObject({ ok: false, status: 401 })
    expect(await checkPostback('adsgram', query('adsgram', '7', 'b', sig), e)).toMatchObject({ ok: false, status: 401 })
    const hmac = await sign('monetag', '7', 'a', 's')
    expect(await checkPostback('adsgram', query('adsgram', '7', 'a', hmac), e)).toMatchObject({ ok: false, status: 401 })
  })

  it('the secret is never in a decision', async () => {
    const d = await checkPostback('adsgram', query('adsgram', '7', 'a', 'f'.repeat(32)), env({ ADSGRAM_SECRET: 'hunter2hunter2' }))
    expect(JSON.stringify(d)).not.toContain('hunter2')
  })
})

// ---------------------------------------------------------------------------
describe('process_ad_reward (SQL)', () => {
  let db: PGlite
  let admin: string
  let n = 0
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const num = (v: unknown) => Number(v)
  const newUser = async (o: { banned?: boolean; admin?: boolean } = {}) =>
    one<string>(`insert into users(telegram_id, is_banned, is_admin) values ($1, $2, $3) returning id v`, [9000 + ++n, o.banned ?? false, o.admin ?? false])
  const reward = async (user: string, provider: string, tx: string) =>
    (await db.query<{ r: Record<string, unknown> }>(`select process_ad_reward($1::uuid, $2, $3) r`, [user, provider, tx])).rows[0].r
  const balance = async (u: string) => num(await one(`select balance::text v from wallets where user_id = $1`, [u]))
  const setProvider = (id: string, o: { reward?: number; limit?: number; active?: boolean }) =>
    db.query(`select admin_set_ad_provider($1::uuid, $2, $3::numeric, $4::numeric, $5::boolean)`, [admin, id, o.reward ?? null, o.limit ?? null, o.active ?? null])
  const setMax = (v: number) => db.query(`update platform_settings set max_daily_ad_earnings = $1 where id = 1`, [v])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin = await newUser({ admin: true })
  }, 180_000)

  it('the networks are seeded OFF; the rewards and caps are closed to clients; only the service role can run it', async () => {
    expect(await rows(`select id, reward_amount::text r, is_active a from ad_providers order by id`)).toEqual([
      { id: 'adsgram', r: '0.0050', a: false }, { id: 'gigapub', r: '0.0050', a: false }, { id: 'monetag', r: '0.0050', a: false }])
    const g = (await rows(`select has_function_privilege('anon', 'process_ad_reward(uuid, text, text)', 'execute') a, has_function_privilege('authenticated', 'process_ad_reward(uuid, text, text)', 'execute') u,
                                  has_table_privilege('authenticated', 'user_ad_ledger', 'select') t`))[0]
    expect([g.a, g.u, g.t]).toEqual([false, false, false])
  })

  it('an inactive network pays nothing, remembers the postback, and answers the retry the same way', async () => {
    const u = await newUser()
    expect(await reward(u, 'adsgram', 'off-1')).toMatchObject({ status: 'rejected', reason: 'provider_inactive' })
    expect(await balance(u)).toBe(0)
    expect(await reward(u, 'adsgram', 'off-1')).toMatchObject({ status: 'duplicate', was: 'rejected' })
  })

  it('credits the FIXED reward once; the ledger entry and the wallet entry are linked; the wallet shows type ad_reward', async () => {
    await setProvider('adsgram', { reward: 0.01, limit: 1, active: true })
    await setMax(5)
    const u = await newUser()
    expect(await reward(u, 'adsgram', 'tx-1')).toMatchObject({ status: 'credited', reward: 0.01 })
    expect(await balance(u)).toBe(0.01)
    expect(await rows(`select l.reward_amount::text r, w.type::text t, w.amount::text a from user_ad_ledger l join wallet_transactions w on w.id = l.wallet_transaction_id where l.user_id = $1`, [u]))
      .toEqual([{ r: '0.0100', t: 'ad_reward', a: '0.0100' }])
  })

  it('identical postbacks are idempotent: no second credit however often they arrive', async () => {
    const u = await newUser()
    await reward(u, 'adsgram', 'same')
    for (let i = 0; i < 5; i++) expect(await reward(u, 'adsgram', 'same')).toMatchObject({ status: 'duplicate' })
    expect(await balance(u)).toBe(0.01)
    expect(num(await one(`select count(*) v from user_ad_ledger where user_id = $1`, [u]))).toBe(1)
  })

  it('the same transaction id on another network is a different transaction', async () => {
    await setProvider('monetag', { reward: 0.02, limit: 1, active: true })
    const u = await newUser()
    await reward(u, 'adsgram', 'shared-id')
    expect(await reward(u, 'monetag', 'shared-id')).toMatchObject({ status: 'credited', reward: 0.02 })
    expect(await balance(u)).toBe(0.03)
  })

  it('a transaction id cannot be replayed by another user', async () => {
    const a = await newUser(), b = await newUser()
    await reward(a, 'adsgram', 'owned')
    await expect(reward(b, 'adsgram', 'owned')).rejects.toThrow(/ad_tx_conflict/)
    expect(await balance(b)).toBe(0)
  })

  it('the per-network daily cap: the postback that would cross it is refused softly, and so is every later one', async () => {
    await setProvider('adsgram', { reward: 0.01, limit: 0.03 })
    const u = await newUser()
    for (const tx of ['a', 'b', 'c']) expect(await reward(u, 'adsgram', tx)).toMatchObject({ status: 'credited' })
    expect(await reward(u, 'adsgram', 'd')).toMatchObject({ status: 'rejected', reason: 'provider_daily_limit_reached' })
    expect(await balance(u)).toBe(0.03)
    // another network still pays: the cap is per network
    expect(await reward(u, 'monetag', 'm1')).toMatchObject({ status: 'credited' })
    await setProvider('adsgram', { limit: 1 })
  })

  it('the global daily cap (all networks together) is enforced exactly, to the last 1e-4', async () => {
    await setMax(0.03) // adsgram 0.01 + monetag 0.02 = 0.03
    const u = await newUser()
    expect(await reward(u, 'adsgram', 'g1')).toMatchObject({ status: 'credited' })
    expect(await reward(u, 'monetag', 'g2')).toMatchObject({ status: 'credited' })
    expect(await reward(u, 'adsgram', 'g3')).toMatchObject({ status: 'rejected', reason: 'daily_limit_reached' })
    expect(await balance(u)).toBe(0.03)
    // nothing is rounded away: 0.0299 of room is not enough for 0.0100 + 0.0200
    await setMax(0.0299)
    const v = await newUser()
    await reward(v, 'monetag', 'h1')
    expect(await reward(v, 'adsgram', 'h2')).toMatchObject({ status: 'rejected', reason: 'daily_limit_reached' })
    await setMax(5)
  })

  it('the window is a rolling 24 hours: older rewards stop counting, rejected ones never count', async () => {
    await setMax(0.02)
    const u = await newUser()
    // two rewards from 25 hours ago (history is append-only, so they are inserted as such)
    const w = await one<string>(`select id v from wallets where user_id = $1`, [u])
    for (const tx of ['old1', 'old2']) {
      const wtx = await one<string>(`insert into wallet_transactions(wallet_id, type, status, amount, balance_after, idempotency_key) values ($1, 'bonus', 'completed', 0.01, 0.01, $2) returning id v`, [w, `seed-${tx}-${u}`])
      await db.query(`insert into user_ad_ledger(user_id, provider_id, external_tx_id, status, reward_amount, wallet_transaction_id, created_at) values ($1, 'adsgram', $2, 'credited', 0.01, $3, now() - interval '25 hours')`, [u, tx, wtx])
    }
    expect(await reward(u, 'adsgram', 'new1')).toMatchObject({ status: 'credited' })
    expect(await reward(u, 'adsgram', 'new2')).toMatchObject({ status: 'credited' })
    expect(await reward(u, 'adsgram', 'new3')).toMatchObject({ status: 'rejected' })
    await setMax(5)
  })

  it('a banned user and an unknown wallet earn nothing', async () => {
    const banned = await newUser({ banned: true })
    expect(await reward(banned, 'adsgram', 'b1')).toMatchObject({ status: 'rejected', reason: 'user_banned' })
    await expect(reward('00000000-0000-4000-8000-0000000000ff', 'adsgram', 'x')).rejects.toThrow(/wallet not found/)
    await expect(reward(await newUser(), 'unknown', 'x')).rejects.toThrow(/ad_provider_not_found/)
    await expect(reward(await newUser(), 'adsgram', '')).rejects.toThrow(/transaction id/)
    await expect(reward(await newUser(), 'adsgram', 'x'.repeat(129))).rejects.toThrow(/transaction id/)
  })

  it('the ledger is append-only and every wallet still equals the sum of its ledger', async () => {
    await expect(db.query(`update user_ad_ledger set reward_amount = 9`)).rejects.toThrow(/append-only/)
    await expect(db.query(`delete from user_ad_ledger`)).rejects.toThrow(/append-only/)
    const bad = await rows(`select count(*)::int n from wallets w where not exists (select 1 from wallet_transactions s where s.wallet_id = w.id and s.idempotency_key like 'seed-%') -- the window test plants history by hand
        and w.balance <> (select coalesce(sum(amount), 0) from wallet_transactions t where t.wallet_id = w.id and t.status = 'completed')`)
    expect(bad[0].n).toBe(0)
  })

  it('admin_set_ad_provider: admins only, bounded, audited', async () => {
    const user = await newUser()
    await expect(db.query(`select admin_set_ad_provider($1::uuid, 'adsgram', 0.01)`, [user])).rejects.toThrow(/forbidden/)
    await expect(setProvider('adsgram', { reward: 0 })).rejects.toThrow(/reward must be/)
    await expect(setProvider('adsgram', { reward: 101 })).rejects.toThrow(/reward must be/)
    await expect(setProvider('nope', { reward: 1 })).rejects.toThrow(/ad_provider_not_found/)
    expect(num(await one(`select count(*) v from admin_audit_log where action = 'set_ad_provider'`))).toBeGreaterThanOrEqual(3)
  })
})
