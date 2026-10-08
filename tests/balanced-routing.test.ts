// Phase 7: dynamic pricing from the cheapest offer + Balanced routing.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { repriceServices, type RepriceService } from '../supabase/functions/_shared/admin-pricing.ts'
import { ROUTING_MODE, buildCandidates, effectiveCost, rankOffers, scoreFactor, selectBestOffer, ServiceUnavailableError, type OfferRow } from '../supabase/functions/_shared/routing.ts'
import { groupByService, isPriceableOffer, serviceCostBasis, toPricingOffer, type PricingOffer } from '../supabase/functions/_shared/service-cost.ts'
import type { IProvider, IProviderServiceOffer, PriceRule } from '../supabase/functions/_shared/types.ts'

const provider = (id: string, over: Partial<IProvider> = {}): IProvider => ({
  id, name: id, apiUrl: `https://${id}`, apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
  lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0, ...over,
})
const offer = (id: string, providerId: string, over: Partial<IProviderServiceOffer> = {}): IProviderServiceOffer => ({
  id, serviceId: 's1', providerId, providerServiceId: `ps-${id}`, costPer1000: 1, minQuantity: 10, maxQuantity: 10_000,
  refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: 't', updatedAt: 't', ...over,
})
const P = [provider('pa'), provider('pb'), provider('pc')]

describe('Balanced routing: effective_cost = cost x penalty x (1 - min(score, 1000) / 10000)', () => {
  it('is the BALANCED mode', () => expect(ROUTING_MODE).toBe('BALANCED'))

  it('the score is a bonus worth 0.01% of the price per point, capped at 10%', () => {
    expect(scoreFactor(0)).toBe(1)
    expect(scoreFactor(100)).toBeCloseTo(0.99, 12)
    expect(scoreFactor(1000)).toBeCloseTo(0.9, 12)
    expect(scoreFactor(50_000)).toBeCloseTo(0.9, 12) // capped
    expect(scoreFactor(-5)).toBe(1)
    expect(scoreFactor(undefined)).toBe(1)
    expect(scoreFactor(Number.NaN)).toBe(1)
    expect(effectiveCost({ costPer1000: 2, routingScore: 100 }, { reliabilityPenalty: 1.5 })).toBeCloseTo(2 * 1.5 * 0.99, 12)
  })

  it('REQUIRED: at equal price the score-100 offer beats the score-0 offer', () => {
    const best = selectBestOffer([offer('zero', 'pa', { routingScore: 0 }), offer('hundred', 'pb', { routingScore: 100 })], P)
    expect(best.id).toBe('hundred')
  })

  it('a score outweighs a small price gap but never a large one', () => {
    // 0.5% dearer with score 100 (1% off) wins; 5% dearer with score 100 loses
    expect(selectBestOffer([offer('plain', 'pa', { costPer1000: 1 }), offer('pref', 'pb', { costPer1000: 1.005, routingScore: 100 })], P).id).toBe('pref')
    expect(selectBestOffer([offer('plain', 'pa', { costPer1000: 1 }), offer('pref', 'pb', { costPer1000: 1.05, routingScore: 100 })], P).id).toBe('plain')
    // even the maximum score (10%) cannot make a 15% dearer offer win
    expect(selectBestOffer([offer('plain', 'pa', { costPer1000: 1 }), offer('pref', 'pb', { costPer1000: 1.15, routingScore: 1000 })], P).id).toBe('plain')
  })

  it('means the same for a cheap and an expensive service (relative, not a flat "cost - score x k")', () => {
    for (const base of [0.05, 5, 500]) {
      const ids = rankOffers([offer('plain', 'pa', { costPer1000: base }), offer('pref', 'pb', { costPer1000: base * 1.005, routingScore: 100 })], P).map((o) => o.id)
      expect(ids).toEqual(['pref', 'plain'])
    }
  })

  it('combines with the reliability penalty', () => {
    // flaky 1.00 x 1.3 = 1.3 ; solid 1.2 x 1 x 0.99 = 1.188
    const best = selectBestOffer(
      [offer('flaky', 'pa', { costPer1000: 1 }), offer('solid', 'pb', { costPer1000: 1.2, routingScore: 100 })],
      [provider('pa', { reliabilityPenalty: 1.3 }), provider('pb')],
    )
    expect(best.id).toBe('solid')
  })

  it('returns the whole ordering for failover: the next offer is the next in line', () => {
    const ranked = rankOffers(
      [offer('c', 'pc', { costPer1000: 3 }), offer('a', 'pa', { costPer1000: 1 }), offer('b', 'pb', { costPer1000: 2, routingScore: 1000 })],
      P,
    )
    expect(ranked.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })

  it('inactive offers and unhealthy providers are never candidates; nothing left = refusal', () => {
    const ps = [provider('pa', { healthStatus: 'degraded' }), provider('pb')]
    expect(rankOffers([offer('x', 'pa', { routingScore: 1000, costPer1000: 0.001 }), offer('off', 'pb', { isActive: false })], ps)).toEqual([])
    expect(() => selectBestOffer([offer('off', 'pb', { isActive: false })], ps)).toThrow(ServiceUnavailableError)
    expect(() => selectBestOffer([], ps)).toThrow(ServiceUnavailableError)
  })

  it('never routes to an offer that costs more than the customer pays (no sale at a loss), even with a big score', () => {
    const offers = [offer('cheap', 'pa', { costPer1000: 1 }), offer('pricey', 'pb', { costPer1000: 2.5, routingScore: 1000 })]
    expect(rankOffers(offers, P, { maxCostPer1000: 2.4 }).map((o) => o.id)).toEqual(['cheap'])
    expect(rankOffers(offers, P, { maxCostPer1000: 2.5 }).map((o) => o.id)).toEqual(['cheap', 'pricey']) // equal to the price is allowed
    expect(rankOffers(offers, P, { maxCostPer1000: 0.9 })).toEqual([])
    expect(() => selectBestOffer(offers, P, { maxCostPer1000: 0.9 })).toThrow(ServiceUnavailableError)
  })

  it('honours the quantity limits of each offer', () => {
    const offers = [offer('big', 'pa', { minQuantity: 5000, maxQuantity: 100_000, routingScore: 100 }), offer('small', 'pb', { minQuantity: 10, maxQuantity: 1000 })]
    expect(selectBestOffer(offers, P, { quantity: 100 }).id).toBe('small')
    expect(selectBestOffer(offers, P, { quantity: 10_000 }).id).toBe('big')
  })

  it('a fully assembled candidate set (database rows) is routed to the optimal offer', () => {
    const row = (id: string, prov: string, cost: number, score: number): OfferRow => ({
      id, service_id: 's1', provider_id: prov, provider_service_id: `ps-${id}`, cost_per_1000: String(cost), min_quantity: 10, max_quantity: 10_000,
      refill_supported: false, cancel_supported: false, is_active: true, routing_score: score, created_at: 't', updated_at: 't',
      provider_service: { external_service_id: id, is_active: true },
      provider: { id: prov, name: prov, api_url: 'https://x', api_key_encrypted: null, api_version: 'v2', is_active: true, routing_enabled: true, health_status: 'healthy',
        last_health_check: null, last_balance_sync: null, provider_balance: 0, currency: 'USD', priority: 0, reliability_penalty_multiplier: 1 },
    })
    const c = buildCandidates([row('o1', 'pa', 0.1, 100), row('o2', 'pb', 0.0995, 0), row('o3', 'pc', 0.2, 1000)])
    const ranked = rankOffers(c.offers, c.providers, { quantity: 500, maxCostPer1000: 0.5 })
    expect(ranked.map((o) => o.id)).toEqual(['o1', 'o2', 'o3']) // 0.099 < 0.0995 < 0.18
    expect(c.details.get(ranked[0].id)!.externalServiceId).toBe('o1')
  })
})

describe('service cost basis (the cheapest offer that can receive an order)', () => {
  const po = (id: string, over: Partial<PricingOffer> = {}): PricingOffer => ({
    id, service_id: 's1', provider_id: 'p', provider_service_id: `ps-${id}`, cost_per_1000: 1, min_quantity: 10, max_quantity: 1000, refill_supported: true,
    is_active: true, provider_service_active: true, provider_active: true, routing_enabled: true, ...over,
  })

  it('is the minimum cost over the priceable offers, not the first or the primary', () => {
    expect(serviceCostBasis([po('a', { cost_per_1000: 2 }), po('b', { cost_per_1000: 0.7 }), po('c', { cost_per_1000: 1.1 })])?.cost).toBe(0.7)
  })

  it('limits are the smallest min and the largest max', () => {
    expect(serviceCostBasis([po('a', { min_quantity: 100, max_quantity: 500 }), po('b', { min_quantity: 20, max_quantity: 300 }), po('c', { min_quantity: 50, max_quantity: 9000 })]))
      .toMatchObject({ minQuantity: 20, maxQuantity: 9000, offers: 3 })
  })

  it.each([
    ['inactive offer', { is_active: false }],
    ['panel no longer lists it', { provider_service_active: false }],
    ['provider off', { provider_active: false }],
    ['provider not routing-enabled', { routing_enabled: false }],
  ] as [string, Partial<PricingOffer>][])('ignores an offer that cannot receive orders: %s', (_name, over) => {
    expect(isPriceableOffer(po('x', over))).toBe(false)
    expect(serviceCostBasis([po('dead', { ...over, cost_per_1000: 0.01 }), po('ok', { cost_per_1000: 2 })])?.cost).toBe(2)
  })

  it('has no basis when nothing can receive an order', () => {
    expect(serviceCostBasis([])).toBeNull()
    expect(serviceCostBasis([po('x', { is_active: false })])).toBeNull()
  })

  it('refill is promised only when every usable offer supports it', () => {
    expect(serviceCostBasis([po('a'), po('b')])?.refillSupported).toBe(true)
    expect(serviceCostBasis([po('a'), po('b', { refill_supported: false })])?.refillSupported).toBe(false)
    expect(serviceCostBasis([po('a'), po('b', { refill_supported: false, is_active: false })])?.refillSupported).toBe(true)
  })

  it('groups by service and converts database rows (a missing join cannot receive orders)', () => {
    const rows = [
      { id: 'o1', service_id: 's1', provider_id: 'p', provider_service_id: 'ps1', cost_per_1000: '0.5000', min_quantity: 1, max_quantity: 9, refill_supported: false, is_active: true,
        provider_service: { is_active: true }, provider: { is_active: true, routing_enabled: true } },
      { id: 'o2', service_id: 's2', provider_id: 'p', provider_service_id: 'ps2', cost_per_1000: 3, min_quantity: 1, max_quantity: 9, refill_supported: false, is_active: true,
        provider_service: null, provider: { is_active: true, routing_enabled: true } },
    ].map(toPricingOffer)
    const g = groupByService(rows)
    expect(serviceCostBasis(g.get('s1')!)?.cost).toBe(0.5)
    expect(serviceCostBasis(g.get('s2')!)).toBeNull()
  })

  it('REQUIRED: linking a cheaper offer lowers the customer price (markup applied to the minimum)', () => {
    const rules: PriceRule[] = [{ id: 'g', type: 'percentage', value: 150, priority: 0, is_active: true }]
    const price = (offers: PricingOffer[]): number => {
      const basis = serviceCostBasis(offers)!
      const svc: RepriceService = { id: 's1', category_id: 'c', platform: 'telegram', customer_rate_per_1000: 0, provider_rate: basis.cost }
      return repriceServices([svc], rules)[0].rate
    }
    const first = po('a', { cost_per_1000: 1 })
    expect(price([first])).toBe(2.5)
    expect(price([first, po('b', { cost_per_1000: 0.6 })])).toBe(1.5) // a cheaper offer was linked
    expect(price([first, po('b', { cost_per_1000: 0.6, is_active: false })])).toBe(2.5) // ...and a suspended one does not count
    expect(price([first, po('b', { cost_per_1000: 3 })])).toBe(2.5) // a dearer one does not raise it
  })
})

// ---------------------------------------------------------------------------
// The admin pricing grid (SQL) uses the same formula and shows the base cost
// ---------------------------------------------------------------------------
describe('get_admin_pricing_view follows Balanced routing', () => {
  let db: PGlite
  let admin: string
  const byName = (rows: Record<string, unknown>[], name: string) => rows.find((r) => r.name === name)!

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))

    const q = async (sql: string, p: unknown[] = []) => (await db.query<{ id: string }>(sql, p)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    const mkProvider = (name: string, health: string, routing = true) =>
      q(`insert into providers(name, api_url) values ($1, 'https://x') returning id`, [name]).then(async (id) => {
        await db.query(`update providers set health_status = $2, routing_enabled = $3 where id = $1`, [id, health, routing])
        return id
      })
    const pA = await mkProvider('A', 'healthy')
    const pB = await mkProvider('B', 'healthy')
    const pD = await mkProvider('D', 'degraded')
    const pOff = await mkProvider('Off', 'healthy', false)
    const cat = await q(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'v') returning id`)
    const ps = (prov: string, ext: string, rate: number) =>
      q(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, 'x', $3, 1, 1000) returning id`, [prov, ext, rate])
    const svc = (name: string, primary: string, rate: number) =>
      q(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000) returning id`, [cat, name, primary, rate])
    const offer = (service: string, prov: string, psId: string, cost: number, score: number) =>
      db.query(
        `insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score)
         values ($1, $2, $3, $4, 1, 1000, $5) on conflict (service_id, provider_id, provider_service_id) do update set cost_per_1000 = $4, routing_score = $5`,
        [service, prov, psId, cost, score])

    // 'edge': A costs 1.000 score 0, B costs 1.005 score 100 -> B wins by the score bonus (1.005 x 0.99 = 0.99495)
    const a1 = await ps(pA, '1', 1), b1 = await ps(pB, '1', 1.005)
    const edge = await svc('edge', a1, 5)
    await offer(edge, pA, a1, 1, 0); await offer(edge, pB, b1, 1.005, 100)
    // 'far': B is 20% dearer: even with score 1000 (10%) A wins
    const a2 = await ps(pA, '2', 1), b2 = await ps(pB, '2', 1.2)
    const far = await svc('far', a2, 5)
    await offer(far, pA, a2, 1, 0); await offer(far, pB, b2, 1.2, 1000)
    // 'degraded': the cheapest offer sits on a degraded provider: routing skips it, but the PRICE base still counts it
    const a3 = await ps(pA, '3', 0.8), d3 = await ps(pD, '3', 0.2)
    const degraded = await svc('degraded', a3, 5)
    await offer(degraded, pA, a3, 0.8, 0); await offer(degraded, pD, d3, 0.2, 0)
    // 'routingoff': the cheapest offer's provider is not routing-enabled: neither routed nor a price base
    const a4 = await ps(pA, '4', 0.8), o4 = await ps(pOff, '4', 0.1)
    const routingoff = await svc('routingoff', a4, 5)
    await offer(routingoff, pA, a4, 0.8, 0); await offer(routingoff, pOff, o4, 0.1, 0)
    // 'suspended': cheapest offer switched off by the anomaly guard
    const a5 = await ps(pA, '5', 0.8), b5 = await ps(pB, '5', 0.3)
    const suspended = await svc('suspended', a5, 5)
    await offer(suspended, pA, a5, 0.8, 0); await offer(suspended, pB, b5, 0.3, 0)
    await db.query(`update provider_service_offers set is_active = false where service_id = $1 and provider_id = $2`, [suspended, pB])
    // 'loss': priced under the best offer cost
    const a6 = await ps(pA, '6', 0.9)
    await offer(await svc('loss', a6, 0.4), pA, a6, 0.9, 0)
  }, 180_000)

  const view = async () => {
    await db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${admin}',false)`)
    const rows = (await db.query<{ v: Record<string, unknown>[] }>(`select get_admin_pricing_view() v`)).rows[0].v
    await db.exec('reset role')
    return rows
  }

  it('picks the best offer with the router\'s formula (score bonus, capped)', async () => {
    const rows = await view()
    expect(Number(byName(rows, 'edge').best_offer_cost)).toBe(1.005)
    expect(Number(byName(rows, 'edge').best_offer_effective_cost)).toBe(0.9950) // round(1.005 x 0.99, 4)
    expect(Number(byName(rows, 'far').best_offer_cost)).toBe(1)
  })

  it('base_offer_cost is the cheapest offer that can receive an order (health ignored, routing-off and suspended excluded)', async () => {
    const rows = await view()
    expect(Number(byName(rows, 'edge').base_offer_cost)).toBe(1)
    expect(Number(byName(rows, 'degraded').base_offer_cost)).toBe(0.2)
    expect(Number(byName(rows, 'degraded').best_offer_cost)).toBe(0.8) // routing skips the degraded provider
    expect(Number(byName(rows, 'routingoff').base_offer_cost)).toBe(0.8)
    expect(Number(byName(rows, 'suspended').base_offer_cost)).toBe(0.8)
  })

  it('still shows a loss when the price is below the cost', async () => {
    const rows = await view()
    expect(Number(byName(rows, 'loss').margin_absolute)).toBe(-0.5)
  })
})
