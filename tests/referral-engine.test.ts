import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { mapReferralError, normalizeReferralCode, parseReferralRequest, toSummaryDto } from '../supabase/functions/_shared/referrals.ts'

describe('normalizeReferralCode', () => {
  it('accepts a bare code and the Telegram start parameter', () => {
    expect(normalizeReferralCode('ab12cd34ef56')).toBe('ab12cd34ef56')
    expect(normalizeReferralCode('  REF_AB12CD34EF56 ')).toBe('ab12cd34ef56')
    expect(normalizeReferralCode('ref-ab12cd34ef56')).toBe('ab12cd34ef56')
  })
  it.each(['', 'short', 'has space in it', 'a'.repeat(33), "'; drop table users;--", 'ref_'])('refuses %j', (v) => {
    expect(normalizeReferralCode(v)).toBeNull()
  })
})

describe('parseReferralRequest', () => {
  it('rejects non-objects and unknown actions', () => {
    expect(parseReferralRequest(null)).toEqual({ error: 'Body must be a JSON object.' })
    expect(parseReferralRequest([])).toEqual({ error: 'Body must be a JSON object.' })
    expect(parseReferralRequest({ action: 'DROP' })).toEqual({ error: 'Unknown action.' })
  })
  it('SUMMARY takes nothing; a user id in the body is ignored', () => {
    expect(parseReferralRequest({ action: 'summary', userId: 'someone-else' })).toEqual({ action: 'SUMMARY' })
  })
  it('APPLY_CODE needs a valid code', () => {
    expect(parseReferralRequest({ action: 'APPLY_CODE', code: 'ref_ab12cd34ef56' })).toEqual({ action: 'APPLY_CODE', code: 'ab12cd34ef56' })
    expect(parseReferralRequest({ action: 'APPLY_CODE', code: 'x' })).toHaveProperty('error')
    expect(parseReferralRequest({ action: 'APPLY_CODE' })).toHaveProperty('error')
  })
  it('TRANSFER: amount and key are optional and validated', () => {
    expect(parseReferralRequest({ action: 'TRANSFER' })).toEqual({ action: 'TRANSFER', amount: null, idempotencyKey: null })
    expect(parseReferralRequest({ action: 'TRANSFER', amount: 1.23456, idempotencyKey: 'key-12345678' })).toEqual({ action: 'TRANSFER', amount: 1.2346, idempotencyKey: 'key-12345678' })
    for (const amount of [0, -1, '5', Number.NaN, Infinity, 2e9, 0.00001]) expect(parseReferralRequest({ action: 'TRANSFER', amount })).toHaveProperty('error')
    expect(parseReferralRequest({ action: 'TRANSFER', idempotencyKey: 'short' })).toHaveProperty('error')
    expect(parseReferralRequest({ action: 'TRANSFER', idempotencyKey: 'has spaces in it!!' })).toHaveProperty('error')
  })
})

describe('mapReferralError', () => {
  it('maps business errors and hides everything else', () => {
    expect(mapReferralError('referral_code_not_found: x').status).toBe(404)
    for (const m of ['self_referral: x', 'circular_referral: x', 'already_referred: x', 'referrer_locked: x', 'referral_too_late: x', 'referrer_unavailable: x', 'insufficient_affiliate_balance: x', 'idempotency_conflict: x']) {
      expect(mapReferralError(m).status).toBe(409)
    }
    expect(mapReferralError('user_banned: x').status).toBe(403)
    expect(mapReferralError('invalid_parameter_value: amount must be greater than zero')).toMatchObject({ status: 400, message: 'amount must be greater than zero' })
    expect(mapReferralError('connection to 10.0.0.1 refused')).toMatchObject({ status: 500, error: 'server_error' })
  })
})

describe('toSummaryDto', () => {
  it('camelCases the summary and builds the start parameter', () => {
    const dto = toSummaryDto({ code: 'ab12cd34ef56', referred: true, percentage: '5.00', hold_days: 7, invitees: 3, balance: { total: '1.5', pending: '0.5', available: '1' },
      recent: [{ id: 'e1', type: 'reward', amount: '0.2', order_id: 'o1', available_at: 't', created_at: 't' }] })
    expect(dto).toMatchObject({ startParam: 'ref_ab12cd34ef56', percentage: 5, holdDays: 7, invitees: 3, balance: { total: 1.5, pending: 0.5, available: 1 } })
    expect(dto.recent[0]).toEqual({ id: 'e1', type: 'reward', amount: 0.2, orderId: 'o1', availableAt: 't', createdAt: 't' })
  })
})

// ---------------------------------------------------------------------------
// The engine, against the real migrations
// ---------------------------------------------------------------------------
describe('referral engine (SQL)', () => {
  let db: PGlite
  let admin: string, alice: string, bob: string, carol: string, dave: string, banned: string
  let svc: string, svcTight: string
  let n = 0

  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const num = (v: unknown) => Number(v)
  const call = async (fn: string, ...args: unknown[]) => (await db.query<{ r: Record<string, unknown> }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)).rows[0].r
  const newUser = async (opts: { admin?: boolean; banned?: boolean; funds?: number } = {}) => {
    const id = await one<string>(`insert into users(telegram_id, is_admin, is_banned) values ($1, $2, $3) returning id v`, [1000 + ++n, opts.admin ?? false, opts.banned ?? false])
    if (opts.funds) await db.query(`select process_wallet_transaction($1::uuid, 'deposit', $2::numeric, null, 'fund', $3)`, [id, opts.funds, `fund-${id}`])
    return id
  }
  const codeOf = (u: string) => one<string>(`select referral_code v from users where id = $1`, [u])
  const refer = async (user: string, referrer: string) => call('apply_referral', user, await codeOf(referrer))
  /** A submitted order (the provider accepted it), ready for the provider's answer. */
  const order = async (user: string, o: { quantity?: number; service?: string; cost?: number } = {}) => {
    const service = o.service ?? svc
    const offer = (await rows(`select id, provider_id, provider_service_id, cost_per_1000 from provider_service_offers where service_id = $1`, [service]))[0]
    const quantity = o.quantity ?? 1000
    const id = await one<string>(
      `select id v from place_order($1::uuid, $2::uuid, 'https://t.me/x', $3::int, $4::uuid, $5::uuid, $6::uuid, round($7::numeric * $3::int / 1000, 4), $8)`,
      [user, service, quantity, offer.id, offer.provider_id, offer.provider_service_id, offer.cost_per_1000, `k-${++n}`])
    await db.query(`update orders set status = 'processing' where id = $1`, [id])
    await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [id, `P${n}`])
    return id
  }
  const complete = (id: string) => db.query(`update orders set status = 'completed' where id = $1`, [id])
  const partial = (id: string, remains: number) => db.query(`select apply_partial_refund($1::uuid, $2::int, 5)`, [id, remains])
  const refund = (id: string) => db.query(`select refund_order($1::uuid, null, 'test')`, [id])
  const entries = (u: string) => rows(`select transaction_type::text t, amount::text a, order_id, base_amount::text base, percentage::text pct from referral_ledger where user_id = $1 order by created_at, id`, [u])
  const bal = async (u: string) => (await call('referral_balance', u)) as { total: number | string; pending: number | string; available: number | string }
  const setRate = (pct: number, hold: number) => db.query(`update platform_settings set referral_reward_percentage = $1, referral_hold_days = $2 where id = 1`, [pct, hold])

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
    alice = await newUser()
    bob = await newUser({ funds: 1000 })
    carol = await newUser({ funds: 1000 })
    dave = await newUser({ funds: 1000 })
    banned = await newUser({ banned: true })

    const provider = await one<string>(`insert into providers(name, api_url) values ('P', 'https://p.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const mk = async (name: string, ext: string, cost: number, price: number) => {
      const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000000) returning id v`, [provider, ext, name, cost])
      return one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000000) returning id v`, [cat, name, ps, price])
    }
    svc = await mk('Views', '1', 2, 4) // price 4, cost 2: profit 2 per 1000
    svcTight = await mk('Tight', '2', 3.9, 4) // price 4, cost 3.9: profit 0.1 per 1000
  }, 180_000)

  describe('access and shape', () => {
    it('only the service role may execute the engine; the ledger is closed to clients', async () => {
      const fns = ['referral_balance(uuid)', 'reconcile_referral_rewards(integer)', 'apply_referral(uuid, text)', 'transfer_affiliate_balance_to_wallet(uuid, numeric, text)',
        'referral_summary(uuid, integer)', 'admin_set_referral_rate(uuid, numeric, uuid, integer)', 'grant_order_reward(uuid)', 'claw_back_order_reward(uuid)']
      for (const fn of fns) {
        const g = (await rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u`))[0]
        expect([g.a, g.u]).toEqual([false, false])
      }
      const t = (await rows(`select has_table_privilege('anon', 'referral_ledger', 'select') a, has_table_privilege('authenticated', 'referral_ledger', 'select') u,
                                    has_table_privilege('authenticated', 'referral_ledger', 'insert') w`))[0]
      expect([t.a, t.u, t.w]).toEqual([false, false, false])
    })

    it('every user has a unique, well-formed invite code', async () => {
      const codes = (await rows(`select referral_code c from users`)).map((r) => r.c as string)
      expect(new Set(codes).size).toBe(codes.length)
      for (const c of codes) expect(c).toMatch(/^[a-z0-9]{12}$/)
    })

    it('the ledger is append-only', async () => {
      const b = await newUser({ funds: 100 })
      await refer(b, alice)
      await complete(await order(b))
      const id = await one<string>(`select id v from referral_ledger limit 1`)
      await expect(db.query(`update referral_ledger set amount = 99 where id = $1`, [id])).rejects.toThrow(/append-only/)
      await expect(db.query(`delete from referral_ledger where id = $1`, [id])).rejects.toThrow(/append-only/)
      await expect(db.query(`truncate referral_ledger`)).rejects.toThrow(/append-only/)
    })
  })

  describe('attribution (anti-fraud)', () => {
    it('attaches a new user to the owner of the code, and applying it again is a no-op', async () => {
      const u = await newUser()
      expect(await refer(u, alice)).toMatchObject({ already_applied: false })
      expect(await one(`select referred_by v from users where id = $1`, [u])).toBe(alice)
      expect(await one(`select referred_at is not null v from users where id = $1`, [u])).toBe(true)
      expect(await refer(u, alice)).toMatchObject({ already_applied: true })
    })

    it('refuses your own code', async () => {
      const u = await newUser()
      await expect(refer(u, u)).rejects.toThrow(/self_referral/)
      await expect(db.query(`update users set referred_by = id where id = $1`, [u])).rejects.toThrow()
    })

    it('the referrer can never be changed or removed', async () => {
      const u = await newUser()
      await refer(u, alice)
      await expect(refer(u, carol)).rejects.toThrow(/already_referred/)
      await expect(db.query(`update users set referred_by = $2 where id = $1`, [u, carol])).rejects.toThrow(/referrer_locked/)
      await expect(db.query(`update users set referred_by = null where id = $1`, [u])).rejects.toThrow(/referrer_locked/)
      await expect(db.query(`update users set referral_code = 'abcdefabcdef' where id = $1`, [u])).rejects.toThrow(/cannot be changed/)
    })

    it('refuses a loop, direct (A <-> B) and long (A -> B -> C -> A)', async () => {
      const a = await newUser(), b = await newUser(), c = await newUser()
      await refer(b, a)
      await expect(refer(a, b)).rejects.toThrow(/circular_referral/)
      await refer(c, b)
      await expect(refer(a, c)).rejects.toThrow(/circular_referral/)
      await expect(db.query(`update users set referred_by = $2 where id = $1`, [a, c])).rejects.toThrow(/circular_referral/)
    })

    it('refuses unknown codes, banned users and referrers, and a referral after the first order', async () => {
      const u = await newUser()
      await expect(call('apply_referral', u, 'doesnotexist1')).rejects.toThrow(/referral_code_not_found/)
      await expect(call('apply_referral', u, "'; drop table users;--")).rejects.toThrow(/referral_code_not_found/)
      await expect(refer(u, banned)).rejects.toThrow(/referrer_unavailable/)
      await expect(refer(banned, alice)).rejects.toThrow(/referrer_unavailable/)

      const buyer = await newUser({ funds: 50 })
      await order(buyer)
      await expect(refer(buyer, alice)).rejects.toThrow(/referral_too_late/)
      expect(await one(`select referred_by is null v from users where id = $1`, [buyer])).toBe(true)
    })
  })

  describe('rewards', () => {
    it('completed: 5% of the final charge goes to the ledger once, with its basis recorded', async () => {
      await setRate(5, 7)
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, alice)
      const before = (await entries(alice)).length
      const o = await order(buyer) // charge 4.0000
      expect((await entries(alice)).length).toBe(before) // nothing until the provider delivers
      await complete(o)
      const e = (await entries(alice)).slice(before)
      expect(e).toEqual([{ t: 'reward', a: '0.2000', order_id: o, base: '4.0000', pct: '5.00' }])
      await expect(db.query(`select grant_order_reward($1::uuid)`, [o])).resolves.toBeTruthy()
      expect((await entries(alice)).length).toBe(before + 1) // asking again changes nothing
    })

    it('a user nobody referred earns nobody anything', async () => {
      const before = num(await one(`select count(*) v from referral_ledger`))
      await complete(await order(dave))
      expect(num(await one(`select count(*) v from referral_ledger`))).toBe(before)
    })

    it('partial: the reward follows the FINAL charge (charge - partial refund)', async () => {
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, alice)
      const o = await order(buyer)
      await partial(o, 400) // 40% undelivered: refund 1.6, final charge 2.4
      const e = (await rows(`select amount::text a, base_amount::text base from referral_ledger where order_id = $1`, [o]))
      expect(e).toEqual([{ a: '0.1200', base: '2.4000' }])
    })

    it('rounds to 1e-4 half away from zero', async () => {
      await setRate(1.25, 7)
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, alice)
      const o = await order(buyer, { quantity: 1 }) // charge 0.004; 1.25% = 0.00005 -> 0.0001
      await complete(o)
      expect(await one(`select amount::text v from referral_ledger where order_id = $1`, [o])).toBe('0.0001')
      await setRate(5, 7)
    })

    it('never pays more than the order earned', async () => {
      await setRate(50, 7) // 50% of 4 would be 2, but the profit is 0.1
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, alice)
      const o = await order(buyer, { service: svcTight })
      await complete(o)
      expect(await one(`select amount::text v from referral_ledger where order_id = $1`, [o])).toBe('0.1000')
      await setRate(5, 7)
    })

    it('a zero rate, and a per-referrer override', async () => {
      const buyer = await newUser({ funds: 100 })
      const ref = await newUser()
      await refer(buyer, ref)
      await setRate(0, 7)
      const o1 = await order(buyer)
      await complete(o1)
      expect(await entries(ref)).toEqual([])
      await setRate(5, 7)
      await db.query(`update users set referral_reward_percentage = 10 where id = $1`, [ref])
      const o2 = await order(buyer)
      await complete(o2)
      expect(await entries(ref)).toMatchObject([{ t: 'reward', a: '0.4000', pct: '10.00' }])
    })

    it('a canceled or failed order that never completed earns nothing', async () => {
      const buyer = await newUser({ funds: 100 })
      const ref = await newUser()
      await refer(buyer, ref)
      const o = await order(buyer)
      await db.query(`update orders set status = 'canceled' where id = $1`, [o])
      await refund(o)
      expect(await entries(ref)).toEqual([])
    })

    it('a reward failure never blocks the order (and the reconcile job repairs it)', async () => {
      const buyer = await newUser({ funds: 100 })
      const ref = await newUser()
      await refer(buyer, ref)
      const o = await order(buyer)
      await db.exec(`alter table referral_ledger add constraint force_fail check (false) not valid`)
      await complete(o) // must not throw
      await db.exec(`alter table referral_ledger drop constraint force_fail`)
      expect(await one(`select status::text v from orders where id = $1`, [o])).toBe('completed')
      expect(await entries(ref)).toEqual([])
      expect(await call('reconcile_referral_rewards')).toMatchObject({ rewards_created: expect.any(Number) })
      expect(await entries(ref)).toMatchObject([{ t: 'reward', a: '0.2000' }])
      expect(await call('reconcile_referral_rewards')).toMatchObject({ rewards_created: 0, clawbacks_created: 0 })
    })
  })

  describe('clawbacks', () => {
    it('a refunded order takes its reward back, once', async () => {
      const buyer = await newUser({ funds: 100 })
      const ref = await newUser()
      await refer(buyer, ref)
      const o = await order(buyer)
      await complete(o)
      await refund(o)
      expect(await entries(ref)).toMatchObject([{ t: 'reward', a: '0.2000' }, { t: 'clawback', a: '-0.2000' }])
      expect(num((await bal(ref)).total)).toBe(0)
      await expect(db.query(`select claw_back_order_reward($1::uuid)`, [o])).resolves.toBeTruthy()
      expect((await entries(ref)).length).toBe(2)
    })

    it('a partial order that is refunded afterwards takes back the (smaller) partial reward', async () => {
      const buyer = await newUser({ funds: 100 })
      const ref = await newUser()
      await refer(buyer, ref)
      const o = await order(buyer)
      await partial(o, 400)
      await refund(o) // the remaining 2.4 goes back too
      expect(await entries(ref)).toMatchObject([{ t: 'reward', a: '0.1200' }, { t: 'clawback', a: '-0.1200' }])
    })

    it('reconcile closes a clawback the hook missed', async () => {
      const buyer = await newUser({ funds: 100 })
      const ref = await newUser()
      await refer(buyer, ref)
      const o = await order(buyer)
      await complete(o)
      await db.exec(`alter table orders disable trigger trg_orders_referral`)
      await refund(o)
      await db.exec(`alter table orders enable trigger trg_orders_referral`)
      expect((await entries(ref)).length).toBe(1)
      expect(await call('reconcile_referral_rewards')).toMatchObject({ clawbacks_created: 1 })
      expect(await entries(ref)).toMatchObject([{ t: 'reward' }, { t: 'clawback', a: '-0.2000' }])
    })
  })

  describe('withdrawal to the wallet', () => {
    it('rewards are held for the hold period: nothing to withdraw yet', async () => {
      await setRate(5, 7)
      const ref = await newUser()
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, ref)
      await complete(await order(buyer))
      expect(await bal(ref)).toMatchObject({ total: 0.2, pending: 0.2, available: 0 })
      await expect(call('transfer_affiliate_balance_to_wallet', ref)).rejects.toThrow(/insufficient_affiliate_balance/)
    })

    it('moves cleared earnings into the wallet, partly or fully, and the ledger stays the truth', async () => {
      await setRate(5, 0)
      const ref = await newUser()
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, ref)
      await complete(await order(buyer))
      await complete(await order(buyer)) // 0.2 + 0.2
      expect(await bal(ref)).toMatchObject({ total: 0.4, pending: 0, available: 0.4 })

      const part = await call('transfer_affiliate_balance_to_wallet', ref, 0.15, 'part-key-0001')
      expect(part).toMatchObject({ transferred: 0.15, replayed: false })
      expect(await one(`select balance::text v from wallets where user_id = $1`, [ref])).toBe('0.1500')
      await expect(call('transfer_affiliate_balance_to_wallet', ref, 0.26)).rejects.toThrow(/insufficient_affiliate_balance/)
      const rest = await call('transfer_affiliate_balance_to_wallet', ref)
      expect(rest).toMatchObject({ transferred: 0.25 })
      expect(await one(`select balance::text v from wallets where user_id = $1`, [ref])).toBe('0.4000')
      expect(num((await bal(ref)).total)).toBe(0)
      await expect(call('transfer_affiliate_balance_to_wallet', ref)).rejects.toThrow(/insufficient_affiliate_balance/)

      // every transfer points at its wallet credit
      const linked = await rows(`select l.amount::text a, w.amount::text wa, w.type::text wt from referral_ledger l join wallet_transactions w on w.id = l.wallet_transaction_id where l.user_id = $1`, [ref])
      expect(linked).toEqual([{ a: '-0.1500', wa: '0.1500', wt: 'bonus' }, { a: '-0.2500', wa: '0.2500', wt: 'bonus' }])
    })

    it('a retry with the same key moves the money once', async () => {
      const ref = await newUser()
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, ref)
      await complete(await order(buyer))
      const first = await call('transfer_affiliate_balance_to_wallet', ref, 0.1, 'retry-key-0001')
      const again = await call('transfer_affiliate_balance_to_wallet', ref, 0.1, 'retry-key-0001')
      expect(first).toMatchObject({ replayed: false })
      expect(again).toMatchObject({ replayed: true, transferred: 0.1 })
      expect(await one(`select balance::text v from wallets where user_id = $1`, [ref])).toBe('0.1000')
      // the key cannot be borrowed by someone else
      await expect(call('transfer_affiliate_balance_to_wallet', alice, 0.01, 'retry-key-0001')).rejects.toThrow(/idempotency_conflict|insufficient_affiliate_balance/)
    })

    it('a clawback after a withdrawal leaves a negative balance that new rewards pay off; it cannot be withdrawn', async () => {
      const ref = await newUser()
      const buyer = await newUser({ funds: 100 })
      await refer(buyer, ref)
      const o = await order(buyer)
      await complete(o)
      await call('transfer_affiliate_balance_to_wallet', ref) // all 0.2
      await refund(o)
      expect(num((await bal(ref)).total)).toBe(-0.2)
      expect(num((await bal(ref)).available)).toBe(0)
      await expect(call('transfer_affiliate_balance_to_wallet', ref)).rejects.toThrow(/insufficient_affiliate_balance/)
      await complete(await order(buyer))
      expect(num((await bal(ref)).total)).toBe(0)
    })

    it('refuses a banned user, a bad amount and an unknown user', async () => {
      await expect(call('transfer_affiliate_balance_to_wallet', banned)).rejects.toThrow(/user_banned/)
      await expect(call('transfer_affiliate_balance_to_wallet', alice, 0)).rejects.toThrow(/invalid_parameter_value/)
      await expect(call('transfer_affiliate_balance_to_wallet', alice, -1)).rejects.toThrow(/invalid_parameter_value/)
      await expect(call('transfer_affiliate_balance_to_wallet', '00000000-0000-4000-8000-0000000000ff')).rejects.toThrow()
    })

    it('wallets stay equal to the sum of their ledgers after all of this', async () => {
      const bad = await rows(`select count(*)::int n from wallets w where w.balance <> (select coalesce(sum(amount), 0) from wallet_transactions t where t.wallet_id = w.id and t.status = 'completed')`)
      expect(bad[0].n).toBe(0)
    })
  })

  describe('summary and admin rate', () => {
    it('summary: code, rate, invitees, balance and recent entries', async () => {
      const s = (await call('referral_summary', alice, 5)) as Record<string, unknown>
      expect(s).toMatchObject({ code: await codeOf(alice), referred: false })
      expect(num(s.invitees)).toBeGreaterThan(0)
      expect((s.recent as unknown[]).length).toBeLessThanOrEqual(5)
    })

    it('admin_set_referral_rate: admins only, bounded, audited', async () => {
      await expect(call('admin_set_referral_rate', bob, 5)).rejects.toThrow(/forbidden/)
      await expect(call('admin_set_referral_rate', admin, 51)).rejects.toThrow(/between 0 and 50/)
      await expect(call('admin_set_referral_rate', admin, null)).rejects.toThrow(/nothing to update/)
      await call('admin_set_referral_rate', admin, 7.5, null, 3)
      expect((await rows(`select referral_reward_percentage::text p, referral_hold_days h from platform_settings`))[0]).toEqual({ p: '7.50', h: 3 })
      await call('admin_set_referral_rate', admin, 12, carol)
      expect(await one(`select referral_reward_percentage::text v from users where id = $1`, [carol])).toBe('12.00')
      await call('admin_set_referral_rate', admin, null, carol) // removes the override
      expect(await one(`select referral_reward_percentage is null v from users where id = $1`, [carol])).toBe(true)
      expect(num(await one(`select count(*) v from admin_audit_log where action = 'set_referral_rate'`))).toBe(3)
    })
  })
})
