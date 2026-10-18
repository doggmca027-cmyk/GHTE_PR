// No price jump at the top of a card's range, and the switch to the cheap offer shown in the bulk prices (migration 20261221000000):
//   * a card's maximum quantity only follows offers at most 30% dearer than its cheapest one; its minimum still follows every offer
//   * the price ladder (order-pricing.ts priceLadder + SQL price_ladder): each volume step, and where another offer takes over
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { ladderSteps, priceLadder } from '../supabase/functions/_shared/order-pricing.ts'
import { MAX_LIMIT_COST_SPREAD, serviceCostBasis, type PricingOffer } from '../supabase/functions/_shared/service-cost.ts'
import type { IProvider, IProviderServiceOffer } from '../supabase/functions/_shared/types.ts'

const po = (id: string, cost: number, min: number, max: number): PricingOffer => ({
  id, service_id: 's', provider_id: id, provider_service_id: `ps-${id}`, cost_per_1000: cost, min_quantity: min, max_quantity: max,
  refill_supported: false, is_active: true, provider_service_active: true, provider_active: true, routing_enabled: true,
})

describe('the card limits', () => {
  it('REQUIRED: a much dearer offer does not raise the maximum (Instagram Followers: 10 000, not 40 000), but still lowers the minimum', () => {
    expect(MAX_LIMIT_COST_SPREAD).toBe(0.3)
    const basis = serviceCostBasis([po('smmpwr', 41.75, 10, 10_000), po('rootpanel', 47.8332, 10, 10_000), po('smm-center', 169.8144, 5, 40_000)])
    expect(basis).toMatchObject({ cost: 41.75, minQuantity: 5, maxQuantity: 10_000 })
  })

  it('an offer within 30% of the cheapest raises it; one just above does not (Telegram Post Views, India: 20 000)', () => {
    expect(serviceCostBasis([po('a', 1, 10, 1000), po('b', 1.3, 10, 5000)])?.maxQuantity).toBe(5000)
    expect(serviceCostBasis([po('a', 1, 10, 1000), po('b', 1.3001, 10, 5000)])?.maxQuantity).toBe(1000)
    expect(serviceCostBasis([po('rootpanel', 0.312, 10, 20_000), po('smmstone', 0.67, 10, 50_000), po('smm-center', 1.2, 10, 100_000)])?.maxQuantity).toBe(20_000)
  })

  it('small retail through a dearer offer keeps working (Telegram Members, Russia: 10 .. 50 000)', () => {
    expect(serviceCostBasis([po('rootpanel', 0.66, 250, 50_000), po('smm-center', 2.724, 10, 15_000)])).toMatchObject({ minQuantity: 10, maxQuantity: 50_000 })
  })
})

const prov = (id: string): IProvider => ({ id, name: id, apiUrl: '', apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
  lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0 })
const offer = (id: string, cost: number, min: number, max: number): IProviderServiceOffer => ({ id, serviceId: 's', providerId: id, providerServiceId: `ps-${id}`,
  costPer1000: cost, minQuantity: min, maxQuantity: max, refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: '', updatedAt: '' })
const rate = (o: { costPer1000: number }) => Math.round(o.costPer1000 * 18_000) / 10_000 // x1.8

describe('which offer serves which quantity range', () => {
  it('cuts where an offer starts or stops, with the router\'s choice in each range', () => {
    const offers = [offer('rootpanel', 0.66, 250, 50_000), offer('smm-center', 2.724, 10, 15_000)]
    expect(priceLadder({ min: 10, max: 15_000 }, offers, [prov('rootpanel'), prov('smm-center')], rate)).toEqual([
      { from: 10, to: 249, rate_per_1000: 4.9032, basis_per_1000: 2.724, offerId: 'smm-center' },
      { from: 250, to: 15_000, rate_per_1000: 1.188, basis_per_1000: 0.66, offerId: 'rootpanel' },
    ])
  })

  it('joins ranges of the same offer, leaves out what nobody serves, ignores offers that cannot take orders', () => {
    const providers = [prov('a'), prov('b'), { ...prov('down'), healthStatus: 'unavailable' as const }]
    const offers = [offer('a', 1, 10, 100), offer('b', 2, 50, 200), offer('down', 0.1, 10, 1000)]
    expect(priceLadder({ min: 10, max: 500 }, offers, providers, rate).map(({ from, to, offerId }) => [from, to, offerId])).toEqual([
      [10, 100, 'a'], [101, 200, 'b'], // 201..500: no healthy offer
    ])
    expect(priceLadder({ min: 10, max: 100 }, [offer('a', 1, 10, 100), offer('b', 2, 10, 100)], providers, rate)).toHaveLength(1)
  })

  it('a step at the same rate as the one before says nothing new', () => {
    expect(ladderSteps([{ min_quantity: 10, rate_per_1000: '1.8' }, { min_quantity: 100, rate_per_1000: 1.8 }, { min_quantity: 1000, rate_per_1000: '1.4' }]))
      .toEqual([{ minQuantity: 10, ratePer1000: 1.8 }, { minQuantity: 1000, ratePer1000: 1.4 }])
  })
})

describe('price_ladder (real SQL)', () => {
  let db: PGlite
  const ladder = async (segments: unknown) => (await db.query<{ r: { min_quantity: number; rate_per_1000: number }[] }>(`select price_ladder($1::jsonb) r`, [JSON.stringify(segments)])).rows[0].r

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.query(`update platform_settings set volume_margin_tiers = $1::jsonb where id = 1`,
      [JSON.stringify([{ min: 0, margin: 0.8 }, { min: 1000, margin: 0.4 }, { min: 10000, margin: 0.25 }, { min: 100000, margin: 0.15 }])])
  }, 180_000)

  it('REQUIRED: the switch to the cheap offer is a step ("from 250 · $1.19"), and so is every volume step inside each range', async () => {
    const rows = await ladder([
      { from: 10, to: 249, rate_per_1000: 4.9032, basis_per_1000: 2.724 },
      { from: 250, to: 15000, rate_per_1000: 1.188, basis_per_1000: 0.66 },
    ])
    expect(rows.map((r) => [r.min_quantity, Number(r.rate_per_1000)])).toEqual([[10, 4.9032], [250, 1.188], [1000, 0.924], [10000, 0.825]])
  })

  it('without volume pricing: one step per range', async () => {
    await db.query(`update platform_settings set volume_margin_tiers = null where id = 1`)
    const rows = await ladder([{ from: 10, to: 249, rate_per_1000: 4.9032, basis_per_1000: 2.724 }, { from: 250, to: 15000, rate_per_1000: 1.188, basis_per_1000: 0.66 }])
    expect(rows.map((r) => [r.min_quantity, Number(r.rate_per_1000)])).toEqual([[10, 4.9032], [250, 1.188]])
    expect(await ladder([])).toEqual([])
    await expect(db.query(`select price_ladder('{}'::jsonb)`)).rejects.toThrow(/segments must be an array/)
  })

  it('is a server-only function', async () => {
    const g = (await db.query<{ a: boolean; u: boolean }>(`select has_function_privilege('anon', 'price_ladder(jsonb)', 'execute') a, has_function_privilege('authenticated', 'price_ladder(jsonb)', 'execute') u`)).rows[0]
    expect([g.a, g.u]).toEqual([false, false])
  })
})
