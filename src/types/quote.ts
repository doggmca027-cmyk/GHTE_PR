// Request / response shapes of the quote-order Edge Function (POST, signed-in users).
// The quote is what place-order will charge: list price, minus the tier discount, minus the promo discount, reduced when the
// discounts would take the price under the platform's floor. Provider cost and the floor are never part of it.

export interface QuoteRequest {
  serviceId: string
  quantity: number
  /** Optional; the server upper-cases and validates it. */
  promoCode?: string
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
