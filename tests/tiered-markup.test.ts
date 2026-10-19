// The owner's tiered markup (2026-10-19), the minimum order charge and the floor under the volume steps (migration 20261222000000):
//   cost < 0.05: max(cost x 5, cost + 0.10, 0.12) · < 0.50: max(cost x 3, cost + 0.12) · < 5: max(cost x 2, cost + 0.30) · else cost x 1.6
// as four tier rules with the new rule minimums; no order under $0.01; a volume step never under cost x 1.35 nor cost + 0.05 per 1000.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { calculateCustomerRate } from '../supabase/functions/_shared/price-engine.ts'
import type { PriceRule } from '../supabase/functions/_shared/types.ts'

/** The four rules entered on production. */
export const TIERED_RULES: PriceRule[] = [
  { id: 't1', type: 'tier', value: 400, min_rate: 0, max_rate: 0.0499, min_markup: 0.1, min_price: 0.12, priority: 0, is_active: true },
  { id: 't2', type: 'tier', value: 200, min_rate: 0.05, max_rate: 0.4999, min_markup: 0.12, priority: 0, is_active: true },
  { id: 't3', type: 'tier', value: 100, min_rate: 0.5, max_rate: 4.9999, min_markup: 0.3, priority: 0, is_active: true },
  { id: 't4', type: 'tier', value: 60, min_rate: 5, max_rate: null, priority: 0, is_active: true },
]
const rate = (cost: number) => calculateCustomerRate(cost, TIERED_RULES)

describe('the tiered markup (price engine)', () => {
  it('REQUIRED: each tier with its minimums, at every boundary', () => {
    expect(rate(0.006)).toBe(0.12) // max(0.03, 0.106, 0.12): the $0.12 minimum
    expect(rate(0.03)).toBe(0.15) // max(0.15, 0.13, 0.12)
    expect(rate(0.0499)).toBe(0.2495)
    expect(rate(0.05)).toBe(0.17) // max(0.15, 0.17): cost + 0.12
    expect(rate(0.3)).toBe(0.9)
    expect(rate(0.4999)).toBe(1.4997)
    expect(rate(0.5)).toBe(1) // max(1.00, 0.80)
    expect(rate(0.2)).toBe(0.6)
    expect(rate(0.25)).toBe(0.75)
    expect(rate(4.9999)).toBe(9.9998)
    expect(rate(5)).toBe(8) // x1.6
    expect(rate(41.75)).toBe(66.8)
  })

  it('the minimums of a rule: min_markup (cost + it) and min_price (at least it), the highest wins', () => {
    const r = (o: Partial<PriceRule>): PriceRule[] => [{ id: 'r', type: 'percentage', value: 10, priority: 0, is_active: true, ...o }]
    expect(calculateCustomerRate(1, r({ min_markup: 0.5 }))).toBe(1.5)
    expect(calculateCustomerRate(1, r({ min_price: 3 }))).toBe(3)
    expect(calculateCustomerRate(1, r({ min_markup: 0.05 }))).toBe(1.1) // the markup is already more
    expect(calculateCustomerRate(1, r({ min_markup: null, min_price: null }))).toBe(1.1)
    expect(() => calculateCustomerRate(1, r({ min_price: -1 }))).toThrow(/invalid min_price/)
  })
})

const SVC = '00000000-0000-0000-0000-0000000000f1'
const P = '00000000-0000-0000-0000-0000000000a1'
const PS = '00000000-0000-0000-0000-0000000000b1'
const OFFER = '00000000-0000-0000-0000-0000000000d1'
const TIERS = [{ min: 0, margin: 0.8 }, { min: 1000, margin: 0.4 }, { min: 10000, margin: 0.25 }, { min: 100000, margin: 0.15 }]

describe('the minimum order charge and the volume floor (real SQL)', () => {
  let db: PGlite
  let u: string
  let n = 0
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows
  const setCard = (cost: number) => db.query(`update services set customer_rate_per_1000 = $2, cost_basis_per_1000 = $3 where id = $1`, [SVC, rate(cost), cost])
    .then(() => db.query(`update provider_service_offers set cost_per_1000 = $2 where id = $1`, [OFFER, cost]))
  const quote = async (qty: number, cost: number) =>
    (await q<{ r: Record<string, any> }>(`select quote_order_price($1::uuid, '${SVC}', $2, null, 1, '${OFFER}', $3) r`, [u, qty, rate(cost)]))[0].r

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
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', (select id from platforms where slug = 'telegram'), 'Views', 'views');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('${PS}', '${P}', '1', 'x', 0.006, 10, 1000000);
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        values ('${SVC}', '00000000-0000-0000-0000-0000000000c1', 'Telegram Post Views', '${PS}', 0.12, 10, 1000000);
      delete from provider_service_offers;
      insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values ('${OFFER}', '${SVC}', '${P}', '${PS}', 0.006, 10, 1000000);`)
    await db.query(`update platform_settings set volume_margin_tiers = $1::jsonb where id = 1`, [JSON.stringify(TIERS)])
    u = (await q<{ id: string }>(`insert into users(telegram_id) values (1) returning id`))[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100,null,'fund','fund-1')`, [u])
  }, 180_000)

  it('the defaults: one cent, x1.35, + $0.05', async () => {
    expect((await q(`select min_order_charge::float8 m, volume_floor_multiplier::float8 k, volume_floor_markup::float8 a from platform_settings where id = 1`))[0]).toEqual({ m: 0.01, k: 1.35, a: 0.05 })
  })

  it('REQUIRED: 10 views of a $0.006 service cost exactly $0.01 (not $0.0003), in the quote and in the charge, with the profit', async () => {
    await setCard(0.006)
    const quoted = await quote(10, 0.006)
    expect(quoted).toMatchObject({ list_price: 0.01, final_price: 0.01, rate_per_1000: 0.12 })
    const [order] = await q(`select * from place_order($1::uuid, '${SVC}', 'https://t.me/x', 10, '${OFFER}', '${P}', '${PS}', 0.0001, $2, null, false, 1, 0, '${OFFER}', $3)`, [u, `k${++n}`, rate(0.006)])
    expect(Number(order.charge_amount)).toBe(0.01)
    expect(Number(order.profit_amount)).toBe(0.0099)
  })

  it('a discount never takes an order under the minimum charge', async () => {
    await setCard(0.006)
    await db.query(`insert into user_tiers(slug, name, min_spent, discount_percentage, is_active) values ('vip-test', 'VIP', 0, 50, true) on conflict do nothing`).catch(() => undefined)
    const tier = (await q<{ id: string }>(`select id from user_tiers where discount_percentage > 0 and is_active order by discount_percentage desc limit 1`))[0]
    if (tier) await db.query(`update users set tier_id = $2 where id = $1`, [u, tier.id])
    const quoted = await quote(50, 0.006) // 50 x 0.12 / 1000 = 0.006 -> lifted to 0.01; a tier discount cannot go below it
    expect(Number(quoted.final_price)).toBe(0.01)
    await db.query(`update users set tier_id = null where id = $1`, [u])
  })

  it('above one cent the price is the rate times the quantity, as before', async () => {
    await setCard(0.006)
    expect(await quote(500, 0.006)).toMatchObject({ list_price: 0.06, final_price: 0.06 })
  })

  it('REQUIRED: a volume step never goes under cost x 1.35 nor cost + $0.05 per 1000, nor above the retail rate', async () => {
    await setCard(5) // x1.6 = 8.00; the 10 000 step would be 5 x (1 + 0.6 x 0.25 / 0.8) = 5.9375 -> floor 5 x 1.35 = 6.75
    expect(await quote(10_000, 5)).toMatchObject({ rate_per_1000: 6.75, list_price: 67.5 })
    expect((await quote(500, 5)).volume_rates.map((v: { rate_per_1000: number }) => Number(v.rate_per_1000))).toEqual([8, 6.75, 6.75, 6.75])
    await setCard(0.1) // x3 = 0.30; steps 0.20 / 0.1625 / 0.1375, the last one lifted to the floor max(0.135, 0.15) = 0.15
    expect((await quote(500, 0.1)).volume_rates.map((v: { rate_per_1000: number }) => Number(v.rate_per_1000))).toEqual([0.3, 0.2, 0.1625, 0.15])
    await setCard(0.04) // max(0.20, 0.14, 0.12) = 0.20; the 100 000 step 0.04 x (1 + 4 x 0.15 / 0.8) = 0.07 -> floor max(0.054, 0.09) = 0.09
    expect((await quote(100_000, 0.04)).rate_per_1000).toBe(0.09)
    expect(await q(`select volume_floor_rate(0.2, 1, 1.35, 0.05) v`)).toEqual([{ v: '0.2' }]) // never above the retail rate
  })

  it('the price ladder applies the same floor', async () => {
    const rows = (await q<{ r: { min_quantity: number; rate_per_1000: number }[] }>(`select price_ladder($1::jsonb) r`,
      [JSON.stringify([{ from: 10, to: 1000000, rate_per_1000: 8, basis_per_1000: 5 }])]))[0].r
    expect(rows.map((r) => Number(r.rate_per_1000))).toEqual([8, 6.75, 6.75, 6.75])
  })
})
