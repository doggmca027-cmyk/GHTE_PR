// Pure logic of the quote-order Edge Function: request parsing, mapping database errors to HTTP answers and the response shape.
// The maths themselves live in SQL (calculate_order_price) so a quote and a charge can never disagree; this file only translates.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROMO_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/

export interface QuoteInput {
  serviceId: string
  quantity: number
  promoCode: string | null
}

export function parseQuoteBody(raw: unknown): { ok: true; value: QuoteInput } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: 'Request body must be a JSON object.' }
  const b = raw as Record<string, unknown>
  if (typeof b.serviceId !== 'string' || !UUID_RE.test(b.serviceId)) return { ok: false, message: 'serviceId must be a UUID.' }
  if (typeof b.quantity !== 'number' || !Number.isSafeInteger(b.quantity) || b.quantity <= 0) return { ok: false, message: 'quantity must be a positive whole number.' }
  let promoCode: string | null = null
  if (b.promoCode !== undefined && b.promoCode !== null && b.promoCode !== '') {
    if (typeof b.promoCode !== 'string' || !PROMO_CODE_RE.test(b.promoCode.trim())) return { ok: false, message: 'promoCode must be 3-32 characters of A-Z a-z 0-9 _ -.' }
    promoCode = b.promoCode.trim().toUpperCase()
  }
  return { ok: true, value: { serviceId: b.serviceId.toLowerCase(), quantity: b.quantity, promoCode } }
}

/** A database error (message of the SQL exception) -> the HTTP answer. 500 means "not a business error". */
export function mapQuoteError(message: string): { status: number; error: string; message: string } {
  if (/promo_not_found/.test(message)) return { status: 404, error: 'promo_not_found', message: 'This promo code does not exist.' }
  if (/promo_inactive|promo_expired/.test(message)) return { status: 409, error: 'promo_expired', message: 'This promo code is no longer valid.' }
  if (/promo_exhausted/.test(message)) return { status: 409, error: 'promo_exhausted', message: 'This promo code has been used up.' }
  if (/promo_already_used/.test(message)) return { status: 409, error: 'promo_already_used', message: 'You have already used this promo code.' }
  if (/promo_not_applicable/.test(message)) return { status: 409, error: 'promo_not_applicable', message: 'This promo code cannot be applied to this order.' }
  if (/service not found or inactive/.test(message)) return { status: 404, error: 'service_unavailable', message: 'This service is no longer available.' }
  if (/service_unavailable|below_cost/.test(message)) return { status: 503, error: 'service_unavailable', message: 'This service is temporarily unavailable.' }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

const n = (v: unknown) => Number(v ?? 0)

/**
 * quote_order_price() -> what the app shows. Deliberately leaves out the provider cost and the margin floor: they are the
 * platform's, not the customer's.
 */
export function toQuoteDto(r: Record<string, unknown>) {
  const tier = n(r.tier_discount)
  const promo = n(r.promo_discount)
  return {
    listPrice: n(r.list_price),
    tier: { slug: (r.tier_slug as string | null) ?? null, percentage: n(r.tier_percentage), discount: tier },
    promo: { applied: promo > 0, discount: promo },
    finalPrice: n(r.final_price),
    totalDiscount: Math.round((tier + promo) * 10_000) / 10_000,
    /** The discounts were reduced to keep the price above the platform's floor. */
    discountReduced: r.capped === true,
  }
}
