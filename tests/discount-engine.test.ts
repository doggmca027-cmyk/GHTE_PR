import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { mapQuoteError, parseQuoteBody, toQuoteDto } from '../supabase/functions/_shared/discounts.ts'
import { mapDbError } from '../supabase/functions/_shared/place-order-flow.ts'
import { parsePlaceOrderBody } from '../supabase/functions/_shared/order-validation.ts'

const SVC = '00000000-0000-4000-8000-0000000000aa'

describe('request parsing', () => {
  it('quote-order: validates ids, quantity and the promo code', () => {
    expect(parseQuoteBody(null)).toMatchObject({ ok: false })
    expect(parseQuoteBody({ serviceId: 'x', quantity: 5 })).toMatchObject({ ok: false })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 0 })).toMatchObject({ ok: false })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 1.5 })).toMatchObject({ ok: false })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 100, promoCode: "x'; drop--" })).toMatchObject({ ok: false })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 100 })).toEqual({ ok: true, value: { serviceId: SVC, quantity: 100, promoCode: null } })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 100, promoCode: ' summer-10 ' })).toEqual({ ok: true, value: { serviceId: SVC, quantity: 100, promoCode: 'SUMMER-10' } })
  })

  it('place-order: promoCode is optional, upper-cased and validated; prices in the body are still ignored', () => {
    const base = { serviceId: SVC, targetUrl: 'https://t.me/channel', quantity: 100 }
    expect(parsePlaceOrderBody({ ...base, promoCode: 'summer-10', price: 0.0001, discount: 99 })).toMatchObject({ ok: true, value: { promoCode: 'SUMMER-10' } })
    expect(parsePlaceOrderBody(base)).toMatchObject({ ok: true })
    expect((parsePlaceOrderBody(base) as unknown as { value: Record<string, unknown> }).value).not.toHaveProperty('promoCode')
    expect(parsePlaceOrderBody({ ...base, promoCode: 'no' })).toMatchObject({ ok: false })
    expect(parsePlaceOrderBody({ ...base, promoCode: 12345 })).toMatchObject({ ok: false })
  })
})

describe('error mapping', () => {
  it('promo and margin errors become clear answers; the loss guard hides its numbers', () => {
    expect(mapDbError('promo_not_found: x').httpStatus).toBe(404)
    expect(mapDbError('promo_expired: x').error).toBe('promo_expired')
    expect(mapDbError('promo_inactive: x').error).toBe('promo_expired')
    expect(mapDbError('promo_exhausted: x').error).toBe('promo_exhausted')
    expect(mapDbError('promo_already_used: x').error).toBe('promo_already_used')
    expect(mapDbError('promo_not_applicable: x').error).toBe('promo_not_applicable')
    const loss = mapDbError('below_cost: the price 1.0000 would be under the provider cost 2.0000')
    expect(loss).toMatchObject({ httpStatus: 503, error: 'service_unavailable' })
    expect(JSON.stringify(loss)).not.toMatch(/2\.0000|1\.0000/)
    expect(mapQuoteError('promo_exhausted: x').status).toBe(409)
    expect(mapQuoteError('below_cost: x').status).toBe(503)
    expect(mapQuoteError('connection refused 10.0.0.1').status).toBe(500)
  })

  it('the quote shows the customer prices only, never cost or the floor', () => {
    const dto = toQuoteDto({ list_price: '4.0000', tier_slug: 'silver', tier_percentage: '2.00', tier_discount: '0.08', promo_discount: '0.392', final_price: '3.528',
      floor_price: '2.01', provider_cost: '2', capped: false })
    expect(dto).toEqual({ listPrice: 4, tier: { slug: 'silver', percentage: 2, discount: 0.08 }, promo: { applied: true, discount: 0.392 }, finalPrice: 3.528, totalDiscount: 0.472, discountReduced: false })
    expect(JSON.stringify(dto)).not.toMatch(/floor|cost/i)
  })
})

// ---------------------------------------------------------------------------
// The engine, against the real migrations
// ---------------------------------------------------------------------------
describe('discount engine (SQL)', () => {
  let db: PGlite
  let admin: string
  let svc: string, svcTight: string, svcThin: string, svcLoss: string, provider: string
  let n = 0

  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const num = (v: unknown) => Number(v)
  const tierId = (slug: string) => one<string>(`select id v from user_tiers where slug = $1`, [slug])
  const newUser = async (opts: { tier?: string; funds?: number; admin?: boolean } = {}) => {
    const id = await one<string>(`insert into users(telegram_id, is_admin) values ($1, $2) returning id v`, [5000 + ++n, opts.admin ?? false])
    if (opts.tier) await db.query(`update users set tier_id = $2 where id = $1`, [id, await tierId(opts.tier)])
    if (opts.funds !== 0) await db.query(`select process_wallet_transaction($1::uuid, 'deposit', $2::numeric, null, 'fund', $3)`, [id, opts.funds ?? 10_000, `fund-${id}`])
    return id
  }
  const promo = (code: string, type: 'percentage' | 'fixed', value: number, o: { max?: number | null; expires?: string | null; active?: boolean } = {}) =>
    db.query(`select admin_upsert_promo_code($1::uuid, $2, $3::promo_discount_type, $4::numeric, $5::int, $6::timestamptz, $7::boolean)`,
      [admin, code, type, value, o.max ?? null, o.expires ?? null, o.active ?? true])
  const place = async (user: string, o: { service?: string; qty?: number; promo?: string | null; key?: string } = {}) => {
    const service = o.service ?? svc
    const offer = (await rows(`select id, provider_id, provider_service_id, cost_per_1000 from provider_service_offers where service_id = $1`, [service]))[0]
    const qty = o.qty ?? 1000
    return (await db.query<Record<string, string>>(
      `select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', $3::int, $4::uuid, $5::uuid, $6::uuid, round($7::numeric * $3::int / 1000, 4), $8, $9)`,
      [user, service, qty, offer.id, offer.provider_id, offer.provider_service_id, offer.cost_per_1000, o.key ?? `k-${++n}`, o.promo ?? null])).rows[0]
  }
  const quote = async (user: string, o: { service?: string; qty?: number; promo?: string | null } = {}) =>
    (await db.query<{ q: Record<string, unknown> }>(`select quote_order_price($1::uuid, $2::uuid, $3::int, $4) q`, [user, o.service ?? svc, o.qty ?? 1000, o.promo ?? null])).rows[0].q
  const wallet = async (u: string) => num(await one(`select balance::text v from wallets where user_id = $1`, [u]))

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))

    admin = await newUser({ admin: true, funds: 0 })
    provider = await one<string>(`insert into providers(name, api_url) values ('P', 'https://p.invalid') returning id v`)
    await db.query(`update providers set routing_enabled = true, health_status = 'healthy' where id = $1`, [provider])
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const mk = async (name: string, ext: string, cost: number, price: number) => {
      const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000000) returning id v`, [provider, ext, name, cost])
      return one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000000) returning id v`, [cat, name, ps, price])
    }
    svc = await mk('Views', '1', 2, 4)         // price 4, cost 2, floor 2.01 -> 1.99 of room per 1000
    svcTight = await mk('Tight', '2', 3.9, 4)  // room 0.09 per 1000
    svcThin = await mk('Thin', '3', 2, 2.005)  // price barely above cost: no room at all
    svcLoss = await mk('Loss', '4', 2, 1)      // list price below cost
  }, 180_000)

  describe('access and shape', () => {
    it('only the service role may execute the engine; the tables are closed to clients', async () => {
      for (const fn of ['place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text)', 'calculate_order_price(uuid, uuid, integer, numeric, text)',
        'quote_order_price(uuid, uuid, integer, text)', 'recalculate_user_tiers()', 'admin_upsert_promo_code(uuid, text, promo_discount_type, numeric, integer, timestamptz, boolean)']) {
        const g = (await rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u`))[0]
        expect([g.a, g.u]).toEqual([false, false])
      }
      for (const t of ['user_tiers', 'promo_codes', 'promo_code_redemptions']) {
        const g = (await rows(`select has_table_privilege('anon', '${t}', 'select') a, has_table_privilege('authenticated', '${t}', 'select') u, has_table_privilege('authenticated', '${t}', 'insert') w`))[0]
        expect([g.a, g.u, g.w]).toEqual([false, false, false])
      }
    })

    it('the four tiers are seeded and every user, new ones too, starts at Bronze', async () => {
      expect(await rows(`select slug, discount_percentage::text p, min_monthly_spend::text s from user_tiers order by sort_order`)).toEqual([
        { slug: 'bronze', p: '0.00', s: '0.0000' }, { slug: 'silver', p: '2.00', s: '100.0000' }, { slug: 'gold', p: '4.00', s: '500.0000' }, { slug: 'vip', p: '6.00', s: '2000.0000' }])
      expect(num(await one(`select count(*) v from users where tier_id is null`))).toBe(0)
      expect(await one(`select t.slug v from users u join user_tiers t on t.id = u.tier_id where u.id = $1`, [admin])).toBe('bronze')
    })

    it('promo codes: upper-case, bounded, unique', async () => {
      await expect(db.query(`insert into promo_codes(code, discount_type, discount_value) values ('lower', 'fixed', 1)`)).rejects.toThrow()
      await expect(db.query(`insert into promo_codes(code, discount_type, discount_value) values ('TOOBIG', 'percentage', 91)`)).rejects.toThrow()
      await expect(db.query(`insert into promo_codes(code, discount_type, discount_value) values ('ZERO', 'fixed', 0)`)).rejects.toThrow()
    })
  })

  describe('the order of operations: list -> tier -> promo', () => {
    it('no tier discount, no promo: the list price', async () => {
      const u = await newUser({ tier: 'bronze' })
      const o = await place(u)
      expect(o).toMatchObject({ charge_amount: '4.0000', list_price_amount: '4.0000', tier_discount_amount: '0.0000', promo_discount_amount: '0.0000', discount_capped: false, profit_amount: '2.0000' })
    })

    it('tier first: Silver takes 2% of the list price', async () => {
      const u = await newUser({ tier: 'silver' })
      expect(await place(u)).toMatchObject({ charge_amount: '3.9200', tier_discount_amount: '0.0800' })
    })

    it('a percentage promo is taken from the price AFTER the tier discount (4.00 - 2% = 3.92; 10% of 3.92 = 0.392)', async () => {
      await promo('TEN', 'percentage', 10)
      const u = await newUser({ tier: 'silver' })
      expect(await place(u, { promo: 'ten' })).toMatchObject({ charge_amount: '3.5280', tier_discount_amount: '0.0800', promo_discount_amount: '0.3920', discount_capped: false })
    })

    it('a fixed promo comes off after the tier too, and never exceeds the price', async () => {
      await promo('ONEOFF', 'fixed', 1)
      const u = await newUser({ tier: 'gold' })
      expect(await place(u, { promo: 'ONEOFF' })).toMatchObject({ charge_amount: '2.8400', tier_discount_amount: '0.1600', promo_discount_amount: '1.0000' })
    })

    it('rounds each step to 1e-4, half away from zero', async () => {
      const u = await newUser({ tier: 'silver' })
      // list 0.004; 2% = 0.00008 -> 0.0001; final 0.0039
      expect(await place(u, { qty: 1 })).toMatchObject({ list_price_amount: '0.0040', tier_discount_amount: '0.0001', charge_amount: '0.0039' })
    })

    it('the quote is exactly what place_order then charges', async () => {
      const u = await newUser({ tier: 'vip' })
      await promo('QUOTE15', 'percentage', 15)
      const q = await quote(u, { promo: 'QUOTE15' })
      const before = await wallet(u)
      const o = await place(u, { promo: 'QUOTE15' })
      expect(num(q.final_price)).toBe(num(o.charge_amount))
      expect(Math.round((before - (await wallet(u))) * 10_000) / 10_000).toBe(num(o.charge_amount))
    })
  })

  describe('selling at a loss is impossible', () => {
    it('stacked discounts are capped at cost + minimum margin: the tier is served first, the promo gets what is left', async () => {
      await promo('BIG3', 'fixed', 3)
      const u = await newUser({ tier: 'vip' }) // 6% = 0.24
      const o = await place(u, { promo: 'BIG3' })
      // room = 4 - (2 + 0.01) = 1.99; wanted 0.24 + 3 = 3.24 -> tier 0.24, promo 1.75, final = the floor 2.01
      expect(o).toMatchObject({ charge_amount: '2.0100', tier_discount_amount: '0.2400', promo_discount_amount: '1.7500', discount_capped: true, profit_amount: '0.0100' })
    })

    it('a tier discount alone is capped on a thin-margin service', async () => {
      const u = await newUser({ tier: 'vip' })
      // price 4, cost 3.9, floor 3.91: room 0.09 although 6% would be 0.24
      expect(await place(u, { service: svcTight })).toMatchObject({ charge_amount: '3.9100', tier_discount_amount: '0.0900', discount_capped: true, profit_amount: '0.0100' })
    })

    it('a 90% promo cannot push the price under the floor either', async () => {
      await promo('HALFOFF', 'percentage', 90)
      const u = await newUser({ tier: 'bronze' })
      const o = await place(u, { promo: 'HALFOFF' })
      expect(num(o.charge_amount)).toBeGreaterThanOrEqual(2.01)
      expect(o.discount_capped).toBe(true)
    })

    it('a service whose price has no room refuses a promo (nothing is charged, nothing is redeemed)', async () => {
      await promo('NOROOM', 'percentage', 10)
      const u = await newUser({ tier: 'bronze' })
      const before = await wallet(u)
      await expect(place(u, { service: svcThin, promo: 'NOROOM' })).rejects.toThrow(/promo_not_applicable/)
      expect(await wallet(u)).toBe(before)
      expect(num(await one(`select current_uses v from promo_codes where code = 'NOROOM'`))).toBe(0)
      // without the promo the order simply goes through at the list price
      expect(await place(u, { service: svcThin })).toMatchObject({ charge_amount: '2.0050', discount_capped: false })
    })

    it('a list price below the provider cost is refused outright', async () => {
      const u = await newUser({ tier: 'bronze' })
      const before = await wallet(u)
      await expect(place(u, { service: svcLoss })).rejects.toThrow(/below_cost/)
      expect(await wallet(u)).toBe(before)
    })

    it('whatever the combination, no order is ever priced under its cost', async () => {
      await promo('ANY', 'percentage', 60)
      for (const tier of ['bronze', 'silver', 'gold', 'vip']) {
        for (const service of [svc, svcTight]) {
          for (const withPromo of [false, true]) {
            const u = await newUser({ tier })
            try {
              const o = await place(u, { service, promo: withPromo ? 'ANY' : null, qty: 7 })
              expect(num(o.charge_amount)).toBeGreaterThanOrEqual(num(o.cost_amount))
            } catch (e) {
              expect(String(e)).toMatch(/promo_not_applicable|promo_already_used/)
            }
          }
        }
      }
      expect(num(await one(`select count(*) v from orders where list_price_amount is not null and charge_amount < cost_amount`))).toBe(0)
    })

    it('the database constraint is the last line: a row priced by the engine cannot be under cost', async () => {
      const u = await newUser()
      await expect(db.query(
        `insert into orders(user_id, service_id, target_url, quantity, charge_amount, cost_amount, list_price_amount) values ($1, $2, 'https://t.me/x', 10, 1, 2, 4)`, [u, svc])).rejects.toThrow(/orders_not_below_cost/)
    })

    it('the engine reads the price and cost under share locks, and the promo under an exclusive one (the SQL says so)', async () => {
      const def = await one<string>(`select pg_get_functiondef('place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text)'::regprocedure) v`)
      expect(def).toMatch(/from services where id = p_service_id and is_active for share/)
      expect(def).toMatch(/is_active for share;/)
      expect(def).toMatch(/from promo_codes where code = v_code for update/)
    })
  })

  describe('promo codes', () => {
    it('unknown, inactive, expired, exhausted and already-used codes are refused with a clear reason and no charge', async () => {
      await promo('OFF', 'fixed', 1, { active: false })
      await promo('OLD', 'fixed', 1, { expires: '2020-01-01T00:00:00Z' })
      await promo('ONCE', 'fixed', 0.5, { max: 1 })
      const first = await newUser(), second = await newUser()
      const before = await wallet(second)
      await expect(place(second, { promo: 'NOPE' })).rejects.toThrow(/promo_not_found/)
      await expect(place(second, { promo: 'OFF' })).rejects.toThrow(/promo_inactive/)
      await expect(place(second, { promo: 'OLD' })).rejects.toThrow(/promo_expired/)
      await place(first, { promo: 'ONCE' })
      await expect(place(second, { promo: 'ONCE' })).rejects.toThrow(/promo_exhausted/)
      expect(await wallet(second)).toBe(before)
      await expect(place(first, { promo: 'ONCE' })).rejects.toThrow(/promo_exhausted|promo_already_used/)
    })

    it('one use per user, even for an unlimited code; the use is counted and linked to the order', async () => {
      await promo('PERUSER', 'fixed', 0.25)
      const u = await newUser()
      const o = await place(u, { promo: 'PERUSER' })
      await expect(place(u, { promo: 'PERUSER' })).rejects.toThrow(/promo_already_used/)
      expect(num(await one(`select current_uses v from promo_codes where code = 'PERUSER'`))).toBe(1)
      expect(await rows(`select order_id, discount_amount::text d from promo_code_redemptions where user_id = $1`, [u])).toEqual([{ order_id: o.id, d: '0.2500' }])
      // another user can still use it
      await place(await newUser(), { promo: 'PERUSER' })
      expect(num(await one(`select current_uses v from promo_codes where code = 'PERUSER'`))).toBe(2)
    })

    it('a retry of the same order (idempotency key) neither charges nor redeems twice', async () => {
      await promo('RETRY', 'fixed', 0.5)
      const u = await newUser()
      const a = await place(u, { promo: 'RETRY', key: 'retry-key-0001' })
      const before = await wallet(u)
      const b = await place(u, { promo: 'RETRY', key: 'retry-key-0001' })
      expect(b.id).toBe(a.id)
      expect(await wallet(u)).toBe(before)
      expect(num(await one(`select current_uses v from promo_codes where code = 'RETRY'`))).toBe(1)
    })

    it('an order the provider side refuses before sending (rolled back) does not use up the code', async () => {
      await promo('ROLLBACK', 'fixed', 0.5, { max: 1 })
      await db.query(`update providers set provider_balance = 0.5, last_balance_sync = now() where id = $1`, [provider])
      const u = await newUser()
      await expect(place(u, { promo: 'ROLLBACK' })).rejects.toThrow(/insufficient_provider_balance/)
      expect(num(await one(`select current_uses v from promo_codes where code = 'ROLLBACK'`))).toBe(0)
      await db.query(`update providers set provider_balance = 100000 where id = $1`, [provider])
      await place(u, { promo: 'ROLLBACK' })
      expect(num(await one(`select current_uses v from promo_codes where code = 'ROLLBACK'`))).toBe(1)
    })

    it('redemptions are append-only', async () => {
      await expect(db.query(`update promo_code_redemptions set discount_amount = 9`)).rejects.toThrow(/append-only/)
      await expect(db.query(`delete from promo_code_redemptions`)).rejects.toThrow(/append-only/)
    })

    it('admin_upsert_promo_code: admins only, normalises the code, updates in place, audited', async () => {
      const user = await newUser()
      await expect(db.query(`select admin_upsert_promo_code($1::uuid, 'HACK', 'fixed', 1)`, [user])).rejects.toThrow(/forbidden/)
      await expect(promo('x', 'fixed', 1)).rejects.toThrow(/3 to 32/)
      await expect(promo('GOOD1', 'percentage', 91)).rejects.toThrow(/\(0, 90\]/)
      const r = (await promo(' spring25 ', 'percentage', 25, { max: 100 })).rows[0] as { admin_upsert_promo_code: Record<string, unknown> }
      expect(r.admin_upsert_promo_code).toMatchObject({ code: 'SPRING25', discount_type: 'percentage', max_uses: 100 })
      await promo('SPRING25', 'percentage', 30, { max: 100 })
      expect(await one(`select discount_value::text v from promo_codes where code = 'SPRING25'`)).toBe('30.0000')
      expect(num(await one(`select count(*) v from admin_audit_log where action = 'upsert_promo_code'`))).toBeGreaterThanOrEqual(2)
    })
  })

  describe('tiers follow the last 30 days of spend', () => {
    const spend = async (u: string, usd: number) => {
      // 4 per 1000: quantity for the requested charge on a bronze (undiscounted) price
      const o = await place(u, { qty: Math.round(usd / 4 * 1000) })
      await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
      await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [o.id, `T${++n}`])
      await db.query(`update orders set status = 'completed' where id = $1`, [o.id])
      return o.id
    }
    const tierOf = (u: string) => one<string>(`select t.slug v from users x join user_tiers t on t.id = x.tier_id where x.id = $1`, [u])

    it('upgrades on spend, counts refunds out, and downgrades when the spend leaves the 30-day window', async () => {
      const u = await newUser({ tier: 'bronze', funds: 100_000 })
      await db.query(`select recalculate_user_tiers()`)
      expect(await tierOf(u)).toBe('bronze')

      await spend(u, 120)
      expect((await db.query(`select recalculate_user_tiers() r`)).rows[0]).toMatchObject({ r: { upgraded: expect.any(Number) } })
      expect(await tierOf(u)).toBe('silver')

      const big = await spend(u, 600) // silver now: the order is discounted, still comfortably above Gold in total
      await db.query(`select recalculate_user_tiers()`)
      expect(await tierOf(u)).toBe('gold')

      // a refunded order stops counting
      await db.query(`select refund_order($1::uuid, null, 'test')`, [big])
      await db.query(`select recalculate_user_tiers()`)
      expect(await tierOf(u)).toBe('silver')

      // spend older than 30 days stops counting
      await db.query(`update orders set created_at = now() - interval '31 days' where user_id = $1`, [u])
      const r = (await db.query<{ r: Record<string, number> }>(`select recalculate_user_tiers() r`)).rows[0].r
      expect(await tierOf(u)).toBe('bronze')
      expect(r.downgraded).toBeGreaterThanOrEqual(1)
    })

    it('is idempotent: a second run changes nothing', async () => {
      await db.query(`select recalculate_user_tiers()`)
      const r = (await db.query<{ r: Record<string, number> }>(`select recalculate_user_tiers() r`)).rows[0].r
      expect(r.changed).toBe(0)
    })

    it('partial orders count by what was actually kept', async () => {
      const u = await newUser({ tier: 'bronze', funds: 100_000 })
      const o = await place(u, { qty: 50_000 }) // charge 200
      await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
      await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [o.id, `T${++n}`])
      await db.query(`select apply_partial_refund($1::uuid, 25000, 1)`, [o.id]) // half delivered: 100 kept
      await db.query(`select recalculate_user_tiers()`)
      expect(await tierOf(u)).toBe('silver') // 100 reaches Silver exactly
    })

    it('pending orders do not count', async () => {
      const u = await newUser({ tier: 'bronze', funds: 100_000 })
      await place(u, { qty: 100_000 }) // paid, not completed
      await db.query(`select recalculate_user_tiers()`)
      expect(await tierOf(u)).toBe('bronze')
    })
  })

  describe('the rest of the system sees the discounted price', () => {
    it('a referral reward is computed from what the customer actually paid', async () => {
      const referrer = await newUser({ funds: 0 })
      const buyer = await newUser({ tier: 'silver' })
      const code = await one<string>(`select referral_code v from users where id = $1`, [referrer])
      await db.query(`select apply_referral($1::uuid, $2)`, [buyer, code])
      await db.query(`update platform_settings set referral_reward_percentage = 5, referral_hold_days = 0 where id = 1`)
      const o = await place(buyer)
      await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
      await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [o.id, `T${++n}`])
      await db.query(`update orders set status = 'completed' where id = $1`, [o.id])
      expect(await rows(`select base_amount::text base, amount::text a from referral_ledger where order_id = $1`, [o.id])).toEqual([{ base: '3.9200', a: '0.1960' }])
    })

    it('the admin pricing grid shows how much discount each service can carry', async () => {
      await db.query(`select set_config('request.jwt.sub', $1, false)`, [admin])
      const view = (await db.query<{ v: Array<Record<string, unknown>> }>(`select get_admin_pricing_view() v`)).rows[0].v
      const byName = Object.fromEntries(view.map((r) => [r.name as string, r.max_discount_percent]))
      expect(byName.Views).toBe(49.75)   // (4 - 2 - 0.01) / 4
      expect(byName.Tight).toBe(2.25)    // (4 - 3.9 - 0.01) / 4
      expect(byName.Thin).toBe(0)
      await db.query(`select set_config('request.jwt.sub', '', false)`)
    })
  })
})
