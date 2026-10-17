// One provider's catalog sync, written against the adapter CONTRACT (IProviderAdapter) and a small storage port, so it runs
// unchanged against a real panel + Postgres (sync-catalog) or against MockProviderAdapter + an in-memory store (tests).
//
// What a run does, in this order, and what it never does:
//   1. getServices() from the adapter. A failure aborts the provider BEFORE anything is written or deactivated.
//   2. provider_services: upsert (new services appear, price / limits / names / flags are refreshed). A price move of any size is
//      applied (the storefront price follows in step 6); only a service whose data became impossible is held back and its offers
//      suspended. An offer suspended earlier whose provider service is valid again is switched back on (clearAnomalies).
//   3. provider_service_offers: cost, limits and flags are made equal to the provider service they are built on
//      (is_active, routing_score and the anomaly flags are never touched).
//   4. Soft delete: provider_services missing from the response get is_active = false (never deleted).
//   5. Storefront services that sell through this provider (they have an offer from it) are re-priced and re-limited from ALL their
//      offers: the base cost is the cheapest offer that can receive an order (service-cost.ts), not the legacy primary. A service
//      whose last usable offer was lost in this run is switched off; one whose provider service came back is switched on.
//      NEW provider services are NOT put on the storefront: they wait in provider_services until an admin links them
//      (admin-catalog-mapping).

import {
  LEGACY_PRICE_CHANGE_LIMIT,
  countLargePriceMoves,
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
import { buildCanonicalPublishRows, buildPublishRows, chooseGapFillers, isPublishable, referenceCells, type ExistingCategory, type PublishCandidate, type PublishRow } from './catalog-publish.ts'
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
/**
 * Services put on the storefront per run. An Edge Function has a couple of seconds of CPU per request and translating a name costs a fraction of
 * a millisecond, so a first catalogue of ten thousand services is taken in slices: the next hourly run (or a manual one) carries on.
 */
export const PUBLISH_BUDGET = 1500
/** Donor services a fill_gaps run names and writes into the storefront's empty places; the rest waits for the next run. */
export const FILL_BUDGET = 150
/** Storefront services rewritten per run (price and availability changes). Availability changes go first; the rest waits for the next run. */
export const MAX_SERVICE_UPDATES = 3000

/** Everything the run reads or writes. Implementations page and chunk as they need. */
export interface CatalogStore {
  loadProviderServices(providerId: string): Promise<ExistingProviderService[]>
  upsertProviderServices(rows: ProviderServiceRow[]): Promise<{ id: string; external_service_id: string }[]>
  flagAnomaly(anomaly: CatalogAnomaly): Promise<void>
  /**
   * Switches back on the offers of this provider that a guard suspended, except those of `keepProviderServiceIds` (still impossible in
   * this run), when their provider service is active: the new data was applied in this run. Returns how many. Optional.
   */
  clearAnomalies?(providerId: string, keepProviderServiceIds: string[]): Promise<number>
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
  /** The storefront's active categories with their platform (canonical publishing puts donor services into them). Optional. */
  loadCategories?(): Promise<ExistingCategory[]>
  /** Slugs of the platforms of the registry (a category on an unknown platform goes to "other"); `activeOnly`: the ones customers see. */
  loadPlatformSlugs?(activeOnly?: boolean): Promise<string[]>
  /** Every active service of the reference catalogue (platform slug, category and service name): the places it covers. Optional. */
  loadReferenceServices?(): Promise<{ platform: string; category: string; name: string }[]>
  /** Provider services of this provider that sell on the storefront now: an ACTIVE card, or an offer on one. Optional (without it: every offer). */
  loadSellingProviderServices?(providerId: string): Promise<string[]>
  /** A fill_gaps donor's services for the empty places (fill_storefront_gaps: twins back the existing card, the rest is published). Optional. */
  fillGaps?(providerId: string, rows: PublishRow[]): Promise<{ services_created: number; services_updated: number; linked: number; twins: number; reactivated: number }>
  /**
   * Refresh last_synced_at of every active row of the provider except `skipIds` (the ones the panel no longer lists), inside the database.
   * Optional: a store without it gets every row rewritten on every run.
   */
  touchProviderServices?(providerId: string, atIso: string, skipIds: string[]): Promise<void>
  /** Rebuilds the variant groups of the storefront (regroup_service_variants). Optional. */
  regroupVariants?(): Promise<{ groups: number; services_in_groups: number }>
  /** Smart Arbitrage matcher: links exact cheaper donor services, lists the rest. Optional; production runs it from pg_cron instead
   *  (run_arbitrage_matcher, migration 20261206000000), because it takes longer than an API request may. */
  refreshArbitrage?(): Promise<{ auto_linked?: number; pending?: number; skipped?: boolean }>
  /** Rebuilds services.dripfeed_available (refresh_service_dripfeed); returns how many services changed. Optional. */
  refreshDripFeed?(): Promise<number>
}

export interface SyncProviderInput {
  /** routing_enabled false: the catalogue is imported and kept current, but nothing of this provider is put on the storefront. */
  provider: { id: string; name: string; routing_enabled?: boolean; catalog_mode?: 'publish' | 'linked_only'; publish_mapping?: 'translate' | 'canonical'; fill_gaps?: boolean }
  adapter: CatalogAdapter
  store: CatalogStore
  rules: PriceRule[]
  log: Logger
  now?: () => Date
  /** Publish this slice of the catalogue (offset / count in the panel's order) instead of what is new or changed: for a manual re-publish after the translator improved. */
  republish?: { offset: number; limit: number }
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

  // 2b. Poisoned catalog protection: a service we already know whose data became impossible is held back (nothing of it is written
  //     or re-priced) and its offers are suspended. A price move, however large, is NOT an anomaly any more: it is written below and the
  //     storefront price follows it in step 6.
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

  // 3. Write provider_services (new ones are only stored here). With a store that can, only what is new or changed is sent: the rest has its
  //    last_synced_at refreshed inside the database, so an unchanged catalogue of tens of thousands of services costs almost nothing.
  const lean = typeof store.touchProviderServices === 'function'
  const changedExternal = new Set([...diff.added, ...diff.updated])
  const saved = await store.upsertProviderServices(lean ? diff.rows.filter((r) => changedExternal.has(r.external_service_id)) : diff.rows)
  if (lean) await store.touchProviderServices!(provider.id, nowIso, diff.missing.map((m) => m.id))
  report.added = diff.added.length
  report.updated = diff.updated.length

  // 3b. Offers a guard suspended earlier come back once their provider service is valid again (its new price was just written). They
  //     can only be routed after step 6 re-prices their service: routing never takes an offer that costs more than the customer pays.
  if (store.clearAnomalies) {
    const restored = await store.clearAnomalies(provider.id, anomalies.map((a) => a.providerServiceId))
    if (restored > 0) {
      report.anomaliesCleared = restored
      log.info('suspended offers restored with the current provider price', { providerId: provider.id, count: restored })
    }
  }
  const bigMoves = countLargePriceMoves(existingPS, valid, LEGACY_PRICE_CHANGE_LIMIT)
  if (bigMoves > 0) log.info('large provider price moves applied automatically', { providerId: provider.id, count: bigMoves })

  // 4. Offers: cost and limits follow the provider service, so routing always sees the real margin base.
  const providerOffers = await store.loadOffers(provider.id)
  const driftedOffers = planOfferSync(providerOffers)
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
  // linked_only: the catalogue is imported (searchable, guarded) but only what an admin links is sold; nothing is published.
  if (provider.routing_enabled !== false && provider.catalog_mode !== 'linked_only' && store.publishServices && store.loadPlatformSlugs) {
    try {
      const idByExternal = new Map([...existingPS.map((e) => [e.external_service_id, e.id] as const), ...saved.map((s) => [s.external_service_id, s.id] as const)])
      const candidates = valid.flatMap((s): PublishCandidate[] => {
        const id = idByExternal.get(s.externalServiceId)
        return id ? [{ id, name: s.name, categoryRaw: s.categoryRaw, serviceType: s.type ?? null, rate: s.ratePer1000, min: s.minQuantity, max: s.maxQuantity, description: s.description ?? null }] : []
      })
      // What needs doing: what is new or changed (changes first), within the budget; a manual slice overrides this.
      const onStorefront = new Set(providerOffers.map((o) => o.provider_service_id))
      const changedIds = new Set<string>()
      for (const ext of changedExternal) {
        const id = idByExternal.get(ext)
        if (id) changedIds.add(id)
      }
      let chosen: PublishCandidate[]
      let backlog = 0
      if (input.republish) {
        chosen = candidates.filter(isPublishable).slice(input.republish.offset, input.republish.offset + input.republish.limit)
      } else {
        const wanted = candidates.filter((c) => (!onStorefront.has(c.id) || changedIds.has(c.id)) && isPublishable(c))
        const ordered = [...wanted.filter((c) => changedIds.has(c.id)), ...wanted.filter((c) => !changedIds.has(c.id))]
        chosen = ordered.slice(0, PUBLISH_BUDGET)
        backlog = ordered.length - chosen.length
      }
      // an English donor catalogue goes into the storefront's platform + action categories (no near-duplicate categories)
      const slugs = new Set(await store.loadPlatformSlugs())
      const built = provider.publish_mapping === 'canonical' && store.loadCategories
        ? buildCanonicalPublishRows(chosen, slugs, await store.loadCategories())
        : buildPublishRows(chosen, slugs)
      const total = { created: 0, updated: 0, categories: 0 }
      for (let i = 0; i < built.rows.length; i += PUBLISH_CHUNK) {
        const r = await store.publishServices(provider.id, built.rows.slice(i, i + PUBLISH_CHUNK))
        total.created += r.services_created
        total.updated += r.services_updated
        total.categories += r.categories_changed
      }
      report.published = { ...total, skipped: candidates.length - candidates.filter(isPublishable).length, untranslatedServices: built.untranslatedServices, untranslatedCategories: built.untranslatedCategories, backlog }
    } catch (e) {
      log.error('publishing the catalogue failed', { err: e, providerId: provider.id, error_code: 'catalog_publish_failed' })
      report.warning = [report.warning, `publishing failed: ${e instanceof Error ? e.message : 'unknown error'}`].filter(Boolean).join('; ')
    }
  }

  // 5c. A donor with fill_gaps puts its services where the reference catalogue sells nothing: empty platforms and missing actions, at most
  //     FILL_PER_CELL per place (catalog-publish.ts). Twins of a card already on sale back that card instead. The new cards are priced in
  //     step 6 like every other card of this provider. A failure here is reported but never stops the pricing.
  let filledAny = false
  if (provider.routing_enabled !== false && provider.catalog_mode === 'linked_only' && provider.fill_gaps === true
    && store.fillGaps && store.loadReferenceServices && store.loadPlatformSlugs && store.loadCategories) {
    try {
      const fingerprintOf = new Map(existingPS.map((e) => [e.external_service_id, e.fingerprint ?? null] as const))
      const idOf = new Map([...existingPS.map((e) => [e.external_service_id, e.id] as const), ...saved.map((s) => [s.external_service_id, s.id] as const)])
      const candidates = valid.flatMap((s) => {
        const id = idOf.get(s.externalServiceId)
        return id ? [{ id, name: s.name, categoryRaw: s.categoryRaw, serviceType: s.type ?? null, rate: s.ratePer1000, min: s.minQuantity, max: s.maxQuantity, description: s.description ?? null, fingerprint: fingerprintOf.get(s.externalServiceId) ?? null }] : []
      })
      // only the platforms customers can see: a switched-off platform is never filled
      const slugs = new Set(await store.loadPlatformSlugs(true))
      const chosen = chooseGapFillers(candidates, slugs, referenceCells(await store.loadReferenceServices()))
      // what already sells through this provider (its card, or an offer on another card) needs nothing; the rest is named and written,
      // FILL_BUDGET per run (naming is the costly part: a big donor's first fill takes a few runs)
      // (a card the compaction hid does not sell: it is sent again and comes back)
      const offered = new Set(store.loadSellingProviderServices ? await store.loadSellingProviderServices(provider.id) : providerOffers.map((o) => o.provider_service_id))
      const pending = chosen.filter((c) => !offered.has(c.id))
      const built = buildCanonicalPublishRows(pending.slice(0, FILL_BUDGET), slugs, await store.loadCategories())
      const filled = { chosen: chosen.length, created: 0, updated: 0, linked: 0, twins: 0, reactivated: 0, backlog: Math.max(0, pending.length - FILL_BUDGET) }
      for (let i = 0; i < built.rows.length; i += PUBLISH_CHUNK) {
        const r = await store.fillGaps(provider.id, built.rows.slice(i, i + PUBLISH_CHUNK))
        filled.created += r.services_created ?? 0
        filled.updated += r.services_updated ?? 0
        filled.linked += r.linked ?? 0
        filled.twins += r.twins ?? 0
        filled.reactivated += r.reactivated ?? 0
      }
      report.filled = filled
      filledAny = filled.created + filled.reactivated + filled.linked > 0
    } catch (e) {
      log.error('filling the storefront gaps failed', { err: e, providerId: provider.id, error_code: 'catalog_fill_failed' })
      report.warning = [report.warning, `filling the gaps failed: ${e instanceof Error ? e.message : 'unknown error'}`].filter(Boolean).join('; ')
    }
  }

  // 6. Storefront services that sell through this provider: priced from their cheapest usable offer (read after steps 3-5, so a
  //    deactivated provider service, a suspended anomaly or a changed cost is already reflected).
  const reactivatedPsIds = new Set(existingPS.filter((e) => diff.reactivated.has(e.external_service_id)).map((e) => e.id))
  const linked = await store.loadLinkedServices(provider.id)
  const offersByService = groupByService(linked.length > 0 ? await store.loadServiceOffers(linked.map((s) => s.id)) : [])
  const planned: { row: ServiceRow; plan: ReturnType<typeof planService> }[] = []
  for (const service of linked) {
    const offers = offersByService.get(service.id) ?? []
    const plan = planService({
      existing: service,
      basis: serviceCostBasis(offers),
      rules,
      // a donor (linked_only) never switches a storefront service back on: one it published was taken off on purpose (migration
      // 20261207000000), and a reference card is the publishing provider's to bring back
      providerServiceReactivated: provider.catalog_mode !== 'linked_only' && offers.some((o) => reactivatedPsIds.has(o.provider_service_id)),
      offerLost: offers.some((o) => deactivatedPsIds.has(o.provider_service_id)),
    })
    if (plan.action !== 'update' || !plan.row) continue
    planned.push({ row: plan.row, plan })
  }
  // A run rewrites a bounded number of services. A service that must leave the storefront (or come back) goes before a price change;
  // whatever is left still differs from what it should be, so the next run picks it up.
  if (planned.length > MAX_SERVICE_UPDATES) {
    const availability = (p: { plan: ReturnType<typeof planService> }) => (p.plan.deactivated || p.plan.reactivated ? 0 : 1)
    planned.sort((a, b) => availability(a) - availability(b))
    report.services.deferred = planned.length - MAX_SERVICE_UPDATES
    planned.length = MAX_SERVICE_UPDATES
  }
  for (const { plan } of planned) {
    report.services.updated++
    if (plan.repriced) report.services.repriced++
    if (plan.reactivated) report.services.reactivated++
    if (plan.deactivated) report.services.deactivated++
  }
  if (planned.length > 0) await store.updateServices(planned.map((p) => p.row))

  // 7. Variant groups (Economy / Standard / Premium cards) follow what the storefront now sells. Only after a run of a provider that
  //    publishes its catalogue (or filled a gap); a failure here never fails the sync.
  if (provider.routing_enabled !== false && (provider.catalog_mode !== 'linked_only' || filledAny) && store.regroupVariants) {
    try {
      const g = await store.regroupVariants()
      report.variants = { groups: g.groups, services: g.services_in_groups }
    } catch (e) {
      log.warn('regrouping the service variants failed', { err: e, providerId: provider.id, error_code: 'regroup_failed' })
    }
  }

  // 8. Cheaper donor services for the storefront (at most hourly, whichever provider this run synced): exact matches are linked, the
  //    rest wait for an admin. Before step 9, so a new offer counts for drip-feed. A failure here never fails the sync.
  if (store.refreshArbitrage) {
    try {
      const a = await store.refreshArbitrage()
      if (!a.skipped) report.arbitrage = { autoLinked: a.auto_linked ?? 0, pending: a.pending ?? 0 }
    } catch (e) {
      log.warn('the arbitrage matcher failed', { err: e, providerId: provider.id, error_code: 'arbitrage_refresh_failed' })
    }
  }

  // 9. Which storefront services offer gradual delivery (drip-feed), from the flags this run may have changed. After every provider:
  //    a donor's offer counts too. A failure here never fails the sync.
  if (store.refreshDripFeed) {
    try {
      report.dripfeedChanged = await store.refreshDripFeed()
    } catch (e) {
      log.warn('refreshing the drip-feed flags of services failed', { err: e, providerId: provider.id, error_code: 'dripfeed_refresh_failed' })
    }
  }
  return report
}
