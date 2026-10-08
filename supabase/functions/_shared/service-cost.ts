// What a storefront service costs us and what it can deliver, derived from its provider offers. Pure, no I/O.
//
// This is the single basis for pricing (sync-catalog and admin-pricing both call it): the base cost of a service is the CHEAPEST
// offer that can actually receive an order, not the cost of the legacy services.primary_provider_service_id. Linking a cheaper
// offer therefore lowers the base cost without touching primary / fallback.

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
  /** The lowest cost_per_1000 among the priceable offers: the number the markup is applied to. */
  cost: number
  /** The smallest min and the largest max among the priceable offers: the widest range any of them can take. */
  minQuantity: number
  maxQuantity: number
  /**
   * True only when EVERY priceable offer supports refill. The flag is a promise to the customer and the offer that will serve an
   * order is chosen later, so it is only made when any of them can keep it.
   */
  refillSupported: boolean
  offers: number
}

/** null when no offer can receive an order: the caller must then leave the price alone rather than guess. */
export function serviceCostBasis(offers: PricingOffer[]): CostBasis | null {
  const usable = offers.filter(isPriceableOffer)
  if (usable.length === 0) return null
  return {
    cost: Math.min(...usable.map((o) => Number(o.cost_per_1000))),
    minQuantity: Math.min(...usable.map((o) => o.min_quantity)),
    maxQuantity: Math.max(...usable.map((o) => o.max_quantity)),
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
