// The absolute floor under every price per 1000 and the minimum order amount (migration 20270103000000): the bug of the owner's report (a volume
// step of a $0.12 card at $0.067) and the guards that keep it from coming back.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mapQuoteError } from '../supabase/functions/_shared/discounts.ts'
import { mapDbError } from '../supabase/functions/_shared/place-order-flow.ts'
import { calculateCustomerRate, DEFAULT_MIN_RATE } from '../supabase/functions/_shared/price-engine.ts'
import type { PriceRule } from '../supabase/functions/_shared/types.ts'
import { isBelowMinimumOrder, MIN_ORDER_AMOUNT, MIN_ORDER_UNITS, toUnits } from '../src/lib/order-calc'

const rule = (id: string, value: number, min_rate: number, max_rate: number | null, extra: Partial<PriceRule> = {}): PriceRule =>
  ({ id, type: 'tier', value, min_rate, max_rate, priority: 0, is_active: true, ...extra })
// the rules of production after the two-level catalogue: Standard x2.0 up to 1.00, with a floor of cost + 0.05 and no price floor in the second band
const STANDARD: PriceRule[] = [
  rule('s1', 100, 0, 0.0499, { min_markup: 0.1, min_price: 0.12 }),
  rule('s2', 100, 0.05, 0.9999, { min_markup: 0.05 }),
  rule('s3', 75, 1, 4.9999),
  rule('s4', 50, 5, null),
]

describe('the retail price (price engine)', () => {
  it('no price per 1000 is under $0.12, whatever the rules say', () => {
    expect(DEFAULT_MIN_RATE).toBe(0.12)
    expect(calculateCustomerRate(0.01, [])).toBe(0.12)
    expect(calculateCustomerRate(0.017, STANDARD)).toBe(0.12)
    expect(calculateCustomerRate(0.05, STANDARD)).toBe(0.12) // x2.0 would be 0.10: the second band had no floor of its own
    expect(calculateCustomerRate(0.055, STANDARD)).toBe(0.12)
    expect(calculateCustomerRate(0.06, STANDARD)).toBe(0.12)
    expect(calculateCustomerRate(0.07, STANDARD)).toBe(0.14) // above the floor nothing changes
    expect(calculateCustomerRate(1, STANDARD)).toBe(1.75)
  })
  it('a rule with a higher floor of its own keeps it; the floor can be set, also to nothing', () => {
    expect(calculateCustomerRate(0.01, [rule('r', 100, 0, null, { min_price: 0.5 })])).toBe(0.5)
    expect(calculateCustomerRate(0.01, [], {}, { minRate: 0 })).toBe(0.03) // cost + the 0.02 minimum margin
    expect(calculateCustomerRate(0.01, [], {}, { minRate: 0.3 })).toBe(0.3)
    expect(() => calculateCustomerRate(0.01, [], {}, { minRate: -1 })).toThrow(/minRate/)
  })
})

describe('the minimum order amount (the form)', () => {
  it('is ten cents; an order under it is blocked, one at it is not, an empty one is not an order at all', () => {
    expect(MIN_ORDER_AMOUNT).toBe(0.1)
    expect(MIN_ORDER_UNITS).toBe(toUnits(0.1))
    expect(isBelowMinimumOrder(toUnits(0.0999))).toBe(true)
    expect(isBelowMinimumOrder(toUnits(0.01))).toBe(true)
    expect(isBelowMinimumOrder(toUnits(0.1))).toBe(false)
    expect(isBelowMinimumOrder(toUnits(12))).toBe(false)
    expect(isBelowMinimumOrder(0)).toBe(false)
  })
})

describe('the answers of the server', () => {
  const message = 'min_order_amount: the minimum order amount is 0.1000'
  it('the quote and the order answer 400 min_order_amount with the amount the database holds', () => {
    expect(mapQuoteError(message)).toEqual({ status: 400, error: 'min_order_amount', message: 'The minimum order amount is $0.10.' })
    expect(mapDbError(message)).toMatchObject({ httpStatus: 400, error: 'min_order_amount', message: 'The minimum order amount is $0.10.' })
    expect(mapQuoteError('min_order_amount: the minimum order amount is 0.5000').message).toBe('The minimum order amount is $0.50.')
    expect(mapQuoteError('min_order_amount').message).toBe('The minimum order amount is $0.10.')
  })
})

const SVC = '00000000-0000-0000-0000-0000000000f2'
const P = '00000000-0000-0000-0000-0000000000a2'
const PS = '00000000-0000-0000-0000-0000000000b2'
const OFFER = '00000000-0000-0000-0000-0000000000d2'
const TIERS = [{ min: 0, margin: 0.8 }, { min: 1000, margin: 0.4 }, { min: 10000, margin: 0.25 }, { min: 100000, margin: 0.15 }]

describe('the volume steps (real SQL)', () => {
  let db: PGlite
  let u: string
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows
  const setCard = async (retail: number, cost: number) => {
    await db.query(`update services set customer_rate_per_1000 = $2, cost_basis_per_1000 = $3 where id = $1`, [SVC, retail, cost])
    await db.query(`update provider_service_offers set cost_per_1000 = $2 where id = $1`, [OFFER, cost])
  }
  const steps = async (retail: number) =>
    ((await q<{ r: Record<string, any> }>(`select quote_order_price($1::uuid, '${SVC}', 1000, null, 1, '${OFFER}', $2) r`, [u, retail]))[0].r.volume_rates as { min_quantity: number; rate_per_1000: number }[]).map((v) => Number(v.rate_per_1000))
  const rateAt = async (qty: number, retail: number) =>
    Number((await q<{ r: Record<string, any> }>(`select quote_order_price($1::uuid, '${SVC}', $2, null, 1, '${OFFER}', $3) r`, [u, qty, retail]))[0].r.rate_per_1000)

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers(id, name, api_url, routing_enabled, health_status, is_active, provider_balance, last_balance_sync) values ('${P}', 'P', 'https://p', true, 'healthy', true, 1000, now());
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c2', (select id from platforms where slug = 'telegram'), 'Views', 'views-floor');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('${PS}', '${P}', '1', 'x', 0.017, 10, 1000000);
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        values ('${SVC}', '00000000-0000-0000-0000-0000000000c2', 'Telegram Post Views', '${PS}', 0.12, 10, 1000000);
      delete from provider_service_offers;
      insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values ('${OFFER}', '${SVC}', '${P}', '${PS}', 0.017, 10, 1000000);`)
    await db.query(`update platform_settings set volume_margin_tiers = $1::jsonb where id = 1`, [JSON.stringify(TIERS)])
    u = (await q<{ id: string }>(`insert into users(telegram_id) values (2) returning id`))[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100,null,'fund','fund-2')`, [u])
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('the settings: a floor of $0.12 per 1000 and a minimum order of $0.10, and the engine\'s constant is the same number', async () => {
    const row = (await q(`select min_rate_per_1000::float8 f, min_order_charge::float8 m from platform_settings where id = 1`))[0]
    expect(row).toEqual({ f: 0.12, m: 0.1 })
    expect(row.f).toBe(DEFAULT_MIN_RATE)
  })

  it('REQUIRED: a card that costs $0.017 sells at $0.12 in EVERY step (it was $0.067 in the 1,000 and 10,000 steps)', async () => {
    await setCard(0.12, 0.017)
    expect(await steps(0.12)).toEqual([0.12, 0.12, 0.12, 0.12])
    for (const qty of [1000, 5000, 10_000, 50_000, 100_000, 1_000_000]) expect(await rateAt(qty, 0.12)).toBe(0.12)
  })

  it('a dearer card keeps its steps (the floor only catches what is under it), and the steps never go over the retail rate', async () => {
    await setCard(0.3, 0.1) // steps 0.20 / 0.1625 / 0.1375: the last is lifted by cost + 0.05 to 0.15, all above the floor
    expect(await steps(0.3)).toEqual([0.3, 0.2, 0.1625, 0.15])
    await setCard(0.1, 0.03) // a card sold under the floor on purpose is not lifted by its own steps: never above the retail rate
    expect(await steps(0.1)).toEqual([0.1, 0.1, 0.1, 0.1])
  })

  it('the floor is a setting: raise it and every step follows; a card with no known cost is floored too', async () => {
    await setCard(0.5, 0.2)
    await db.query(`update platform_settings set min_rate_per_1000 = 0.3 where id = 1`)
    try {
      expect((await steps(0.5)).every((r) => r >= 0.3)).toBe(true)
      expect((await q(`select volume_floor_rate(0.5, null, 1.35, 0.05)::float8 v`))[0].v).toBe(0.3)
    } finally {
      await db.query(`update platform_settings set min_rate_per_1000 = 0.12 where id = 1`)
    }
    expect((await q(`select volume_floor_rate(0.5, null, 1.35, 0.05)::float8 v`))[0].v).toBe(0.12)
    expect((await q(`select volume_floor_rate(0.12, 0.017, 1.35, 0.05)::float8 v`))[0].v).toBe(0.12)
  })

  it('the price ladder holds the same floor', async () => {
    const rows = (await q<{ r: { min_quantity: number; rate_per_1000: number }[] }>(`select price_ladder($1::jsonb) r`,
      [JSON.stringify([{ from: 10, to: 1000000, rate_per_1000: 0.12, basis_per_1000: 0.017 }])]))[0].r
    expect(rows.map((r) => Number(r.rate_per_1000))).toEqual([0.12, 0.12, 0.12, 0.12])
  })

  it('an order under ten cents is refused, at ten cents it goes through', async () => {
    await setCard(0.12, 0.017)
    await expect(q(`select quote_order_price($1::uuid, '${SVC}', 800, null, 1, '${OFFER}', 0.12)`, [u])).rejects.toThrow(/min_order_amount/) // 0.096
    const ok = (await q<{ r: Record<string, any> }>(`select quote_order_price($1::uuid, '${SVC}', 834, null, 1, '${OFFER}', 0.12) r`, [u]))[0].r
    expect(Number(ok.final_price)).toBeGreaterThanOrEqual(0.1)
  })
})
