// Bundles: one storefront service sold through several providers (curated multi-provider routing). Pure logic + injected ports, so the
// admin-catalog-mapping Edge Function stays thin and every rule here is unit-testable.
//
//   * the ORDER the router will use (same rules as routing.ts rankOffers: eligible offers by effective cost, then the rest, with why)
//   * the PRICE of the bundle: priced on its MOST EXPENSIVE usable offer (service-cost.ts), so a failover never sells under cost and a
//     cheaper offer raises the margin instead of lowering the price
//   * LINK_BY_EXTERNAL_ID: "link panel service #881 of provider P to my service X" with the panel's CURRENT cost and limits

import { priceForBasis } from './catalog-sync.ts'
import { effectiveCost } from './routing.ts'
import { serviceCostBasis, toPricingOffer, type PricingOfferRow } from './service-cost.ts'
import type { IProviderService, Platform, PriceRule } from './types.ts'

export const BUNDLE_OFFER_COLUMNS =
  'id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, is_active, routing_score, ' +
  'anomaly_detected, anomaly_reason, provider_service:provider_services(external_service_id, name, is_active), ' +
  'provider:providers(id, name, is_active, routing_enabled, health_status, provider_balance, reliability_penalty_multiplier, catalog_mode)'

export interface BundleOfferRow {
  id: string
  service_id: string
  provider_id: string
  provider_service_id: string
  cost_per_1000: number | string
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  is_active: boolean
  routing_score: number
  anomaly_detected?: boolean
  anomaly_reason?: string | null
  provider_service: { external_service_id: string; name: string; is_active: boolean } | null
  provider: {
    id: string
    name: string
    is_active: boolean
    routing_enabled: boolean
    health_status: string
    provider_balance: number | string
    reliability_penalty_multiplier: number | string | null
    catalog_mode?: string
  } | null
}

/** Why an offer cannot receive a new order right now (checked in this order). null = it can. */
export type OfferBlock = 'anomaly' | 'offer_off' | 'panel_removed' | 'provider_off' | 'routing_off' | 'unhealthy' | 'above_price'

export interface BundleOffer {
  offerId: string
  providerId: string
  providerName: string
  externalServiceId: string
  panelName: string
  costPer1000: number
  minQuantity: number
  maxQuantity: number
  routingScore: number
  /** What the router compares: cost x reliability penalty x score bonus. */
  effectiveCost: number
  providerBalance: number
  blockedBy: OfferBlock | null
  /** 1 = the provider a new order goes to first; null when the offer cannot be routed. */
  rank: number | null
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000

function blockOf(r: BundleOfferRow, customerRate: number): OfferBlock | null {
  if (r.anomaly_detected) return 'anomaly'
  if (!r.is_active) return 'offer_off'
  if (!r.provider_service?.is_active) return 'panel_removed'
  if (!r.provider?.is_active) return 'provider_off'
  if (!r.provider.routing_enabled) return 'routing_off'
  if (r.provider.health_status !== 'healthy') return 'unhealthy'
  if (r4(Number(r.cost_per_1000)) > r4(customerRate)) return 'above_price'
  return null
}

/** The bundle in routing order: what can take an order (best first, exactly like rankOffers), then the rest by cost. */
export function bundleOffers(rows: BundleOfferRow[], customerRate: number): BundleOffer[] {
  const all = rows.map((r): BundleOffer => {
    const penalty = r.provider?.reliability_penalty_multiplier == null ? 1 : Number(r.provider.reliability_penalty_multiplier)
    const cost = Number(r.cost_per_1000)
    return {
      offerId: r.id,
      providerId: r.provider_id,
      providerName: r.provider?.name ?? '?',
      externalServiceId: r.provider_service?.external_service_id ?? '?',
      panelName: r.provider_service?.name ?? '',
      costPer1000: cost,
      minQuantity: r.min_quantity,
      maxQuantity: r.max_quantity,
      routingScore: r.routing_score,
      effectiveCost: r4(effectiveCost({ costPer1000: cost, routingScore: r.routing_score }, { reliabilityPenalty: penalty })),
      providerBalance: Number(r.provider?.provider_balance ?? 0),
      blockedBy: blockOf(r, customerRate),
      rank: null,
    }
  })
  const routable = all
    .filter((o) => o.blockedBy === null)
    .sort((a, b) => a.effectiveCost - b.effectiveCost || b.routingScore - a.routingScore || (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0))
  routable.forEach((o, i) => { o.rank = i + 1 })
  const rest = all.filter((o) => o.blockedBy !== null).sort((a, b) => a.costPer1000 - b.costPer1000)
  return [...routable, ...rest]
}

export interface BundleServiceRow {
  id: string
  name: string
  category_id: string
  platform: Platform
  customer_rate_per_1000: number
}

export interface BundlePrice {
  /** The cost the price is built on: the most expensive usable offer (null: no offer can take an order, the price is left alone). */
  basisCost: number | null
  currentRate: number
  newRate: number
  changed: boolean
}

/** The bundle's storefront price under the current rules: the same step the catalogue sync applies. */
export function bundlePrice(service: BundleServiceRow, rows: BundleOfferRow[], rules: PriceRule[]): BundlePrice {
  const current = Number(service.customer_rate_per_1000)
  const basis = serviceCostBasis(rows.map((r) => toPricingOffer(r as unknown as PricingOfferRow)))
  if (!basis) return { basisCost: null, currentRate: current, newRate: current, changed: false }
  const newRate = priceForBasis(current, basis.cost, rules, { serviceId: service.id, categoryId: service.category_id, platform: service.platform, serviceName: service.name })
  return { basisCost: basis.cost, currentRate: current, newRate, changed: r4(newRate) !== r4(current) }
}

/** The panel's service with this id (panels send numbers or strings). */
export function findPanelService(list: IProviderService[], externalServiceId: string): IProviderService | null {
  const wanted = externalServiceId.trim()
  return list.find((s) => String(s.externalServiceId).trim() === wanted) ?? null
}

// ---------------------------------------------------------------------------
// LINK_BY_EXTERNAL_ID
// ---------------------------------------------------------------------------

export class BundleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'BundleError'
  }
}

export interface LinkPorts {
  loadProvider(providerId: string): Promise<{ id: string; name: string; is_active: boolean } | null>
  /** The panel's whole service list, fetched NOW (SMM v2 has no single-service call). */
  fetchPanelServices(providerId: string): Promise<IProviderService[]>
  /** Stores the panel service with its current cost / limits; returns the provider_services id. */
  saveProviderService(providerId: string, service: IProviderService): Promise<string>
  /** admin_link_provider_service (limits overlap, duplicate check, audit). Throws BundleError on a business refusal. */
  link(providerServiceId: string, serviceId: string, routingScore: number | null): Promise<string>
  /** Applies the bundle price under the current rules; returns what happened. */
  reprice(serviceId: string): Promise<BundlePrice>
}

export interface LinkResult {
  offerId: string
  providerServiceId: string
  panel: { externalServiceId: string; name: string; costPer1000: number; minQuantity: number; maxQuantity: number }
  price: BundlePrice
}

export async function linkByExternalId(
  input: { serviceId: string; providerId: string; externalServiceId: string; routingScore: number | null },
  ports: LinkPorts,
): Promise<LinkResult> {
  const provider = await ports.loadProvider(input.providerId)
  if (!provider) throw new BundleError(404, 'provider_not_found', 'Provider not found.')
  if (!provider.is_active) throw new BundleError(409, 'provider_inactive', 'The provider is switched off.')
  const panel = findPanelService(await ports.fetchPanelServices(provider.id), input.externalServiceId)
  if (!panel) throw new BundleError(404, 'panel_service_not_found', `${provider.name} has no service #${input.externalServiceId.trim()}.`)
  const providerServiceId = await ports.saveProviderService(provider.id, panel)
  const offerId = await ports.link(providerServiceId, input.serviceId, input.routingScore)
  const price = await ports.reprice(input.serviceId)
  return {
    offerId,
    providerServiceId,
    panel: { externalServiceId: String(panel.externalServiceId), name: panel.name, costPer1000: panel.ratePer1000, minQuantity: panel.minQuantity, maxQuantity: panel.maxQuantity },
    price,
  }
}
