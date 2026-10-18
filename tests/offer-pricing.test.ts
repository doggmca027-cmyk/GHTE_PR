// An order is priced on the offer that serves its quantity (migration 20261220000000, _shared/order-pricing.ts): quote-order and
// place-order route the quantity with the same router and price it at that offer's retail rate, so every quantity of a card's range sells
// above its cost and the quote is the charge to the cent. Pure rate maths + real SQL on PGlite.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { offerRatePer1000, toPricedService, type PricedService } from '../supabase/functions/_shared/order-pricing.ts'
import { isPreSendRejection, PlaceOrderDbError } from '../supabase/functions/_shared/place-order-flow.ts'
import { rankOffers } from '../supabase/functions/_shared/routing.ts'
import type { IProvider, IProviderServiceOffer, PriceRule } from '../supabase/functions/_shared/types.ts'

// the owner's rules on production: +80%, and x1.5 from a cost of $5
const RULES: PriceRule[] = [
  { id: 'g', type: 'percentage', value: 80, priority: 0, is_active: true },
  { id: 't4', type: 'tier', value: 50, min_rate: 5, priority: 1, is_active: true },
]
const card = (over: Partial<PricedService> = {}): PricedService => ({
  id: 's', category_id: 'c', name: 'Telegram Post Views', platform: 'telegram', customer_rate_per_1000: 0.72, cost_basis_per_1000: 0.4, ...over,
})

describe('the retail rate of the offer that serves the order', () => {
  it('the offer the card is priced on pays the card\'s own rate', () => {
    expect(offerRatePer1000(card(), 0.4, RULES)).toBe(0.72)
    // an admin's own price for the card is kept too
    expect(offerRatePer1000(card({ customer_rate_per_1000: 0.9 }), 0.4, RULES)).toBe(0.9)
  })

  it('another offer is priced on its own cost by the same rules: x1.8, x1.5 from $5', () => {
    expect(offerRatePer1000(card(), 1, RULES)).toBe(1.8)
    expect(offerRatePer1000(card(), 4.99, RULES)).toBe(8.982)
    expect(offerRatePer1000(card(), 6, RULES)).toBe(9)
    expect(offerRatePer1000(card({ cost_basis_per_1000: null }), 0.4, RULES)).toBe(0.72) // a card the sync has not priced yet
  })

  it('without a rule: the card\'s rate, lifted to the offer\'s cost + $0.02', () => {
    expect(offerRatePer1000(card(), 1, [])).toBe(1.02)
    expect(offerRatePer1000(card(), 0.5, [])).toBe(0.72)
  })

  it('reads the service row (platform slug from the join)', () => {
    expect(toPricedService({
      id: 's', category_id: 'c', name: 'n', is_active: true, min_quantity: 10, max_quantity: 100, customer_rate_per_1000: '0.7200', cost_basis_per_1000: null,
      category: { platform: { slug: 'youtube' } },
    })).toEqual({ id: 's', category_id: 'c', name: 'n', platform: 'youtube', customer_rate_per_1000: 0.72, cost_basis_per_1000: null })
  })

  it('routing picks the cheapest offer that takes the quantity, also one dearer than the card (no price cap is passed)', () => {
    const p = (id: string): IProvider => ({ id, name: id, apiUrl: '', apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
      lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0 })
    const o = (id: string, cost: number, min: number, max: number): IProviderServiceOffer => ({ id, serviceId: 's', providerId: id, providerServiceId: `ps-${id}`,
      costPer1000: cost, minQuantity: min, maxQuantity: max, refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: '', updatedAt: '' })
    const offers = [o('wholesale', 0.4, 1000, 1_000_000), o('retail', 1, 10, 1000)]
    const providers = [p('wholesale'), p('retail')]
    expect(rankOffers(offers, providers, { quantity: 500 }).map((x) => x.id)).toEqual(['retail'])
    expect(rankOffers(offers, providers, { quantity: 1000 }).map((x) => x.id)).toEqual(['wholesale', 'retail'])
    expect(rankOffers(offers, providers, { quantity: 50_000 }).map((x) => x.id)).toEqual(['wholesale'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
const W = '00000000-0000-0000-0000-0000000000a1' // wholesale: 0.40 per 1000, 1 000 .. 1 000 000
const R = '00000000-0000-0000-0000-0000000000a2' // retail: 1.00 per 1000, 10 .. 1 000
const C = '00000000-0000-0000-0000-0000000000a3' // another wholesale panel: 0.45
const D = '00000000-0000-0000-0000-0000000000a4' // a dear one: 0.60
const off = (p: string) => p.replace('0000000000a', '000000000aa') // offer id of provider p
const ps = (p: string) => p.replace('0000000000a', '000000000bb') // provider service id of provider p
const COST: Record<string, number> = { [W]: 0.4, [R]: 1, [C]: 0.45, [D]: 0.6 }
const SVC = '00000000-0000-0000-0000-0000000000f1'
const TIERS = [{ min: 0, margin: 0.8 }, { min: 1000, margin: 0.4 }, { min: 10000, margin: 0.25 }, { min: 100000, margin: 0.15 }]

describe('the quote is the charge, on every quantity of the card (real SQL)', () => {
  let db: PGlite
  let u: string
  let n = 0
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows
  const rate = (p: string) => offerRatePer1000(card(), COST[p], RULES)
  const quote = async (qty: number, p: string, r = rate(p)) =>
    (await q<{ r: Record<string, any> }>(`select quote_order_price($1::uuid, '${SVC}', $2, null, 1, $3::uuid, $4) r`, [u, qty, off(p), r]))[0].r
  const place = async (qty: number, p: string, priced = p, r = rate(priced)) =>
    (await q(`select * from place_order($1::uuid, '${SVC}', 'https://t.me/x', $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, null, false, 1, 0, $8::uuid, $9)`,
      [u, qty, off(p), p, ps(p), Math.round(COST[p] * qty * 10) / 10_000, `k${++n}`, off(priced), r]))[0]
  const balance = async () => Number((await q<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [u]))[0].b)

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const limits: Record<string, [number, number]> = { [W]: [1000, 1_000_000], [R]: [10, 1000], [C]: [10, 1_000_000], [D]: [10, 1_000_000] }
    for (const p of [W, R, C, D]) {
      await db.query(`insert into providers(id, name, api_url, routing_enabled, health_status, is_active, provider_balance, last_balance_sync) values ($1, $2, 'https://x', true, 'healthy', true, 100000, now())`, [p, `P-${p.slice(-2)}`])
      await db.query(`insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, '1', 'x', $3, $4, $5)`, [ps(p), p, COST[p], ...limits[p]])
    }
    await db.exec(`
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', (select id from platforms where slug = 'telegram'), 'Views', 'views');
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, cost_basis_per_1000, min_quantity, max_quantity)
        values ('${SVC}', '00000000-0000-0000-0000-0000000000c1', 'Telegram Post Views', '${ps(W)}', 0.72, 0.4, 10, 1000000);
      delete from provider_service_offers;`)
    for (const p of [W, R, C, D]) {
      await db.query(`insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values ($1, '${SVC}', $2, $3, $4, $5, $6)`,
        [off(p), p, ps(p), COST[p], ...limits[p]])
    }
    // C and D only serve the fall-over test: the card is W + R, a wholesale and a retail offer, like the 8 cards on production
    await db.query(`update provider_service_offers set is_active = false where provider_id in ($1, $2)`, [C, D])
    await db.query(`update platform_settings set volume_margin_tiers = $1::jsonb where id = 1`, [JSON.stringify(TIERS)])
    u = (await q<{ id: string }>(`insert into users(telegram_id) values (1) returning id`))[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100000,null,'fund','fund-1')`, [u])
  }, 180_000)

  it('REQUIRED: a quantity only the dearer retail offer takes was refused; now it sells on that offer, above its cost', async () => {
    await expect(q(`select quote_order_price($1::uuid, '${SVC}', 500, null)`, [u])).rejects.toThrow(/service_unavailable/) // the old call
    const quoted = await quote(500, R)
    expect(quoted).toMatchObject({ rate_per_1000: 1.8, list_price: 0.9, provider_cost: 0.5 })
    const order = await place(500, R)
    expect(Number(order.charge_amount)).toBe(Number(quoted.final_price))
    expect(Number(order.profit_amount)).toBeGreaterThan(0)
  })

  it('REQUIRED: the quote and the charge are the same to the cent on every quantity of the range, with the volume steps', async () => {
    for (const qty of [10, 999, 1000, 4321, 10_000, 99_999, 100_000, 1_000_000]) {
      const p = qty < 1000 ? R : W // the cheapest offer that takes it (what rankOffers picks)
      const quoted = await quote(qty, p)
      const order = await place(qty, p)
      expect(Number(order.charge_amount), `quantity ${qty}`).toBe(Number(quoted.final_price))
      expect(Number(order.list_price_amount), `quantity ${qty}`).toBe(Number(quoted.list_price))
      expect(Number(order.profit_amount), `quantity ${qty}`).toBeGreaterThan(0)
    }
    // the step is scaled on the serving offer's own cost: 50 000 at 0.40 x 1.25
    expect(await quote(50_000, W)).toMatchObject({ rate_per_1000: 0.5, list_price: 25 })
  })

  it('a fall-over to another offer pays the quoted price; one that would not keep the minimum margin is refused before charging', async () => {
    await db.query(`update provider_service_offers set is_active = true where provider_id in ($1, $2)`, [C, D])
    const quoted = await quote(5000, W) // 0.40 x 1.4 = 0.56 per 1000: 2.80
    expect(Number(quoted.final_price)).toBe(2.8)
    const viaC = await place(5000, C, W) // 0.45: cost 2.25, still above cost + minimum margin
    expect(Number(viaC.charge_amount)).toBe(2.8)
    expect(Number(viaC.cost_amount)).toBe(2.25)
    const before = await balance()
    const refused = await place(5000, D, W).then(() => null, (e: Error) => e) // 0.60: cost 3.00 > 2.80
    expect(refused?.message).toMatch(/offer_below_price/)
    expect(isPreSendRejection(new PlaceOrderDbError(refused!.message))).toBe(true) // place-order tries the next offer
    expect(await balance()).toBe(before)
  })

  it('refuses a rate under the offer cost, and an offer that cannot take the quantity', async () => {
    await expect(quote(500, R, 0.9)).rejects.toThrow(/below_cost/)
    await expect(place(500, R, R, 0.9)).rejects.toThrow(/below_cost/)
    await expect(quote(500, W)).rejects.toThrow(/service_unavailable/) // the wholesale offer starts at 1 000
  })

  it('stays a server-only function', async () => {
    for (const fn of [
      'quote_order_price(uuid, uuid, integer, text, integer, uuid, numeric)',
      'place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer, uuid, numeric)',
      'calculate_order_price(uuid, uuid, integer, numeric, text, numeric, numeric)',
    ]) {
      const g = (await q<{ a: boolean; u: boolean }>(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u`))[0]
      expect([g.a, g.u], fn).toEqual([false, false])
    }
  })
})
