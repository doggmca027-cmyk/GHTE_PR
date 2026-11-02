// System health after the provider rotation, from the database to the panel: the router on the two cases that matter (a cheap card and a
// quality card), the price of what it picks through the real SQL, the request a panel is sent, and that a retired provider can be reached by no road.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executePlaceOrder, type OrderRecord, type PlaceOrderPorts } from '../supabase/functions/_shared/place-order-flow.ts'
import { calculateCustomerRate } from '../supabase/functions/_shared/price-engine.ts'
import { buildCandidates, rankOffers, type OfferRow } from '../supabase/functions/_shared/routing.ts'
import { resolveProviderApiKey } from '../supabase/functions/_shared/secrets.ts'
import { SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { IProvider, IProviderServiceOffer, PriceRule } from '../supabase/functions/_shared/types.ts'

// the storefront's price rules as they are on production (4 tier rules: the cost decides the markup)
const rule = (id: string, value: number, min_rate: number, max_rate: number | null, min_markup: number | null, min_price: number | null = null): PriceRule =>
  ({ id, type: 'tier', value, min_rate, max_rate, min_markup, min_price, priority: 0, is_active: true })
const RULES: PriceRule[] = [
  rule('t1', 400, 0, 0.0499, 0.1, 0.12), // cost < 0.05: max(x5, +0.10, 0.12)
  rule('t2', 200, 0.05, 0.4999, 0.12), //   0.05 - 0.50: max(x3, +0.12)
  rule('t3', 100, 0.5, 4.9999, 0.3), //     0.50 - 5.00: max(x2, +0.30)
  rule('t4', 60, 5, null, null), //         from 5.00: x1.6
]
const rateOf = (cost: number, name: string) => calculateCustomerRate(cost, RULES, { platform: 'telegram', serviceName: name })

const HQ_CARD = 'Instagram Followers [refill: 30 days] [Iran]'
const PLAIN_CARD = 'Telegram Post Views [no refill]'

describe('catalogue, router and price, on one database', () => {
  let db: PGlite
  let cat: string, seq = 0
  const dir = path.resolve(__dirname, '../supabase/migrations')
  const P = {
    jap: '00000000-0000-4000-8000-0000000e0001', root: '00000000-0000-4000-8000-0000000e0002', secsers: '00000000-0000-4000-8000-0000000e0003',
    mtp: '00000000-0000-4000-8000-0000000e0004', center: '00000000-0000-4000-8000-0000000e0005',
  }
  const S: Record<string, string> = {}

  const ps = async (provider: string, name: string, rate: number) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 10, 1000000) returning id`, [provider, `e${++seq}`, name, rate])).rows[0].id
  const card = async (name: string, rate: number, basis: number, source: string) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, cost_basis_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, $5, 10, 1000000, true) returning id`, [cat, name, source, rate, basis])).rows[0].id
  const link = async (service: string, provider: string, panelName: string, cost: number) => {
    const source = await ps(provider, panelName, cost)
    return (await db.query<{ id: string }>(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 10, 1000000, true) returning id`, [service, provider, source, cost])).rows[0].id
  }
  /** The offers of a card in the shape the Edge Function reads them (routing.ts OFFER_SELECT), straight from the tables. */
  const offerRows = async (service: string) => (await db.query<{ r: OfferRow }>(`
    select jsonb_build_object(
      'id', o.id, 'service_id', o.service_id, 'provider_id', o.provider_id, 'provider_service_id', o.provider_service_id, 'cost_per_1000', o.cost_per_1000,
      'min_quantity', o.min_quantity, 'max_quantity', o.max_quantity, 'refill_supported', o.refill_supported, 'cancel_supported', o.cancel_supported, 'is_active', o.is_active,
      'routing_score', o.routing_score, 'created_at', o.created_at, 'updated_at', o.updated_at,
      'provider_service', jsonb_build_object('external_service_id', ps.external_service_id, 'is_active', ps.is_active, 'is_dripfeed_enabled', ps.is_dripfeed_enabled, 'name', ps.name),
      'provider', jsonb_build_object('id', p.id, 'name', p.name, 'api_url', p.api_url, 'api_key_encrypted', p.api_key_encrypted, 'api_version', p.api_version, 'is_active', p.is_active,
        'routing_enabled', p.routing_enabled, 'health_status', p.health_status, 'last_health_check', p.last_health_check, 'last_balance_sync', p.last_balance_sync,
        'provider_balance', p.provider_balance, 'currency', p.currency, 'priority', p.priority, 'reliability_penalty_multiplier', p.reliability_penalty_multiplier, 'is_premium', p.is_premium)) r
      from provider_service_offers o join provider_services ps on ps.id = o.provider_service_id join providers p on p.id = o.provider_id where o.service_id = $1`, [service])).rows.map((x) => x.r)
  const quote = async (service: string, quantity: number, offerId: string, rate: number, runs = 1) =>
    (await db.query<{ q: Record<string, unknown> }>(`select quote_order_price(null, $1::uuid, $2, null, $3, $4::uuid, $5) q`, [service, quantity, runs, offerId, rate])).rows[0].q
  const providerName = (id: string, providers: IProvider[]) => providers.find((p) => p.id === id)?.name

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    // the settings of the storefront as they are on production (data, not migration): the volume steps and their floor
    await db.exec(`update platform_settings set volume_margin_tiers = '[{"min":0,"margin":0.8},{"min":1000,"margin":0.4},{"min":10000,"margin":0.25},{"min":100000,"margin":0.15}]',
      volume_floor_multiplier = 1.35, volume_floor_markup = 0.05, min_order_charge = 0.01, discount_min_margin_per_1000 = 0.01 where id = 1`)
    await db.exec(`insert into providers (id, name, api_url, is_active, routing_enabled, health_status, is_premium, catalog_mode) values
      ('${P.jap}', 'JAP', 'https://j', true, true, 'healthy', false, 'linked_only'), ('${P.root}', 'RootPanel', 'https://r', true, true, 'healthy', false, 'linked_only'),
      ('${P.secsers}', 'Secsers', 'https://s', true, true, 'healthy', true, 'publish'), ('${P.mtp}', 'MoreThanPanel', 'https://m', true, true, 'healthy', true, 'publish'),
      ('${P.center}', 'SMM Center', 'https://c', false, false, 'disabled', false, 'publish')`)
    cat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'C', 'c') returning id`)).rows[0].id

    // A: Telegram views without a guarantee. The retired provider's old offer is the cheapest of all and still active.
    // (a card gets an offer on its primary provider service by itself: that is the retired provider's, at the cost of that service)
    S.views = await card(PLAIN_CARD, 0.2, 0.04, await ps(P.center, PLAIN_CARD, 0.01))
    S.viewsRoot = await link(S.views, P.root, 'Telegram Post Views | Fast', 0.04)
    S.viewsJap = await link(S.views, P.jap, 'Telegram Views [Max: 1M] [Start Time: Instant]', 0.05)
    S.viewsSecsers = await link(S.views, P.secsers, 'Telegram Views | Lifetime Refill - Real', 0.3)
    S.viewsMtp = await link(S.views, P.mtp, 'Telegram Post Views | Non Drop | HQ', 0.35)

    // B: Instagram followers with a 30 day refill. The panels that are dearer are the ones that keep the promise.
    S.hq = await card(HQ_CARD, 4.2, 2.1, await ps(P.center, HQ_CARD, 0.2))
    S.hqRoot = await link(S.hq, P.root, 'Instagram Followers | Cheap', 0.6)
    S.hqJap = await link(S.hq, P.jap, 'Instagram Followers | Refill: 30 Days', 0.9)
    S.hqSecsers = await link(S.hq, P.secsers, 'Instagram Followers | Real | 30 Days Refill', 2.1)
    S.hqMtp = await link(S.hq, P.mtp, 'Instagram Followers | Lifetime Guaranteed', 2.5)

    // a card whose only offer is the retired provider's
    S.orphan = await card('Instagram Likes [Aruba]', 2, 1, await ps(P.center, 'Instagram Likes [Aruba]', 1))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('catalogue integrity: the cards that sell have a working offer, and the query that finds a card nobody can serve finds exactly the orphan', async () => {
    const orphans = (await db.query<{ id: string }>(`
      select s.id from services s where s.is_active and not exists (
        select 1 from provider_service_offers o
          join provider_services ps on ps.id = o.provider_service_id and ps.is_active
          join providers p on p.id = o.provider_id and p.is_active and p.routing_enabled
         where o.service_id = s.id and o.is_active)`)).rows.map((r) => r.id)
    expect(orphans).toEqual([S.orphan])
    // and the router agrees: it has nothing for the orphan, whatever the quantity
    const c = buildCandidates(await offerRows(S.orphan))
    expect(rankOffers(c.offers, c.providers, { quantity: 100 })).toEqual([])
  })

  describe('scenario A: a Telegram views card without a guarantee', () => {
    it('goes to the cheapest working panel; the cheaper offer of the retired provider is never chosen', async () => {
      const c = buildCandidates(await offerRows(S.views))
      const ranked = rankOffers(c.offers, c.providers, { quantity: 10, serviceName: PLAIN_CARD })
      expect(ranked.map((o) => providerName(o.providerId, c.providers))).toEqual(['RootPanel', 'JAP', 'Secsers', 'MoreThanPanel'])
      // the premium panels sell it too, but only as the dearest choice: nothing here promises quality
      expect(ranked[0].costPer1000).toBe(0.04)
    })

    it('ten views cost the minimum charge, one cent, and the price per 1000 falls with the quantity without going under the cost', async () => {
      const rate = rateOf(0.04, PLAIN_CARD)
      expect(rate).toBe(0.2)
      expect(Number((await quote(S.views, 10, S.viewsRoot, rate)).final_price)).toBe(0.01)
      const unit = async (qty: number) => Number((await quote(S.views, qty, S.viewsRoot, rate)).final_price) / qty * 1000
      const [u1, u2, u3] = [await unit(1000), await unit(10_000), await unit(100_000)]
      expect(u1).toBeLessThan(rate)
      expect(u2).toBeLessThanOrEqual(u1)
      expect(u3).toBeLessThanOrEqual(u2)
      expect(u3).toBeGreaterThan(0.04 + 0.01) // never under cost + the minimum margin
    })
  })

  describe('scenario B: an Instagram followers card with a 30 day refill', () => {
    it('goes to a premium panel first, even though a plain one costs a quarter of the price', async () => {
      const c = buildCandidates(await offerRows(S.hq))
      const ranked = rankOffers(c.offers, c.providers, { quantity: 1000, serviceName: HQ_CARD })
      // premium panels (cheaper first), then the panel whose own name promises the refill, then the rest
      expect(ranked.map((o) => providerName(o.providerId, c.providers))).toEqual(['Secsers', 'MoreThanPanel', 'JAP', 'RootPanel'])
      // the same card without the promise in its name goes the other way
      const plain = rankOffers(c.offers, c.providers, { quantity: 1000, serviceName: 'Instagram Followers [no refill] [Iran]' })
      expect(plain.map((o) => providerName(o.providerId, c.providers))).toEqual(['RootPanel', 'JAP', 'Secsers', 'MoreThanPanel'])
    })

    it('is priced on the offer that serves it, by the progressive grid: 1.5x of the cost at 1000, never under the step floor', async () => {
      const cost = 2.1
      const rate = rateOf(cost, HQ_CARD)
      expect(rate).toBe(4.2) // max(x2, +0.30)
      const total = async (qty: number) => Number((await quote(S.hq, qty, S.hqSecsers, rate)).final_price)
      expect(await total(100)).toBe(0.42) // the base step: 4.20 per 1000
      expect(await total(1000)).toBe(3.15) // +50% over the cost: the step of a x2 card
      const [u1000, u10k, u100k] = [(await total(1000)) , (await total(10_000)) / 10, (await total(100_000)) / 100]
      expect(u10k).toBeLessThan(u1000)
      expect(u100k).toBeLessThanOrEqual(u10k)
      for (const unit of [u1000, u10k, u100k]) expect(unit).toBeGreaterThanOrEqual(2.835) // the step floor: 1.35 x the cost of 2.10
    })

    it('the retired provider cannot be quoted: the database refuses an offer whose provider is off', async () => {
      const offerId = (await db.query<{ id: string }>(`select id from provider_service_offers where service_id = $1 and provider_id = $2`, [S.hq, P.center])).rows[0].id
      await expect(quote(S.hq, 1000, offerId, 4.2)).rejects.toThrow(/service_unavailable/)
    })
  })
})

describe('no road leads to a provider that is off', () => {
  const provider = (id: string, over: Partial<IProvider> = {}): IProvider => ({
    id, name: id, apiUrl: `https://${id}`, apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
    lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0, ...over,
  })
  const offer = (id: string, providerId: string, costPer1000: number, panelName: string): IProviderServiceOffer => ({
    id, serviceId: 's', providerId, providerServiceId: `ps-${id}`, panelName, costPer1000, minQuantity: 10, maxQuantity: 10_000,
    refillSupported: true, cancelSupported: false, isActive: true, routingScore: 1000, createdAt: 't', updatedAt: 't',
  })

  it.each([
    ['switched off', { isActive: false }],
    ['routing off', { routingEnabled: false }],
    ['disabled', { healthStatus: 'disabled' as const }],
    ['down', { healthStatus: 'unavailable' as const }],
  ])('an active offer of a provider that is %s is never ranked, however cheap, good or highly scored', (_label, over) => {
    const offers = [offer('retired', 'old', 0.001, 'Instagram Followers | HQ | Refill: Lifetime'), offer('live', 'new', 9, 'Instagram Followers')]
    for (const serviceName of [undefined, 'Instagram Followers [refill: 30 days]', 'Telegram Post Views [no refill]']) {
      expect(rankOffers(offers, [provider('old', { ...over, premium: true }), provider('new')], { quantity: 100, serviceName }).map((o) => o.id)).toEqual(['live'])
    }
    expect(rankOffers([offers[0]], [provider('old', over)], { quantity: 100 })).toEqual([])
  })

  it('a provider without a key cannot be sent anything: the key resolves to nothing, and the order functions refuse an empty key', async () => {
    const env = { get: (_name: string): string | undefined => undefined }
    for (const name of ['SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider']) expect(await resolveProviderApiKey({ name, api_key_encrypted: null }, env)).toBe('')
    // and a request through an adapter without a key never reaches the network: it runs as the mock
    const adapter = new SMMv2Adapter({ id: 'old', name: 'SMMPWR', apiUrl: 'https://smmpwr.invalid/api/v2', apiKey: '', fetchImpl: (() => { throw new Error('the network was reached') }) as unknown as typeof fetch })
    expect(adapter.isMock).toBe(true)
  })
})

describe('the request a panel is sent', () => {
  const order = (o: Partial<OrderRecord> = {}): OrderRecord => ({
    id: 'o1', user_id: 'u1', service_id: 's1', target_url: 'https://instagram.com/x', quantity: 3000, charge_amount: 9.45, status: 'processing',
    provider_order_id: null, error_message: null, ...o,
  })
  function ports(start: OrderRecord): PlaceOrderPorts & { placed: Record<string, unknown>[] } {
    let row = { ...start }
    const placed: Record<string, unknown>[] = []
    return {
      placed,
      async placeOrder(a) { placed.push(a as unknown as Record<string, unknown>); row = { ...row, status: 'paid', runs: a.runs ?? 1, interval: a.interval ?? 0 }; return row },
      async claim() { row = { ...row, status: 'processing' }; return row },
      async get() { return row },
      async update(_id, patch) { row = { ...row, ...patch } as OrderRecord; return row },
      async refund() { row = { ...row, status: 'refunded' }; return row },
    }
  }
  const panel = () => {
    const bodies: URLSearchParams[] = []
    const fetchImpl = (async (_url: string, init: { body: URLSearchParams }) => {
      bodies.push(new URLSearchParams(String(init.body)))
      return new Response(JSON.stringify({ order: 23501 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return { bodies, adapter: new SMMv2Adapter({ id: 'secsers', name: 'Secsers', apiUrl: 'https://secsers.test/api/v2', apiKey: 'KEY', mockMode: false, fetchImpl, capabilities: { supportsDripFeed: true } }) }
  }
  const input = { userId: 'u1', serviceId: 's1', targetUrl: 'https://instagram.com/x', quantity: 3000, idempotencyKey: 'k', providerOfferId: 'of', providerId: 'p', providerServiceId: 'ps', costAmount: 6.3, externalServiceId: '4899' }
  const quiet = { warn: () => {}, error: () => {} }

  it('a drip-feed order: the order keeps the TOTAL, the panel is asked for ONE portion, the runs and the interval', async () => {
    const { bodies, adapter } = panel()
    const p = ports(order())
    const r = await executePlaceOrder({ ...input, runs: 3, interval: 60 }, p, adapter, quiet)
    expect(r.kind).toBe('submitted')
    expect(p.placed[0]).toMatchObject({ quantity: 3000, runs: 3, interval: 60, costAmount: 6.3 }) // charged and reserved on the total
    expect(bodies).toHaveLength(1)
    expect(Object.fromEntries(bodies[0])).toEqual({ key: 'KEY', action: 'add', service: '4899', link: 'https://instagram.com/x', quantity: '1000', runs: '3', interval: '60' })
  })

  it('a plain order: the whole quantity, no runs and no interval in the request', async () => {
    const { bodies, adapter } = panel()
    const r = await executePlaceOrder(input, ports(order()), adapter, quiet)
    expect(r.kind).toBe('submitted')
    expect(Object.fromEntries(bodies[0])).toEqual({ key: 'KEY', action: 'add', service: '4899', link: 'https://instagram.com/x', quantity: '3000' })
  })

  it('a schedule that does not split into whole portions is refused before anything is sent', async () => {
    const { bodies, adapter } = panel()
    await expect(executePlaceOrder({ ...input, quantity: 3001, runs: 3, interval: 60 }, ports(order({ quantity: 3001 })), adapter, quiet)).resolves.not.toMatchObject({ kind: 'submitted' })
    expect(bodies).toHaveLength(0)
  })
})
