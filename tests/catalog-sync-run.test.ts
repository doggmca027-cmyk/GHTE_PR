// The catalog sync end to end, through the IProviderAdapter contract (MockProviderAdapter) and an in-memory CatalogStore.
import { describe, expect, it } from 'vitest'
import { syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run.ts'
import {
  planOfferSync,
  type ExistingOffer,
  type ExistingProviderService,
  type LinkedService,
  type OfferRow,
  type ProviderServiceRow,
  type ServiceRow,
} from '../supabase/functions/_shared/catalog-sync.ts'
import { silentLogger } from '../supabase/functions/_shared/logger.ts'
import { MockProviderAdapter } from '../supabase/functions/_shared/providers/index.ts'
import type { PricingOffer } from '../supabase/functions/_shared/service-cost.ts'
import type { IProviderService, PriceRule } from '../supabase/functions/_shared/types.ts'

const PROVIDER = { id: 'prov-1', name: 'Mock panel' }
const OTHER = 'prov-2'
const rules: PriceRule[] = [{ id: 'g', type: 'percentage', value: 150, priority: 0, is_active: true }]

const svc = (id: string, o: Partial<IProviderService> = {}): IProviderService => ({
  externalServiceId: id, name: `Service ${id}`, type: 'Default', categoryRaw: 'Telegram Views', ratePer1000: 1,
  minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false, ...o,
})

type StoredOffer = Omit<ExistingOffer, 'source'> & { is_active: boolean }

/** In-memory tables behaving like the real ones for what the sync touches (no DB triggers: the sync itself must do the work). */
class MemoryStore implements CatalogStore {
  ps = new Map<string, ExistingProviderService & { provider_id: string }>()
  services = new Map<string, LinkedService>()
  offers = new Map<string, StoredOffer>()
  providers = new Map<string, { is_active: boolean; routing_enabled: boolean }>([
    [PROVIDER.id, { is_active: true, routing_enabled: true }],
    [OTHER, { is_active: true, routing_enabled: true }],
  ])
  anomalies: string[] = []
  balance: number | null = null
  writes: string[] = []
  private seq = 0

  addPS(ext: string, o: Partial<ExistingProviderService> & { provider_id?: string } = {}) {
    const row = {
      id: `ps-${ext}`, external_service_id: ext, name: `Service ${ext}`, category_raw: 'Telegram Views', rate_per_1000: 1,
      min_quantity: 10, max_quantity: 1000, refill_supported: false, cancel_supported: false, is_active: true, provider_id: PROVIDER.id, ...o,
    }
    this.ps.set(row.id, row)
    return row
  }
  addService(id: string, psId: string, o: Partial<LinkedService> = {}) {
    this.services.set(id, {
      id, category_id: 'cat-1', name: `Storefront ${id}`, description: null, primary_provider_service_id: psId, fallback_provider_service_id: null,
      customer_rate_per_1000: 2.5, min_quantity: 10, max_quantity: 1000, is_active: true, sort_order: 0, refill_supported: false, platform: 'telegram', ...o,
    })
  }
  addOffer(id: string, serviceId: string, psId: string, o: Partial<StoredOffer> = {}) {
    const p = this.ps.get(psId)!
    this.offers.set(id, {
      id, service_id: serviceId, provider_id: p.provider_id, provider_service_id: psId, cost_per_1000: p.rate_per_1000,
      min_quantity: p.min_quantity, max_quantity: p.max_quantity, refill_supported: p.refill_supported, cancel_supported: p.cancel_supported,
      is_active: true, ...o,
    })
  }

  async loadProviderServices(providerId: string) {
    return [...this.ps.values()].filter((e) => e.provider_id === providerId).map(({ provider_id: _p, ...e }) => e)
  }
  async upsertProviderServices(rows: ProviderServiceRow[]) {
    this.writes.push('provider_services')
    return rows.map((r) => {
      const prev = [...this.ps.values()].find((e) => e.provider_id === r.provider_id && e.external_service_id === r.external_service_id)
      const id = prev?.id ?? `ps-new-${++this.seq}-${r.external_service_id}`
      this.ps.set(id, { ...r, id })
      return { id, external_service_id: r.external_service_id }
    })
  }
  async flagAnomaly(a: { providerServiceId: string }) {
    this.anomalies.push(a.providerServiceId)
    for (const o of this.offers.values()) if (o.provider_service_id === a.providerServiceId) o.is_active = false
  }
  async loadOffers(providerId: string): Promise<ExistingOffer[]> {
    return [...this.offers.values()].filter((o) => o.provider_id === providerId).map(({ is_active: _a, ...o }) => {
      const p = this.ps.get(o.provider_service_id)!
      return { ...o, source: { rate_per_1000: p.rate_per_1000, min_quantity: p.min_quantity, max_quantity: p.max_quantity, refill_supported: p.refill_supported, cancel_supported: p.cancel_supported } }
    })
  }
  async updateOffers(rows: OfferRow[]) {
    this.writes.push('offers')
    for (const r of rows) this.offers.set(r.id, { ...this.offers.get(r.id)!, ...r })
  }
  async deactivateProviderServices(ids: string[]) {
    for (const id of ids) this.ps.get(id)!.is_active = false
  }
  async loadLinkedServices(providerId: string) {
    const ids = new Set([...this.offers.values()].filter((o) => o.provider_id === providerId).map((o) => o.service_id))
    return [...this.services.values()].filter((s) => ids.has(s.id)).map((s) => ({ ...s }))
  }
  async loadServiceOffers(serviceIds: string[]): Promise<PricingOffer[]> {
    return [...this.offers.values()].filter((o) => serviceIds.includes(o.service_id)).map((o) => {
      const pr = this.providers.get(o.provider_id)!
      return {
        id: o.id, service_id: o.service_id, provider_id: o.provider_id, provider_service_id: o.provider_service_id, cost_per_1000: o.cost_per_1000,
        min_quantity: o.min_quantity, max_quantity: o.max_quantity, refill_supported: o.refill_supported, is_active: o.is_active,
        provider_service_active: this.ps.get(o.provider_service_id)!.is_active, provider_active: pr.is_active, routing_enabled: pr.routing_enabled,
      }
    })
  }
  async updateServices(rows: ServiceRow[]) {
    this.writes.push('services')
    for (const r of rows) this.services.set(r.id, { ...this.services.get(r.id)!, ...r })
  }
  async saveBalance(_providerId: string, balance: number) {
    this.balance = balance
  }
}

const run = (store: MemoryStore, services: IProviderService[], adapter = new MockProviderAdapter({ id: PROVIDER.id, name: PROVIDER.name, services, balance: 42.5 })) =>
  syncProviderCatalog({ provider: PROVIDER, adapter, store, rules, log: silentLogger, now: () => new Date('2026-10-08T00:00:00.000Z') })

describe('syncProviderCatalog (through the IProviderAdapter contract)', () => {
  it('stores new provider services but never creates storefront services', async () => {
    const store = new MemoryStore()
    const report = await run(store, [svc('1'), svc('2', { ratePer1000: 3 })])
    expect(report).toMatchObject({ status: 'ok', added: 2, updated: 0, deactivated: 0 })
    expect([...store.ps.values()].map((p) => [p.external_service_id, p.is_active])).toEqual([['1', true], ['2', true]])
    expect(store.services.size).toBe(0)
    expect(store.offers.size).toBe(0)
    expect(store.balance).toBe(42.5)
  })

  it('updates price, limits and name of an existing provider service', async () => {
    const store = new MemoryStore()
    store.addPS('1')
    const report = await run(store, [svc('1', { name: 'Renamed', ratePer1000: 1.1, minQuantity: 20, maxQuantity: 900 })])
    expect(report).toMatchObject({ added: 0, updated: 1 })
    expect(store.ps.get('ps-1')).toMatchObject({ name: 'Renamed', rate_per_1000: 1.1, min_quantity: 20, max_quantity: 900, is_active: true })
  })

  it('soft-deletes services missing from the response: the provider service and the storefront service that lost its only offer go inactive, nothing is removed', async () => {
    const store = new MemoryStore()
    store.addPS('1'); store.addPS('2'); store.addPS('3')
    store.addService('s2', 'ps-2'); store.addOffer('o2', 's2', 'ps-2')
    store.addService('s3', 'ps-3'); store.addOffer('o3', 's3', 'ps-3')
    const report = await run(store, [svc('1')])
    expect(report).toMatchObject({ deactivated: 2, services: { deactivated: 2 } })
    expect(store.ps.size).toBe(3)
    expect([...store.ps.values()].map((p) => p.is_active)).toEqual([true, false, false])
    expect(store.services.get('s2')).toMatchObject({ is_active: false, customer_rate_per_1000: 2.5 })
    expect(store.services.get('s3')!.is_active).toBe(false)
    expect(store.offers.size).toBe(2)
  })

  it('a service that still has another usable offer stays on sale, priced from it', async () => {
    const store = new MemoryStore()
    store.addPS('1', { rate_per_1000: 1 }); store.addPS('b1', { provider_id: OTHER, rate_per_1000: 2 })
    store.addService('s1', 'ps-1', { customer_rate_per_1000: 2.5 })
    store.addOffer('o1', 's1', 'ps-1'); store.addOffer('ob', 's1', 'ps-b1')
    const report = await run(store, [svc('other')]) // this provider no longer lists service 1
    expect(report.services.deactivated).toBe(0)
    expect(store.services.get('s1')).toMatchObject({ is_active: true, customer_rate_per_1000: 5 }) // 2 x 2.5, the remaining offer
  })

  it('does not touch a storefront service that is already off, and reactivates it when the provider lists it again', async () => {
    const store = new MemoryStore()
    store.addPS('1', { is_active: false })
    store.addService('s1', 'ps-1', { is_active: false })
    store.addOffer('o1', 's1', 'ps-1')
    const report = await run(store, [svc('1', { ratePer1000: 1 })])
    expect(report.services.reactivated).toBe(1)
    expect(store.ps.get('ps-1')!.is_active).toBe(true)
    expect(store.services.get('s1')!.is_active).toBe(true)
  })

  it('re-prices a linked storefront service and propagates cost and limits to its offers', async () => {
    const store = new MemoryStore()
    store.addPS('1')
    store.addService('s1', 'ps-1', { customer_rate_per_1000: 2.5 })
    store.addOffer('o1', 's1', 'ps-1')
    const report = await run(store, [svc('1', { ratePer1000: 1.2, minQuantity: 50, maxQuantity: 800, refillSupported: true })])
    expect(store.services.get('s1')).toMatchObject({ customer_rate_per_1000: 3, min_quantity: 50, max_quantity: 800, refill_supported: true })
    expect(store.offers.get('o1')).toMatchObject({ cost_per_1000: 1.2, min_quantity: 50, max_quantity: 800, refill_supported: true, is_active: true })
    expect(report).toMatchObject({ services: { updated: 1, repriced: 1 } })
  })

  describe('dynamic pricing from the cheapest offer', () => {
    it('a cheaper offer from another provider lowers the price although the primary offer did not change', async () => {
      const store = new MemoryStore()
      store.addPS('1', { rate_per_1000: 1 }); store.addPS('b1', { provider_id: OTHER, rate_per_1000: 0.5 })
      store.addService('s1', 'ps-1', { customer_rate_per_1000: 2.5 }) // priced from the primary: 1 x 2.5
      store.addOffer('o1', 's1', 'ps-1'); store.addOffer('ob', 's1', 'ps-b1')
      const report = await run(store, [svc('1', { ratePer1000: 1 })])
      expect(store.services.get('s1')!.customer_rate_per_1000).toBe(1.25) // 0.5 x 2.5
      expect(store.services.get('s1')!.primary_provider_service_id).toBe('ps-1') // legacy column untouched
      expect(report.services.repriced).toBe(1)
    })

    it('the price follows when the dearer offer\'s panel cuts its price and becomes the cheapest', async () => {
      const store = new MemoryStore()
      store.addPS('1', { rate_per_1000: 1 }); store.addPS('b1', { provider_id: OTHER, rate_per_1000: 0.5 })
      store.addService('s1', 'ps-1', { customer_rate_per_1000: 1.25 })
      store.addOffer('o1', 's1', 'ps-1'); store.addOffer('ob', 's1', 'ps-b1')
      await run(store, [svc('1', { ratePer1000: 1 })])
      expect(store.services.get('s1')!.customer_rate_per_1000).toBe(1.25)
      await run(store, [svc('1', { ratePer1000: 0.7 })]) // -30%: accepted, 0.5 is still the cheapest
      expect(store.services.get('s1')!.customer_rate_per_1000).toBe(1.25)
      store.ps.get('ps-b1')!.rate_per_1000 = 0.9
      store.offers.get('ob')!.cost_per_1000 = 0.9
      await run(store, [svc('1', { ratePer1000: 0.7 })]) // now offer 1 (0.7) is the cheapest
      expect(store.services.get('s1')!.customer_rate_per_1000).toBe(1.75)
    })

    it('offers that cannot receive orders are not a base: suspended, inactive provider service, provider routing off, provider off', async () => {
      const store = new MemoryStore()
      store.addPS('1', { rate_per_1000: 1 })
      store.addPS('x1', { provider_id: OTHER, rate_per_1000: 0.1 })
      store.addPS('x2', { provider_id: OTHER, rate_per_1000: 0.1, is_active: false })
      store.addService('s1', 'ps-1', { customer_rate_per_1000: 99 })
      store.addOffer('o1', 's1', 'ps-1')
      store.addOffer('suspended', 's1', 'ps-x1', { is_active: false })
      store.addOffer('gone', 's1', 'ps-x2')
      const priced = async () => {
        store.services.get('s1')!.customer_rate_per_1000 = 99
        await run(store, [svc('1', { ratePer1000: 1 })])
        return store.services.get('s1')!.customer_rate_per_1000
      }
      expect(await priced()).toBe(2.5) // suspended + inactive provider service ignored
      store.offers.get('suspended')!.is_active = true
      store.providers.get(OTHER)!.routing_enabled = false
      expect(await priced()).toBe(2.5) // routing off
      store.providers.get(OTHER)!.routing_enabled = true
      store.providers.get(OTHER)!.is_active = false
      expect(await priced()).toBe(2.5) // provider off
      store.providers.get(OTHER)!.is_active = true
      expect(await priced()).toBe(0.25) // the 0.1 offer now counts
    })

    it('limits never exceed what the usable offers can deliver (their union), keeping a narrower admin choice', async () => {
      const store = new MemoryStore()
      store.addPS('1', { rate_per_1000: 1, min_quantity: 100, max_quantity: 1000 })
      store.addPS('b1', { provider_id: OTHER, rate_per_1000: 1, min_quantity: 5, max_quantity: 5000 })
      store.addService('s1', 'ps-1', { min_quantity: 1, max_quantity: 9999, customer_rate_per_1000: 2.5 })
      store.addService('s2', 'ps-1', { min_quantity: 200, max_quantity: 300, customer_rate_per_1000: 2.5 })
      for (const sid of ['s1', 's2']) { store.addOffer(`${sid}-a`, sid, 'ps-1'); store.addOffer(`${sid}-b`, sid, 'ps-b1') }
      await run(store, [svc('1', { ratePer1000: 1, minQuantity: 100, maxQuantity: 1000 })])
      expect(store.services.get('s1')).toMatchObject({ min_quantity: 5, max_quantity: 5000 }) // smallest min, largest max
      expect(store.services.get('s2')).toMatchObject({ min_quantity: 200, max_quantity: 300 }) // admin's narrower choice kept
    })

    it('the refill promise needs every usable offer to keep it', async () => {
      const store = new MemoryStore()
      store.addPS('1', { refill_supported: true }); store.addPS('b1', { provider_id: OTHER, refill_supported: false })
      store.addService('s1', 'ps-1', { refill_supported: true })
      store.addOffer('o1', 's1', 'ps-1'); store.addOffer('ob', 's1', 'ps-b1')
      await run(store, [svc('1', { refillSupported: true })])
      expect(store.services.get('s1')!.refill_supported).toBe(false)
    })
  })

  it('repairs an offer that drifted from its provider service, leaving is_active alone', async () => {
    const store = new MemoryStore()
    store.addPS('1', { rate_per_1000: 1 })
    store.addService('s1', 'ps-1', { customer_rate_per_1000: 2.5 })
    store.addOffer('o1', 's1', 'ps-1', { cost_per_1000: 0.5, max_quantity: 5 })
    store.offers.get('o1')!.is_active = false
    const report = await run(store, [svc('1', { ratePer1000: 1 })])
    expect(report.offers.synced).toBe(1)
    expect(store.offers.get('o1')).toMatchObject({ cost_per_1000: 1, max_quantity: 1000, is_active: false })
  })

  it('holds back a price jump above 30%: nothing is written for it, its offers are suspended and the storefront price stays', async () => {
    const store = new MemoryStore()
    store.addPS('1', { rate_per_1000: 1 })
    store.addService('s1', 'ps-1', { customer_rate_per_1000: 2.5 })
    store.addOffer('o1', 's1', 'ps-1')
    const report = await run(store, [svc('1', { ratePer1000: 5 })])
    expect(report.anomalies).toBe(1)
    expect(store.ps.get('ps-1')!.rate_per_1000).toBe(1)
    expect(store.services.get('s1')).toMatchObject({ customer_rate_per_1000: 2.5, is_active: true })
    expect(store.offers.get('o1')).toMatchObject({ cost_per_1000: 1, is_active: false })
    expect(store.anomalies).toEqual(['ps-1'])
  })

  it('an anomalous service is not treated as missing either', async () => {
    const store = new MemoryStore()
    store.addPS('1', { rate_per_1000: 1 })
    const report = await run(store, [svc('1', { ratePer1000: 5 }), svc('2')])
    expect(report.deactivated).toBe(0)
    expect(store.ps.get('ps-1')!.is_active).toBe(true)
  })

  it('refuses to deactivate more than half of a large catalogue (partial provider response)', async () => {
    const store = new MemoryStore()
    for (let i = 1; i <= 30; i++) store.addPS(String(i))
    store.addService('s1', 'ps-5'); store.addOffer('o5', 's1', 'ps-5')
    const report = await run(store, [svc('1'), svc('2')])
    expect(report.deactivated).toBe(0)
    expect(report.warning).toMatch(/deactivation skipped: 28\/30/)
    expect([...store.ps.values()].every((p) => p.is_active)).toBe(true)
    expect(store.services.get('s1')!.is_active).toBe(true)
  })

  it('an empty or invalid response changes nothing', async () => {
    const store = new MemoryStore()
    store.addPS('1')
    const report = await run(store, [svc('bad', { ratePer1000: -1 })])
    expect(report.status).toBe('skipped')
    expect(store.writes).toEqual([])
    expect(store.ps.get('ps-1')!.is_active).toBe(true)
  })

  it('a provider failure aborts the run before anything is written or deactivated', async () => {
    const store = new MemoryStore()
    store.addPS('1')
    const adapter = new MockProviderAdapter({ id: PROVIDER.id, name: PROVIDER.name, services: [svc('9')] })
    adapter.failNext('getServices', new Error('provider down'))
    await expect(run(store, [], adapter)).rejects.toThrow('provider down')
    expect(store.writes).toEqual([])
    expect(store.ps.get('ps-1')!.is_active).toBe(true)
  })

  it('a balance failure does not block the sync', async () => {
    const store = new MemoryStore()
    const adapter = new MockProviderAdapter({ id: PROVIDER.id, name: PROVIDER.name, services: [svc('1')] })
    adapter.failNext('getBalance', new Error('balance down'))
    expect((await run(store, [], adapter)).status).toBe('ok')
    expect(store.balance).toBeNull()
    expect(store.ps.size).toBe(1)
  })

  it('is idempotent: a second run over the same catalogue writes no services or offers', async () => {
    const store = new MemoryStore()
    store.addPS('1')
    store.addService('s1', 'ps-1', { customer_rate_per_1000: 2.5 })
    store.addOffer('o1', 's1', 'ps-1')
    const list = [svc('1', { ratePer1000: 1.2 })]
    await run(store, list)
    store.writes = []
    const again = await run(store, list)
    expect(again).toMatchObject({ added: 0, updated: 0, deactivated: 0, offers: { synced: 0 }, services: { updated: 0 } })
    expect(store.writes).toEqual(['provider_services'])
  })
})

describe('planOfferSync', () => {
  const offer = (o: Partial<ExistingOffer> = {}): ExistingOffer => ({
    id: 'o', service_id: 's', provider_id: 'p', provider_service_id: 'ps', cost_per_1000: 1, min_quantity: 10, max_quantity: 100,
    refill_supported: false, cancel_supported: false,
    source: { rate_per_1000: 1, min_quantity: 10, max_quantity: 100, refill_supported: false, cancel_supported: false }, ...o,
  })

  it('returns only the drifted offers, carrying the provider service values', () => {
    const rows = planOfferSync([
      offer({ id: 'same' }),
      offer({ id: 'noise', cost_per_1000: 1.00001 }),
      offer({ id: 'cost', cost_per_1000: 0.9 }),
      offer({ id: 'limits', max_quantity: 50 }),
      offer({ id: 'flags', cancel_supported: true }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['cost', 'limits', 'flags'])
    expect(rows[0]).toEqual({ id: 'cost', service_id: 's', provider_id: 'p', provider_service_id: 'ps', cost_per_1000: 1, min_quantity: 10, max_quantity: 100, refill_supported: false, cancel_supported: false })
  })
})
