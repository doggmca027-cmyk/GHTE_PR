// Curated multi-provider routing: catalog_mode (publish / linked_only), the bundle price built on the CHEAPEST usable offer,
// the routing order of a bundle, and LINK_BY_EXTERNAL_ID.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseMappingRequest } from '../supabase/functions/_shared/admin-catalog-mapping'
import { parseProviderRequest, toProviderDto } from '../supabase/functions/_shared/admin-providers'
import { syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run'
import { silentLogger } from '../supabase/functions/_shared/logger'
import { BundleError, bundleOffers, bundlePrice, findPanelService, linkByExternalId, type BundleOfferRow, type BundleServiceRow, type LinkPorts } from '../supabase/functions/_shared/offer-bundle'
import { rankOffers } from '../supabase/functions/_shared/routing'
import { serviceCostBasis, type PricingOffer } from '../supabase/functions/_shared/service-cost'
import type { IProviderService, PriceRule } from '../supabase/functions/_shared/types'
import { checkProviderDraft, draftOf } from '../src/lib/provider-form'
import type { AdminProvider } from '../src/types/admin-providers'

const panel = (id: string, o: Partial<IProviderService> = {}): IProviderService => ({
  externalServiceId: id, name: `Service ${id}`, type: 'Default', categoryRaw: 'Telegram Views', ratePer1000: 1, minQuantity: 10, maxQuantity: 100000,
  refillSupported: false, cancelSupported: false, ...o,
})

const offerRow = (id: string, cost: number, o: Partial<BundleOfferRow> = {}, p: Partial<NonNullable<BundleOfferRow['provider']>> = {}): BundleOfferRow => ({
  id, service_id: 'svc', provider_id: `prov-${id}`, provider_service_id: `ps-${id}`, cost_per_1000: cost, min_quantity: 10, max_quantity: 100000,
  refill_supported: false, is_active: true, routing_score: 0, anomaly_detected: false,
  provider_service: { external_service_id: `ext-${id}`, name: `panel ${id}`, is_active: true },
  provider: { id: `prov-${id}`, name: `Provider ${id}`, is_active: true, routing_enabled: true, health_status: 'healthy', provider_balance: 50, reliability_penalty_multiplier: 1, ...p },
  ...o,
})

// ---------------------------------------------------------------------------
// 1. The price of a bundle is built on its cheapest usable offer, the one orders go to
// ---------------------------------------------------------------------------
describe('bundle price: the cheapest usable offer is the basis', () => {
  const po = (id: string, cost: number, o: Partial<PricingOffer> = {}): PricingOffer => ({
    id, service_id: 's', provider_id: `p-${id}`, provider_service_id: `ps-${id}`, cost_per_1000: cost, min_quantity: 10, max_quantity: 1000,
    refill_supported: true, is_active: true, provider_service_active: true, provider_active: true, routing_enabled: true, ...o,
  })

  it('takes the lowest cost among offers that can receive an order, ignoring the ones that cannot', () => {
    expect(serviceCostBasis([po('a', 0.5), po('b', 0.8), po('c', 0.6)])?.cost).toBe(0.5)
    expect(serviceCostBasis([po('a', 0.5), po('dead', 0.1, { is_active: false }), po('off', 0.2, { routing_enabled: false }), po('gone', 0.3, { provider_service_active: false })])?.cost).toBe(0.5)
  })

  it('a cheaper provider lowers the price; the router picks it, and the dearer one cannot take an order at that price', () => {
    const rules: PriceRule[] = [{ id: 'r', type: 'percentage', value: 100, platform: null, category_id: null, service_id: null, min_rate: null, max_rate: null, name_all: null, name_any: null, priority: 0, is_active: true } as unknown as PriceRule]
    const service: BundleServiceRow = { id: 'svc', name: 'Telegram views', category_id: 'cat', platform: 'telegram', customer_rate_per_1000: 2 }
    const alone = bundlePrice(service, [offerRow('a', 1)], rules)
    const withCheaper = bundlePrice(service, [offerRow('a', 1), offerRow('b', 0.4)], rules)
    expect(alone.newRate).toBe(2) // x2 on 1.00
    expect(withCheaper.basisCost).toBe(0.4) // the cheaper offer sets the price
    expect(withCheaper.newRate).toBe(0.8)
    const order = bundleOffers([offerRow('a', 1), offerRow('b', 0.4)], withCheaper.newRate)
    expect(order[0]).toMatchObject({ offerId: 'b', rank: 1 })
    expect(order[1]).toMatchObject({ offerId: 'a', rank: null, blockedBy: 'above_price' })
  })

  it('never sells under cost: an offer dearer than the price is blocked, the price only covers the cheapest', () => {
    const rows = [offerRow('a', 0.4), offerRow('b', 1.2), offerRow('c', 0.9)]
    const price = bundlePrice({ id: 'svc', name: 'x', category_id: 'c', platform: 'telegram', customer_rate_per_1000: 1 }, rows, [])
    expect(price.newRate).toBe(1) // no rule applies: the price stays, it is above the floor of the cheapest (0.42)
    const out = bundleOffers(rows, price.newRate)
    expect(out.filter((o) => o.rank !== null).map((o) => o.offerId)).toEqual(['a', 'c'])
    expect(out.find((o) => o.offerId === 'b')).toMatchObject({ rank: null, blockedBy: 'above_price' })
  })
})

describe('bundle routing order mirrors rankOffers', () => {
  it('ranks routable offers by effective cost (penalty; the score only breaks a tie), and explains every blocked one', () => {
    const rows = [
      offerRow('cheap-flaky', 0.5, {}, { reliability_penalty_multiplier: 3 }), // effective 1.5
      offerRow('mid', 0.8), // effective 0.8
      offerRow('scored', 0.82, { routing_score: 1000 }), // effective 0.82: the score is no discount
      offerRow('off', 0.1, {}, { routing_enabled: false }),
      offerRow('down', 0.1, {}, { health_status: 'unavailable' }),
      offerRow('frozen', 0.1, { anomaly_detected: true, is_active: false }),
      offerRow('gone', 0.1, { provider_service: { external_service_id: 'x', name: 'x', is_active: false } }),
      offerRow('dear', 5),
    ]
    const out = bundleOffers(rows, 2)
    expect(out.filter((o) => o.rank !== null).map((o) => o.offerId)).toEqual(['mid', 'scored', 'cheap-flaky'])
    expect(Object.fromEntries(out.filter((o) => o.blockedBy).map((o) => [o.offerId, o.blockedBy]))).toEqual({
      off: 'routing_off', down: 'unhealthy', frozen: 'anomaly', gone: 'panel_removed', dear: 'above_price',
    })
    // the same order the router uses for a real order
    const domain = rows.filter((r) => r.provider_service?.is_active).map((r) => ({
      id: r.id, serviceId: 'svc', providerId: r.provider_id, providerServiceId: r.provider_service_id, costPer1000: Number(r.cost_per_1000),
      minQuantity: 10, maxQuantity: 100000, refillSupported: false, cancelSupported: false, isActive: r.is_active, routingScore: r.routing_score, createdAt: '', updatedAt: '',
    }))
    const providers = rows.map((r) => ({
      id: r.provider_id, name: r.provider!.name, apiUrl: '', apiVersion: 'v2', isActive: r.provider!.is_active, routingEnabled: r.provider!.routing_enabled,
      healthStatus: r.provider!.health_status as 'healthy', lastHealthCheck: null, lastBalanceSync: null, providerBalance: 50, currency: 'USD', priority: 0,
      reliabilityPenalty: Number(r.provider!.reliability_penalty_multiplier),
    }))
    expect(rankOffers(domain, providers, { maxCostPer1000: 2 }).map((o) => o.id)).toEqual(['mid', 'scored', 'cheap-flaky'])
  })
})

// ---------------------------------------------------------------------------
// 2. catalog_mode: a linked_only provider never publishes its catalogue
// ---------------------------------------------------------------------------
describe('catalog_mode in the catalogue sync', () => {
  class Store implements CatalogStore {
    published = 0
    upserted = 0
    async loadProviderServices() { return [] }
    async upsertProviderServices(rows: Array<{ external_service_id: string }>) { this.upserted += rows.length; return rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })) }
    async flagAnomaly() {}
    async loadOffers() { return [] }
    async updateOffers() {}
    async deactivateProviderServices() {}
    async loadLinkedServices() { return [] }
    async loadServiceOffers() { return [] }
    async updateServices() {}
    async saveBalance() {}
    async loadPlatformSlugs() { return ['telegram', 'other'] }
    async publishServices(_p: string, rows: unknown[]) { this.published += rows.length; return { categories_changed: 1, services_created: rows.length, services_updated: 0 } }
  }
  const run = (mode: 'publish' | 'linked_only' | undefined) => {
    const store = new Store()
    const catalogue = [panel('1', { name: 'Просмотры постов Telegram' }), panel('2', { name: 'Просмотры постов Telegram [быстро]' })]
    return syncProviderCatalog({
      provider: { id: 'prov', name: 'Panel', routing_enabled: true, ...(mode ? { catalog_mode: mode } : {}) },
      adapter: { getServices: async () => catalogue, getBalance: async () => ({ balance: 1, currency: 'USD' }) },
      store, rules: [], log: silentLogger,
    }).then((report) => ({ report, store }))
  }

  it('linked_only imports the catalogue (searchable) but puts NOTHING on the storefront, even with routing on', async () => {
    const { store, report } = await run('linked_only')
    expect(store.upserted).toBe(2)
    expect(store.published).toBe(0)
    expect(report.published).toBeUndefined()
  })
  it('publish (and a provider without the field, as before) keeps publishing', async () => {
    expect((await run('publish')).store.published).toBe(2)
    expect((await run(undefined)).store.published).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 3. LINK_BY_EXTERNAL_ID
// ---------------------------------------------------------------------------
describe('LINK_BY_EXTERNAL_ID', () => {
  const ports = (over: Partial<LinkPorts> = {}) => {
    const calls: string[] = []
    const p: LinkPorts = {
      loadProvider: async (id) => (id === 'prov-1' ? { id, name: 'SMMPWR', is_active: true } : null),
      fetchPanelServices: async () => { calls.push('fetch'); return [panel('880'), panel(' 881', { ratePer1000: 0.42, minQuantity: 50, maxQuantity: 5000, name: 'TG views fast' })] },
      saveProviderService: async (_p, s) => { calls.push(`save:${s.externalServiceId}:${s.ratePer1000}`); return 'ps-881' },
      link: async (ps, svc, score) => { calls.push(`link:${ps}:${svc}:${score}`); return 'offer-1' },
      reprice: async () => { calls.push('reprice'); return { basisCost: 1, currentRate: 2, newRate: 2, changed: false } },
      ...over,
    }
    return { p, calls }
  }

  it('fetches the panel NOW, stores its current cost and limits, links, then re-prices', async () => {
    const { p, calls } = ports()
    const r = await linkByExternalId({ serviceId: 'svc-x', providerId: 'prov-1', externalServiceId: '881', routingScore: null }, p)
    expect(calls).toEqual(['fetch', 'save: 881:0.42', 'link:ps-881:svc-x:null', 'reprice'])
    expect(r).toMatchObject({ offerId: 'offer-1', providerServiceId: 'ps-881', panel: { externalServiceId: ' 881', costPer1000: 0.42, minQuantity: 50, maxQuantity: 5000 } })
  })

  it('refuses an unknown provider, a switched-off one and a service number the panel does not have, before writing anything', async () => {
    const { p, calls } = ports({ loadProvider: async (id) => (id === 'off' ? { id, name: 'Off', is_active: false } : null) })
    await expect(linkByExternalId({ serviceId: 's', providerId: 'nope', externalServiceId: '1', routingScore: null }, p)).rejects.toMatchObject({ status: 404, code: 'provider_not_found' })
    await expect(linkByExternalId({ serviceId: 's', providerId: 'off', externalServiceId: '1', routingScore: null }, p)).rejects.toMatchObject({ status: 409, code: 'provider_inactive' })
    const { p: p2, calls: c2 } = ports()
    await expect(linkByExternalId({ serviceId: 's', providerId: 'prov-1', externalServiceId: '999', routingScore: null }, p2)).rejects.toBeInstanceOf(BundleError)
    expect([...calls, ...c2]).toEqual(['fetch']) // nothing saved or linked
  })

  it('finds a panel service whatever type the panel used for its id', () => {
    expect(findPanelService([panel('42')], '42')?.externalServiceId).toBe('42')
    expect(findPanelService([{ ...panel('x'), externalServiceId: 42 as unknown as string }], ' 42 ')).not.toBeNull()
    expect(findPanelService([panel('42')], '4')).toBeNull()
  })

  it('validates the new requests', () => {
    const svc = '00000000-0000-4000-8000-000000000001', prov = '00000000-0000-4000-8000-000000000002'
    expect(parseMappingRequest({ action: 'LINK_BY_EXTERNAL_ID', serviceId: svc, providerId: prov, externalServiceId: 881 })).toMatchObject({ externalServiceId: '881', routingScore: null })
    expect(parseMappingRequest({ action: 'LINK_BY_EXTERNAL_ID', serviceId: svc, providerId: prov, externalServiceId: '8 81' })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LINK_BY_EXTERNAL_ID', serviceId: 'x', providerId: prov, externalServiceId: '1' })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LIST_SERVICE_OFFERS', serviceId: svc })).toEqual({ action: 'LIST_SERVICE_OFFERS', serviceId: svc })
    expect(parseMappingRequest({ action: 'UNLINK_OFFER', offerId: svc })).toEqual({ action: 'UNLINK_OFFER', offerId: svc })
    expect(parseMappingRequest({ action: 'SEARCH_SERVICES', search: '' })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'SEARCH_SERVICES', search: 'views' })).toEqual({ action: 'SEARCH_SERVICES', search: 'views', limit: 20 })
  })
})

// ---------------------------------------------------------------------------
// 4. The database: catalog_mode column and admin_upsert_provider
// ---------------------------------------------------------------------------
describe('catalog_mode in the database', () => {
  let db: PGlite
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }, 120_000)
  afterAll(async () => { await db.close() })

  it('a new provider is linked_only; admin_upsert_provider sets and keeps the mode; nonsense is refused', async () => {
    const admin = (await db.query<{ id: string }>(`insert into users (telegram_id, is_admin) values (555, true) returning id`)).rows[0].id
    const created = (await db.query<{ r: Record<string, unknown> }>(`select admin_upsert_provider($1, null, 'Panel X', 'https://x.example/api/v2') r`, [admin])).rows[0].r
    expect(created.catalog_mode).toBe('linked_only')
    const id = String(created.id)
    const pub = (await db.query<{ r: Record<string, unknown> }>(`select admin_upsert_provider($1, $2, p_catalog_mode => 'publish') r`, [admin, id])).rows[0].r
    expect(pub.catalog_mode).toBe('publish')
    const kept = (await db.query<{ r: Record<string, unknown> }>(`select admin_upsert_provider($1, $2, p_priority => 7) r`, [admin, id])).rows[0].r
    expect(kept.catalog_mode).toBe('publish')
    await expect(db.query(`select admin_upsert_provider($1, $2, p_catalog_mode => 'everything')`, [admin, id])).rejects.toThrow(/catalogMode/)
    await expect(db.query(`update providers set catalog_mode = 'all' where id = $1`, [id])).rejects.toThrow(/providers_catalog_mode_check/)
    const listed = (await db.query<{ r: Array<Record<string, unknown>> }>(`select admin_providers_list($1) r`, [admin])).rows[0].r
    expect(listed.find((p) => p.id === id)?.catalog_mode).toBe('publish')
  })

  it('the migration keeps "publish" only for providers whose catalogue is already on the storefront', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261121000000_catalog_mode.sql'), 'utf8')
    expect(sql).toMatch(/default 'linked_only'/)
    expect(sql).toMatch(/set catalog_mode = 'publish'[\s\S]*s\.auto_published/)
  })
})

// ---------------------------------------------------------------------------
// 5. Admin API and form
// ---------------------------------------------------------------------------
describe('catalogMode through the admin API and the provider form', () => {
  it('parses, validates and returns the mode', () => {
    const id = '00000000-0000-4000-8000-000000000003'
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', id, catalogMode: 'publish' })).toMatchObject({ catalogMode: 'publish' })
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', id, catalogMode: 'all' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', name: 'New', apiUrl: 'https://new.example.com/api/v2' })).toMatchObject({ catalogMode: null })
    expect(toProviderDto({ catalog_mode: 'publish' }).catalogMode).toBe('publish')
    expect(toProviderDto({}).catalogMode).toBe('linked_only')
  })
  it('the form sends the mode only when it changes', () => {
    const p = { id: 'p1', name: 'P', slug: 'p', apiUrl: 'https://p.example/api/v2', apiVersion: 'v2', isActive: true, routingEnabled: true, priority: 0, catalogMode: 'linked_only', healthStatus: 'healthy', lastHealthCheck: null, balance: 1, currency: 'USD', lastBalanceSync: null, lowBalanceThreshold: 1, targetTopupBalance: 2, reliabilityPenalty: 1, hasApiKey: true, createdAt: '', updatedAt: '' } as AdminProvider
    expect(checkProviderDraft(draftOf(p), p).request).toBeNull()
    expect(checkProviderDraft({ ...draftOf(p), catalogMode: 'publish' }, p).request).toEqual({ action: 'UPSERT_PROVIDER', id: 'p1', catalogMode: 'publish' })
  })
})
