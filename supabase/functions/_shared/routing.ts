// Provider routing: pick which provider offer fulfils an order. Pure functions, no I/O.
//
// Mode BALANCED (Phase 7). Offers are ranked by
//
//   effective_cost = cost_per_1000 x reliability_penalty x (1 - min(routing_score, 1000) / 10000)
//
//   * cost_per_1000        what the provider charges us (the price of the offer)
//   * reliability_penalty  >= 1, set by the provider health monitor: a flaky provider must be that much cheaper to win
//   * routing_score        the operator's preference, worth 0.01 % of the price per point: score 100 = a 1 % edge, the cap (1000) = 10 %
//   The score is a relative bonus, so it means the same for a 0.05 and a 5.00 service (a flat "cost - score x k" would let a
//   high score outweigh any price difference below k). Equal effective cost: the higher routingScore wins; still equal: the
//   lowest offer id, so the choice is deterministic.
//
// Who may be chosen at all:
//   1. only active offers whose provider is active, routing-enabled and healthy (degraded / unavailable / disabled providers never
//      receive new orders)
//   2. when the caller knows the price (maxCostPer1000 = services.customer_rate_per_1000), never an offer that costs more than the
//      customer pays: the price is built on the CHEAPEST offer, so a pricier one reached through a score bonus must not sell at a loss
//   3. only offers whose own limits take the quantity
// The caller refuses the order BEFORE charging when nothing qualifies, and tries the next offer when one refuses before sending.

import type { HealthStatus, IProvider, IProviderServiceOffer } from './types.ts'

export class ServiceUnavailableError extends Error {
  constructor(message = 'No provider can fulfil this service right now.') {
    super(message)
    this.name = 'ServiceUnavailableError'
  }
}

export const ROUTING_MODE = 'BALANCED'

/** routing_score above this counts as this. */
export const MAX_SCORE_BONUS_POINTS = 1000
/** Share of the price each score point is worth. */
export const SCORE_BONUS_PER_POINT = 0.0001

/** 1 for score 0 down to 0.9 for score 1000. Non-numbers and negatives count as 0. */
export function scoreFactor(routingScore: number | undefined): number {
  const points = Number.isFinite(routingScore) ? Math.min(Math.max(routingScore as number, 0), MAX_SCORE_BONUS_POINTS) : 0
  return 1 - points * SCORE_BONUS_PER_POINT
}

/** What an offer really costs us once reliability and the operator's preference are priced in. Ranking only: never charged or recorded. */
export function effectiveCost(
  offer: Pick<IProviderServiceOffer, 'costPer1000'> & { routingScore?: number },
  provider?: Pick<IProvider, 'reliabilityPenalty'>,
): number {
  const penalty = provider?.reliabilityPenalty ?? 1
  return offer.costPer1000 * (Number.isFinite(penalty) && penalty >= 1 ? penalty : 1) * scoreFactor(offer.routingScore)
}

// compared at 1e-8 so float noise (0.1 * 3) never decides between two offers
const ec = (offer: IProviderServiceOffer, providers: Map<string, IProvider>) => Math.round(effectiveCost(offer, providers.get(offer.providerId)) * 1e8)

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** Provider cost of `quantity` units, rounded exactly like place_order: round(cost_per_1000 * quantity / 1000, 4). */
export function costForQuantity(costPer1000: number, quantity: number): number {
  return round4((costPer1000 * quantity) / 1000)
}

export interface SelectOptions {
  /** Drop offers that cannot take this quantity (outside the offer's own min/max). */
  quantity?: number
  /** The customer's price per 1000 for this service: offers costing more than this are dropped (never sell at a loss). */
  maxCostPer1000?: number
}

/** Offers that may receive a NEW order, best first. */
export function rankOffers(offers: IProviderServiceOffer[], providers: IProvider[], opts: SelectOptions = {}): IProviderServiceOffer[] {
  const eligible = new Map(
    providers.filter((p) => p.isActive && p.routingEnabled && p.healthStatus === 'healthy').map((p) => [p.id, p]),
  )
  return offers
    .filter((o) => o.isActive && eligible.has(o.providerId))
    .filter((o) => opts.quantity === undefined || (opts.quantity >= o.minQuantity && opts.quantity <= o.maxQuantity))
    .filter((o) => opts.maxCostPer1000 === undefined || round4(o.costPer1000) <= round4(opts.maxCostPer1000))
    .sort((a, b) => ec(a, eligible) - ec(b, eligible) || b.routingScore - a.routingScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function selectBestOffer(offers: IProviderServiceOffer[], providers: IProvider[], opts: SelectOptions = {}): IProviderServiceOffer {
  const best = rankOffers(offers, providers, opts)[0]
  if (!best) throw new ServiceUnavailableError()
  return best
}

/**
 * The offer to use for a request. A replay of an order that already exists (pinnedOfferId = that order's
 * provider_offer_id) must keep going to the provider it was charged for, even if health has changed since;
 * only a brand-new order is routed. If that offer can no longer be used at all (deleted, or its provider service
 * was deactivated) the answer is "unavailable": a charged order is never silently re-sent to another provider.
 */
export function resolveOffer(
  offers: IProviderServiceOffer[],
  providers: IProvider[],
  opts: SelectOptions & { pinnedOfferId?: string | null } = {},
): IProviderServiceOffer {
  if (opts.pinnedOfferId) {
    const pinned = offers.find((o) => o.id === opts.pinnedOfferId)
    if (!pinned) throw new ServiceUnavailableError('The provider offer of this order is no longer available.')
    return pinned
  }
  return selectBestOffer(offers, providers, opts)
}

// ---------------------------------------------------------------------------
// Database rows -> domain objects
// ---------------------------------------------------------------------------

/** One row of: provider_service_offers + provider_services(external_service_id, is_active) + providers(...). */
export interface OfferRow {
  id: string
  service_id: string
  provider_id: string
  provider_service_id: string
  cost_per_1000: number | string
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  cancel_supported: boolean
  is_active: boolean
  routing_score: number
  created_at: string
  updated_at: string
  provider_service: { external_service_id: string; is_active: boolean } | null
  provider: {
    id: string
    name: string
    api_url: string
    api_key_encrypted: string | null
    api_version: string
    is_active: boolean
    routing_enabled: boolean
    health_status: HealthStatus
    last_health_check: string | null
    last_balance_sync: string | null
    provider_balance: number | string
    currency: string
    priority: number
    reliability_penalty_multiplier?: number | string
  } | null
}

/** Select list matching OfferRow (PostgREST embedded resources). */
export const OFFER_SELECT =
  'id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported, is_active, routing_score, created_at, updated_at, ' +
  'provider_service:provider_services(external_service_id, is_active), ' +
  'provider:providers(id, name, api_url, api_key_encrypted, api_version, is_active, routing_enabled, health_status, last_health_check, last_balance_sync, provider_balance, currency, priority, reliability_penalty_multiplier)'

export interface RoutingCandidates {
  offers: IProviderServiceOffer[]
  providers: IProvider[]
  /** Server-only details of an offer's provider, keyed by offer id (never part of the domain objects). */
  details: Map<string, { externalServiceId: string; apiUrl: string; apiKeyEncrypted: string | null; providerName: string }>
}

/** Offers whose provider service was deactivated by a catalogue sync cannot be ordered, so they are dropped here. */
export function buildCandidates(rows: OfferRow[]): RoutingCandidates {
  const offers: IProviderServiceOffer[] = []
  const providers = new Map<string, IProvider>()
  const details: RoutingCandidates['details'] = new Map()
  for (const r of rows) {
    if (!r.provider || !r.provider_service || !r.provider_service.is_active) continue
    offers.push({
      id: r.id,
      serviceId: r.service_id,
      providerId: r.provider_id,
      providerServiceId: r.provider_service_id,
      costPer1000: Number(r.cost_per_1000),
      minQuantity: r.min_quantity,
      maxQuantity: r.max_quantity,
      refillSupported: r.refill_supported,
      cancelSupported: r.cancel_supported,
      isActive: r.is_active,
      routingScore: r.routing_score,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })
    details.set(r.id, {
      externalServiceId: r.provider_service.external_service_id,
      apiUrl: r.provider.api_url,
      apiKeyEncrypted: r.provider.api_key_encrypted,
      providerName: r.provider.name,
    })
    const p = r.provider
    providers.set(p.id, {
      id: p.id,
      name: p.name,
      apiUrl: p.api_url,
      apiVersion: p.api_version,
      isActive: p.is_active,
      routingEnabled: p.routing_enabled,
      healthStatus: p.health_status,
      lastHealthCheck: p.last_health_check,
      lastBalanceSync: p.last_balance_sync,
      providerBalance: Number(p.provider_balance),
      currency: p.currency,
      priority: p.priority,
      reliabilityPenalty: p.reliability_penalty_multiplier == null ? 1 : Number(p.reliability_penalty_multiplier),
    })
  }
  return { offers, providers: [...providers.values()], details }
}
