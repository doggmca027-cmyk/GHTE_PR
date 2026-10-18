// What a storefront service costs us and what it can deliver, derived from its provider offers. Pure, no I/O.
//
// This is the single basis for pricing (sync-catalog, admin-pricing and the bundle editor all call it): the base cost of a service is the
// CHEAPEST offer that can actually receive an order, whichever provider it belongs to (every provider is an equal partner, there is no
// primary one). The router sends an order to that same cheapest offer, and when its provider has no money yet the order waits for the
// top-up in the order hub instead of going to a dearer provider (migration 20261218000000). A dearer offer is only used for a quantity the
// cheapest cannot take, and never when it costs more than the customer pays (routing.ts maxCostPer1000, hub_reroute_order).

/** One offer of a service together with the three facts that decide whether it can receive an order. */
export interface PricingOffer {
  id: string
  service_id: string
  provider_id: string
  provider_service_id: string
  cost_per_1000: number
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  /** The operator switch on the offer; the catalog anomaly guard turns it off too. */
  is_active: boolean
  /** The panel still lists the service (provider_services.is_active). */
  provider_service_active: boolean
  /** providers.is_active. */
  provider_active: boolean
  /** providers.routing_enabled: until it is on, the provider receives no orders, so its cost is not a base for the price. */
  routing_enabled: boolean
}

/**
 * An offer that can receive orders as far as the catalog is concerned. Health is deliberately NOT part of it: a provider that is
 * degraded for a few minutes must not move the customer price, while one that is switched off must.
 */
export const isPriceableOffer = (o: Pick<PricingOffer, 'is_active' | 'provider_service_active' | 'provider_active' | 'routing_enabled'>): boolean =>
  o.is_active && o.provider_service_active && o.provider_active && o.routing_enabled

export interface CostBasis {
  /** The LOWEST cost_per_1000 among the priceable offers: the number the markup is applied to (the offer the router picks). */
  cost: number
  /**
   * The smallest min among the priceable offers (a small retail order may go through a dearer offer with a lower minimum), and the largest
   * max among the offers that cost at most MAX_LIMIT_COST_SPREAD more than the cheapest: a quantity only a much dearer offer can take is
   * not offered at all (it would cost several times the card's price per 1000: 10 000 for $482, 10 001 for $1 963).
   */
  minQuantity: number
  maxQuantity: number
  /**
   * True only when EVERY priceable offer supports refill. The flag is a promise to the customer and the offer that will serve an
   * order is chosen later, so it is only made when any of them can keep it.
   */
  refillSupported: boolean
  offers: number
}

/** An offer more than this much dearer than the cheapest one does not raise the card's maximum quantity (it still lowers the minimum). */
export const MAX_LIMIT_COST_SPREAD = 0.3

/** null when no offer can receive an order: the caller must then leave the price alone rather than guess. */
export function serviceCostBasis(offers: PricingOffer[]): CostBasis | null {
  const usable = offers.filter(isPriceableOffer)
  if (usable.length === 0) return null
  const cost = Math.min(...usable.map((o) => Number(o.cost_per_1000)))
  // compared in ten-thousandths, so float noise never decides
  const near = usable.filter((o) => Math.round(Number(o.cost_per_1000) * 10_000) <= Math.round(cost * (1 + MAX_LIMIT_COST_SPREAD) * 10_000))
  return {
    cost,
    minQuantity: Math.min(...usable.map((o) => o.min_quantity)),
    maxQuantity: Math.max(...near.map((o) => o.max_quantity)),
    refillSupported: usable.every((o) => o.refill_supported),
    offers: usable.length,
  }
}

/** Groups offers by service id. */
export function groupByService(offers: PricingOffer[]): Map<string, PricingOffer[]> {
  const out = new Map<string, PricingOffer[]>()
  for (const o of offers) {
    const list = out.get(o.service_id)
    if (list) list.push(o)
    else out.set(o.service_id, [o])
  }
  return out
}

/** PostgREST embedded shape for a services query: `offers:provider_service_offers(<OFFER_PRICING_COLUMNS>)`. */
export const OFFER_PRICING_COLUMNS =
  'id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, is_active, ' +
  'provider_service:provider_services(is_active), provider:providers(is_active, routing_enabled)'

export interface PricingOfferRow {
  id: string
  service_id: string
  provider_id: string
  provider_service_id: string
  cost_per_1000: number | string
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  is_active: boolean
  provider_service: { is_active: boolean } | null
  provider: { is_active: boolean; routing_enabled: boolean } | null
}

/** A row selected with OFFER_PRICING_COLUMNS -> PricingOffer. A missing join counts as "cannot receive orders". */
export function toPricingOffer(r: PricingOfferRow): PricingOffer {
  return {
    id: r.id,
    service_id: r.service_id,
    provider_id: r.provider_id,
    provider_service_id: r.provider_service_id,
    cost_per_1000: Number(r.cost_per_1000),
    min_quantity: r.min_quantity,
    max_quantity: r.max_quantity,
    refill_supported: r.refill_supported,
    is_active: r.is_active,
    provider_service_active: r.provider_service?.is_active === true,
    provider_active: r.provider?.is_active === true,
    routing_enabled: r.provider?.routing_enabled === true,
  }
}
