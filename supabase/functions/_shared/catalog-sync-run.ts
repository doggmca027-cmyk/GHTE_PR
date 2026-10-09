// One provider's catalog sync, written against the adapter CONTRACT (IProviderAdapter) and a small storage port, so it runs
// unchanged against a real panel + Postgres (sync-catalog) or against MockProviderAdapter + an in-memory store (tests).
//
// What a run does, in this order, and what it never does:
//   1. getServices() from the adapter. A failure aborts the provider BEFORE anything is written or deactivated.
//   2. provider_services: upsert (new services appear, price / limits / names / flags are refreshed).
//      Services whose price jumped more than 30 % or whose data became impossible are held back and their offers suspended.
//   3. provider_service_offers: cost, limits and flags are made equal to the provider service they are built on
//      (is_active, routing_score and the anomaly flags are never touched).
//   4. Soft delete: provider_services missing from the response get is_active = false (never deleted).
//   5. Storefront services that sell through this provider (they have an offer from it) are re-priced and re-limited from ALL their
//      offers: the base cost is the cheapest offer that can receive an order (service-cost.ts), not the legacy primary. A service
//      whose last usable offer was lost in this run is switched off; one whose provider service came back is switched on.
//      NEW provider services are NOT put on the storefront: they wait in provider_services until an admin links them
//      (admin-catalog-mapping).

import {
  detectCatalogAnomalies,
  diffProviderServices,
  emptyProviderReport,
  normalizeProviderServices,
  planOfferSync,
  planService,
  withoutAnomalies,
  type CatalogAnomaly,
  type ExistingOffer,
  type ExistingProviderService,
  type LinkedService,
  type OfferRow,
  type ProviderServiceRow,
  type ProviderSyncReport,
  type ServiceRow,
} from './catalog-sync.ts'
import { buildPublishRows, type PublishRow } from './catalog-publish.ts'
import type { Logger } from './logger.ts'
import type { IProviderAdapter } from './providers/contract.ts'
import { groupByService, serviceCostBasis, type PricingOffer } from './service-cost.ts'
import type { PriceRule } from './types.ts'

/** The only part of a provider the catalog sync needs: it never sees a panel's URL, key or wire format. */
export type CatalogAdapter = Pick<IProviderAdapter, 'getServices' | 'getBalance'>

/** Refuse to deactivate more than this share of a large catalogue in one run (guards against partial provider responses). */
export const MAX_DEACTIVATION_RATIO = 0.5
export const MIN_CATALOG_FOR_RATIO_GUARD = 20
/** Rows per publish_provider_services call (a few hundred KB of JSON). */
export const PUBLISH_CHUNK = 600

/** Everything the run reads or writes. Implementations page and chunk as they need. */
export interface CatalogStore {
  loadProviderServices(providerId: string): Promise<ExistingProviderService[]>
  upsertProviderServices(rows: ProviderServiceRow[]): Promise<{ id: string; external_service_id: string }[]>
  flagAnomaly(anomaly: CatalogAnomaly): Promise<void>
  /** Every offer of this provider with the current values of its provider_services row (read AFTER the upsert). */
  loadOffers(providerId: string): Promise<ExistingOffer[]>
  updateOffers(rows: OfferRow[]): Promise<void>
  deactivateProviderServices(ids: string[]): Promise<void>
  /** Storefront services that have at least one offer from this provider. */
  loadLinkedServices(providerId: string): Promise<LinkedService[]>
  /** ALL offers (any provider) of these services, with what decides whether each can receive an order. Read AFTER the writes above. */
  loadServiceOffers(serviceIds: string[]): Promise<PricingOffer[]>
  updateServices(rows: ServiceRow[]): Promise<void>
  saveBalance(providerId: string, balance: number): Promise<void>
  /** Put the provider's qualifying services on the storefront (publish_provider_services). Optional: a store without it publishes nothing. */
  publishServices?(providerId: string, rows: PublishRow[]): Promise<{ categories_changed: number; services_created: number; services_updated: number }>
  /** Slugs of the platforms of the registry (a category on an unknown platform goes to "other"). */
  loadPlatformSlugs?(): Promise<string[]>
}

export interface SyncProviderInput {
  /** routing_enabled false: the catalogue is imported and kept current, but nothing of this provider is put on the storefront. */
  provider: { id: string; name: string; routing_enabled?: boolean }
  adapter: CatalogAdapter
  store: CatalogStore
  rules: PriceRule[]
  log: Logger
  now?: () => Date
}

export async function syncProviderCatalog(input: SyncProviderInput): Promise<ProviderSyncReport> {
  const { provider, adapter, store, rules, log } = input
  const report = emptyProviderReport(provider.name)

  // 1. Fetch. Any failure here aborts this provider BEFORE anything is written or deactivated.
  const normalized = normalizeProviderServices(await adapter.getServices())
  const { skipped } = normalized
  let valid = normalized.valid
  report.skippedInvalid = skipped.length
  if (valid.length === 0) {
    report.status = 'skipped'
    report.error = 'provider returned no valid services; nothing changed'
    return report
  }

  // Cache the provider's balance for the admin dashboard (best effort: never blocks the catalog sync).
  try {
    const { balance } = await adapter.getBalance()
    await store.saveBalance(provider.id, balance)
  } catch (e) {
    log.warn('could not refresh the provider balance', { err: e, providerId: provider.id, error_code: 'balance_refresh_failed' })
  }

  // 2. Diff provider_services.
  const existingPS = await store.loadProviderServices(provider.id)
  const nowIso = (input.now?.() ?? new Date()).toISOString()
  let diff = diffProviderServices(provider.id, existingPS, valid, nowIso)

  // 2b. Poisoned catalog protection: a service we already know whose price jumped more than 30%, or whose data became
  //     impossible, is held back (nothing of it is written or re-priced) and its offers are suspended for an admin.
  const anomalies = detectCatalogAnomalies(existingPS, valid, skipped)
  if (anomalies.length > 0) {
    ;({ diff, valid } = withoutAnomalies(diff, valid, anomalies))
    for (const a of anomalies) await store.flagAnomaly(a)
    report.anomalies = anomalies.length
    log.warn('services held back as catalog anomalies', { providerId: provider.id, count: anomalies.length, error_code: 'catalog_anomaly' })
  }

  const activeBefore = existingPS.filter((e) => e.is_active).length
  const deactivationBlocked =
    activeBefore >= MIN_CATALOG_FOR_RATIO_GUARD && diff.missing.length / activeBefore > MAX_DEACTIVATION_RATIO
  if (deactivationBlocked) {
    report.warning = `deactivation skipped: ${diff.missing.length}/${activeBefore} services missing from provider response`
  }

  // 3. Upsert provider_services (new ones are only stored, never put on the storefront).
  const saved = await store.upsertProviderServices(diff.rows)
  report.added = diff.added.length
  report.updated = diff.updated.length

  // 4. Offers: cost and limits follow the provider service, so routing always sees the real margin base.
  const driftedOffers = planOfferSync(await store.loadOffers(provider.id))
  if (driftedOffers.length > 0) await store.updateOffers(driftedOffers)
  report.offers.synced = driftedOffers.length

  // 5. Soft delete what disappeared. Rows are kept so orders / history stay intact.
  const deactivatedPsIds = new Set<string>()
  if (!deactivationBlocked && diff.missing.length > 0) {
    const missingIds = diff.missing.map((m) => m.id)
    await store.deactivateProviderServices(missingIds)
    for (const id of missingIds) deactivatedPsIds.add(id)
    report.deactivated = missingIds.length
  }

  // 5b. Publish: every service of this provider that can be sold as it is gets a storefront service (new ones appear, renamed ones are
  //     refreshed). A failure here is reported but never stops the pricing of what is already on the storefront.
  if (provider.routing_enabled !== false && store.publishServices && store.loadPlatformSlugs) {
    try {
      const idByExternal = new Map(saved.map((s) => [s.external_service_id, s.id]))
      const candidates = valid.flatMap((s) => {
        const id = idByExternal.get(s.externalServiceId)
        return id ? [{ id, name: s.name, categoryRaw: s.categoryRaw, serviceType: s.type ?? null, rate: s.ratePer1000, min: s.minQuantity, max: s.maxQuantity }] : []
      })
      const built = buildPublishRows(candidates, new Set(await store.loadPlatformSlugs()))
      const total = { created: 0, updated: 0, categories: 0 }
      for (let i = 0; i < built.rows.length; i += PUBLISH_CHUNK) {
        const r = await store.publishServices(provider.id, built.rows.slice(i, i + PUBLISH_CHUNK))
        total.created += r.services_created
        total.updated += r.services_updated
        total.categories += r.categories_changed
      }
      report.published = { ...total, skipped: built.skipped, untranslatedServices: built.untranslatedServices, untranslatedCategories: built.untranslatedCategories }
    } catch (e) {
      log.error('publishing the catalogue failed', { err: e, providerId: provider.id, error_code: 'catalog_publish_failed' })
      report.warning = [report.warning, `publishing failed: ${e instanceof Error ? e.message : 'unknown error'}`].filter(Boolean).join('; ')
    }
  }

  // 6. Storefront services that sell through this provider: priced from their cheapest usable offer (read after steps 3-5, so a
  //    deactivated provider service, a suspended anomaly or a changed cost is already reflected).
  const reactivatedPsIds = new Set(existingPS.filter((e) => diff.reactivated.has(e.external_service_id)).map((e) => e.id))
  const linked = await store.loadLinkedServices(provider.id)
  const offersByService = groupByService(linked.length > 0 ? await store.loadServiceOffers(linked.map((s) => s.id)) : [])
  const toUpdate: ServiceRow[] = []
  for (const service of linked) {
    const offers = offersByService.get(service.id) ?? []
    const plan = planService({
      existing: service,
      basis: serviceCostBasis(offers),
      rules,
      providerServiceReactivated: offers.some((o) => reactivatedPsIds.has(o.provider_service_id)),
      offerLost: offers.some((o) => deactivatedPsIds.has(o.provider_service_id)),
    })
    if (plan.action !== 'update' || !plan.row) continue
    toUpdate.push(plan.row)
    report.services.updated++
    if (plan.repriced) report.services.repriced++
    if (plan.reactivated) report.services.reactivated++
    if (plan.deactivated) report.services.deactivated++
  }
  if (toUpdate.length > 0) await store.updateServices(toUpdate)
  return report
}
