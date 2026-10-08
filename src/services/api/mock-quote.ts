// Offline price quote for dev mock mode. Mirrors the shape (and the order of operations) of the real engine: list price, minus the
// tier discount, minus the promo discount, in integer units of 1e-4. The demo customer is on Bronze (no tier discount, so the plain mock orders keep their list price); the only demo code is DEMO10.
import { MOCK_CATALOG } from '@/constants/dev'
import { UNITS_PER_CURRENCY, calcTotalUnits } from '@/lib/order-calc'
import type { Quote, QuoteRequest } from '@/types/quote'
import { QuoteApiError } from './quote-errors'

export const MOCK_TIER = { slug: 'bronze', percentage: 0 }
export const MOCK_PROMO_CODE = 'DEMO10'
const MOCK_PROMO_PERCENT = 10

const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d))

export function mockQuoteUnits(ratePer1000: number, quantity: number, promoCode?: string): { list: number; tier: number; promo: number; final: number } {
  const list = calcTotalUnits(quantity, ratePer1000)
  const tier = roundDiv(list * MOCK_TIER.percentage, 100)
  let promo = 0
  const code = promoCode?.trim().toUpperCase()
  if (code) {
    if (code !== MOCK_PROMO_CODE) throw new QuoteApiError('promo_not_found', 'This promo code does not exist.')
    promo = roundDiv((list - tier) * MOCK_PROMO_PERCENT, 100)
  }
  return { list, tier, promo, final: list - tier - promo }
}

export function mockQuote(request: QuoteRequest): Quote {
  const service = MOCK_CATALOG.services.find((s) => s.id === request.serviceId)
  if (!service) throw new QuoteApiError('service_unavailable', 'This service is no longer available.')
  const u = mockQuoteUnits(service.ratePer1000, request.quantity, request.promoCode)
  const per = (units: number) => units / UNITS_PER_CURRENCY
  return {
    listPrice: per(u.list),
    tier: { slug: MOCK_TIER.slug, percentage: MOCK_TIER.percentage, discount: per(u.tier) },
    promo: { applied: u.promo > 0, discount: per(u.promo) },
    finalPrice: per(u.final),
    totalDiscount: per(u.tier + u.promo),
    discountReduced: false,
  }
}
