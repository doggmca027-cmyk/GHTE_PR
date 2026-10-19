// What one order costs the customer per 1000: the retail rate of the offer that serves its quantity (migration 20261220000000). Shared by
// quote-order and place-order, so the price shown is the price charged. Pure except loadPriceRules.
//
// A card's own rate (services.customer_rate_per_1000) is built on its cheapest offer by the price rules (sync-catalog). An order whose
// quantity that offer takes pays exactly that rate. A quantity only another offer takes (a retail panel for small orders, a wholesale one
// for big ones) is priced on THAT offer's cost by the same rules (priceForBasis: x1.8, x1.5 from $5, never under cost + $0.02), so every
// quantity of the card's range can be sold, and always above its cost. The volume step is then applied on that offer's cost in SQL.

import { priceForBasis } from './catalog-sync.ts'
import { rankOffers } from './routing.ts'
import type { IProvider, IProviderServiceOffer, Platform, PriceRule } from './types.ts'

export interface PricedService {
  id: string
  category_id: string
  name: string
  platform: Platform
  customer_rate_per_1000: number
  /** The cost the card's rate was built on (sync-catalog); null when the sync has not priced it yet. */
  cost_basis_per_1000: number | null
}

const r4 = (n: number) => Math.round(Number(n) * 10_000)

/** The retail rate per 1000 of an order served by an offer costing `offerCostPer1000`. */
export function offerRatePer1000(service: PricedService, offerCostPer1000: number, rules: PriceRule[]): number {
  // the offer the card is priced on: the card's own rate, whatever made it (a rule, or an admin's price)
  if (service.cost_basis_per_1000 !== null && r4(service.cost_basis_per_1000) === r4(offerCostPer1000)) return service.customer_rate_per_1000
  return priceForBasis(service.customer_rate_per_1000, offerCostPer1000, rules, {
    serviceId: service.id, categoryId: service.category_id, platform: service.platform, serviceName: service.name,
  })
}

/** PostgREST select for PricedService (the platform is the joined slug). */
export const PRICED_SERVICE_COLUMNS = 'id, category_id, name, is_active, min_quantity, max_quantity, customer_rate_per_1000, cost_basis_per_1000, category:categories(platform:platforms(slug))'

export interface PricedServiceRow {
  id: string
  category_id: string
  name: string
  is_active: boolean
  min_quantity: number
  max_quantity: number
  customer_rate_per_1000: number | string
  cost_basis_per_1000: number | string | null
  category: { platform: { slug: string } | null } | null
}

export function toPricedService(r: PricedServiceRow): PricedService {
  return {
    id: r.id,
    category_id: r.category_id,
    name: r.name,
    platform: (r.category?.platform?.slug ?? 'other') as Platform,
    customer_rate_per_1000: Number(r.customer_rate_per_1000),
    cost_basis_per_1000: r.cost_basis_per_1000 == null ? null : Number(r.cost_basis_per_1000),
  }
}

// deno-lint-ignore no-explicit-any
type DbLike = { from(table: string): any }

/** The active price rules, as sync-catalog reads them. */
export async function loadPriceRules(db: DbLike): Promise<PriceRule[]> {
  const { data, error } = await db.from('price_rules')
    .select('id, type, value, platform:platforms(slug), category_id, service_id, min_rate, max_rate, min_markup, min_price, name_all, name_any, priority, is_active')
    .eq('is_active', true)
  if (error) throw new Error(`load price_rules: ${error.message}`)
  return ((data ?? []) as (Omit<PriceRule, 'platform'> & { platform: { slug: string } | null })[]).map((r) => ({
    ...r,
    platform: r.platform?.slug ?? null,
    value: Number(r.value),
    min_rate: r.min_rate == null ? null : Number(r.min_rate),
    max_rate: r.max_rate == null ? null : Number(r.max_rate),
    min_markup: r.min_markup == null ? null : Number(r.min_markup),
    min_price: r.min_price == null ? null : Number(r.min_price),
  })) as PriceRule[]
}

/** One quantity range of a card and the offer that serves it (price_ladder, migration 20261221000000). */
export interface LadderSegment {
  from: number
  to: number
  rate_per_1000: number
  basis_per_1000: number
  offerId: string
}

/**
 * Which offer serves which quantity range of the card, for a plain order (runs = 1): the same router as place-order. The offers that may
 * take an order change only where one of them starts (min) or stops (max + 1), so the range is cut there; next ranges served by the same
 * offer are joined, and a range nobody can serve is left out.
 */
export function priceLadder(
  limits: { min: number; max: number },
  offers: IProviderServiceOffer[],
  providers: IProvider[],
  rateOf: (offer: IProviderServiceOffer) => number,
): LadderSegment[] {
  const routable = rankOffers(offers, providers)
  const cuts = new Set<number>([limits.min])
  for (const o of routable) for (const q of [o.minQuantity, o.maxQuantity + 1]) if (q > limits.min && q <= limits.max) cuts.add(q)
  const starts = [...cuts].sort((a, b) => a - b)
  const out: LadderSegment[] = []
  starts.forEach((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] - 1 : limits.max
    const offer = rankOffers(routable, providers, { quantity: from })[0]
    if (!offer) return
    const last = out[out.length - 1]
    if (last && last.offerId === offer.id && last.to === from - 1) {
      last.to = to
      return
    }
    out.push({ from, to, rate_per_1000: rateOf(offer), basis_per_1000: offer.costPer1000, offerId: offer.id })
  })
  return out
}

/** price_ladder's answer as the quote's volume steps: a step at the same rate as the one before it says nothing new and is dropped. */
export function ladderSteps(rows: { min_quantity: number | string; rate_per_1000: number | string }[]): { minQuantity: number; ratePer1000: number }[] {
  const out: { minQuantity: number; ratePer1000: number }[] = []
  for (const r of rows) {
    const step = { minQuantity: Number(r.min_quantity), ratePer1000: Number(r.rate_per_1000) }
    if (out.length > 0 && out[out.length - 1].ratePer1000 === step.ratePer1000) continue
    out.push(step)
  }
  return out
}
