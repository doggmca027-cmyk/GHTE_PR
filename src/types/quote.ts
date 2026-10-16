// Request / response shapes of the quote-order Edge Function (POST, signed-in users).
// The quote is what place-order will charge: list price, minus the tier discount, minus the promo discount, reduced when the
// discounts would take the price under the platform's floor. Provider cost and the floor are never part of it.

export interface QuoteRequest {
  serviceId: string
  quantity: number
  /** Optional; the server upper-cases and validates it. */
  promoCode?: string
  /** Drip-feed: number of deliveries (quantity is the total). Sent only when above 1. */
  runs?: number
}

export interface Quote {
  listPrice: number
  tier: { slug: string | null; percentage: number; discount: number }
  promo: { applied: boolean; discount: number }
  /** What the customer will be charged. */
  finalPrice: number
  totalDiscount: number
  /** The discounts were reduced to keep the price above the platform's floor. */
  discountReduced: boolean
  /** The rate per 1000 this quantity pays (lower than the retail rate on a bigger order when volume pricing is on). */
  ratePer1000?: number
  /** The retail rate per 1000 (the first volume step). */
  baseRatePer1000?: number
  /** Volume steps of this service: from minQuantity units, ratePer1000. Empty when volume pricing is off. */
  volumeRates?: { minQuantity: number; ratePer1000: number }[]
}

export type QuoteErrorCode =
  | 'promo_not_found'
  | 'promo_expired'
  | 'promo_exhausted'
  | 'promo_already_used'
  | 'promo_not_applicable'
  | 'service_unavailable'
  | 'invalid_input'
  | 'unauthorized'
  | 'network'
  | 'server'

/** What the order form shows in the price block. */
export type QuoteState =
  /** No valid quantity yet: nothing to price. */
  | { kind: 'idle' }
  /** A request is pending (or about to be sent); `previous` keeps the last price on screen so it does not flicker. */
  | { kind: 'loading'; previous: Quote | null }
  /** `promoError` is set when the code was refused: `quote` is then the price WITHOUT the code. */
  | { kind: 'ready'; quote: Quote; promoError: string | null }
  /** The quote could not be fetched; the form falls back to the list price and says it is an estimate. */
  | { kind: 'error'; message: string }
