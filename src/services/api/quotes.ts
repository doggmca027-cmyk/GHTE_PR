import type { AuthSession } from '@/services/api/auth'
import { mockQuote } from './mock-quote'
import { QuoteApiError } from './quote-errors'
import type { Quote, QuoteErrorCode, QuoteRequest } from '@/types/quote'

export { QuoteApiError }

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const QUOTE_TIMEOUT_MS = 10_000

const KNOWN: readonly QuoteErrorCode[] = ['promo_not_found', 'promo_expired', 'promo_exhausted', 'promo_already_used', 'promo_not_applicable', 'service_unavailable', 'invalid_input']

/** Asks the `quote-order` Edge Function for the price this customer would be charged. Read-only: nothing is spent or redeemed. */
export async function getQuote(session: AuthSession, request: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  if (session.isMock) return mockQuote(request)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new QuoteApiError('server', 'Backend is not configured.')

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/quote-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ serviceId: request.serviceId, quantity: request.quantity, ...(request.promoCode ? { promoCode: request.promoCode } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(QUOTE_TIMEOUT_MS)]) : AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError' && signal?.aborted) throw e // superseded by a newer request: not an error
    throw new QuoteApiError('network', 'Could not refresh the price.')
  }

  const body = (await res.json().catch(() => null)) as (Partial<Quote> & { success?: boolean; error?: string; message?: string }) | null
  if (res.ok && body?.success && typeof body.finalPrice === 'number' && typeof body.listPrice === 'number') {
    return {
      listPrice: body.listPrice,
      tier: body.tier ?? { slug: null, percentage: 0, discount: 0 },
      promo: body.promo ?? { applied: false, discount: 0 },
      finalPrice: body.finalPrice,
      totalDiscount: body.totalDiscount ?? 0,
      discountReduced: body.discountReduced === true,
    }
  }
  if (res.status === 401) throw new QuoteApiError('unauthorized', 'Please reopen the app.')
  const code = KNOWN.find((c) => c === body?.error)
  if (code) throw new QuoteApiError(code, body?.message ?? 'Could not price this order.')
  throw new QuoteApiError('server', 'Could not refresh the price.')
}
