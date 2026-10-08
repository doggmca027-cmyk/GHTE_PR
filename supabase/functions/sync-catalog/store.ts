// (Lives next to index.ts, not in _shared: it imports an npm: specifier, which the repo-wide tsc cannot resolve.)
// The Supabase/PostgREST implementation of the catalog sync's storage port (see catalog-sync-run.ts).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { CatalogStore } from '../_shared/catalog-sync-run.ts'
import type { ExistingOffer, ExistingProviderService, LinkedService, OfferSource } from '../_shared/catalog-sync.ts'
import type { Platform } from '../_shared/types.ts'

const PAGE = 1000
const WRITE_CHUNK = 500
const ID_CHUNK = 100

// deno-lint-ignore no-explicit-any
export type Db = SupabaseClient<any, 'public', any>

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

/** PostgREST caps responses at 1000 rows, so page through everything. */
async function fetchAll<T>(
  // the row shape is stated by the caller (T): PostgREST cannot infer it from a select string with embedded relations
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = must(await page(from, from + PAGE - 1), what) as T[]
    all.push(...rows)
    if (rows.length < PAGE) return all
  }
}

interface LinkedServiceRow extends Omit<LinkedService, 'platform'> {
  category: { platform: { slug: string } | null } | null
}

interface OfferJoinRow extends Omit<ExistingOffer, 'source' | 'cost_per_1000'> {
  cost_per_1000: number | string
  source: (Omit<OfferSource, 'rate_per_1000'> & { rate_per_1000: number | string }) | null
}

export function createSupabaseCatalogStore(db: Db): CatalogStore {
  return {
    loadProviderServices: (providerId) =>
      fetchAll<ExistingProviderService>(
        (from, to) =>
          db.from('provider_services')
            .select('id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported, is_active')
            .eq('provider_id', providerId).order('id').range(from, to),
        'load provider_services',
      ),

    async upsertProviderServices(rows) {
      const saved: { id: string; external_service_id: string }[] = []
      for (const part of chunks(rows, WRITE_CHUNK)) {
        saved.push(...(must(
          await db.from('provider_services').upsert(part, { onConflict: 'provider_id,external_service_id' }).select('id, external_service_id'),
          'upsert provider_services',
        ) as { id: string; external_service_id: string }[]))
      }
      return saved
    },

    async flagAnomaly(a) {
      must(await db.rpc('flag_catalog_anomaly', { p_provider_service_id: a.providerServiceId, p_reason: a.reason, p_observed: a.observed }), 'flag catalog anomaly')
    },

    async loadLinkedServices(providerId) {
      const rows = await fetchAll<LinkedServiceRow>(
        (from, to) =>
          db.from('services')
            .select('id, category_id, name, description, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active, sort_order, refill_supported, category:categories(platform:platforms(slug)), provider_service:primary_provider_service_id!inner(provider_id)')
            .eq('provider_service.provider_id', providerId).order('id').range(from, to),
        'load services',
      )
      return rows.map(({ category, ...s }) => ({
        ...s,
        customer_rate_per_1000: Number(s.customer_rate_per_1000),
        platform: (category?.platform?.slug ?? 'other') as Platform,
      }))
    },

    async updateServices(rows) {
      for (const part of chunks(rows, WRITE_CHUNK)) must(await db.from('services').upsert(part, { onConflict: 'id' }), 'update services')
    },

    async loadOffers(providerId) {
      const rows = await fetchAll<OfferJoinRow>(
        (from, to) =>
          db.from('provider_service_offers')
            .select('id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported, source:provider_services!pso_provider_service_fk(rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported)')
            .eq('provider_id', providerId).order('id').range(from, to),
        'load provider_service_offers',
      )
      return rows.flatMap(({ source, ...o }) =>
        source
          ? [{ ...o, cost_per_1000: Number(o.cost_per_1000), source: { ...source, rate_per_1000: Number(source.rate_per_1000) } }]
          : [])
    },

    async updateOffers(rows) {
      for (const part of chunks(rows, WRITE_CHUNK)) {
        must(await db.from('provider_service_offers').upsert(part, { onConflict: 'id' }), 'update provider_service_offers')
      }
    },

    async deactivateProviderServices(ids) {
      for (const part of chunks(ids, ID_CHUNK)) {
        must(await db.from('provider_services').update({ is_active: false }).in('id', part), 'deactivate provider_services')
      }
    },

    async deactivateServices(ids) {
      for (const part of chunks(ids, ID_CHUNK)) must(await db.from('services').update({ is_active: false }).in('id', part), 'deactivate services')
    },

    async saveBalance(providerId, balance) {
      must(await db.from('providers').update({ balance, balance_updated_at: new Date().toISOString() }).eq('id', providerId), 'save provider balance')
    },
  }
}
