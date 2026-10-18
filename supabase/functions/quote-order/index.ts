// Supabase Edge Function (Deno): POST /quote-order   (signed-in users and guests of the website)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   Body: { serviceId, quantity, promoCode?, runs? }   (drip-feed: quantity is the total, the offer limits hold for quantity / runs)
//   -> { success, listPrice, tier: { slug, percentage, discount }, promo: { applied, discount }, finalPrice, totalDiscount, discountReduced }
//
// The price the customer will be charged, from the same SQL function place_order uses (calculate_order_price): list price,
// minus the tier discount, minus the promo discount, with the discounts reduced when they would take the price under the
// provider cost plus the platform's minimum margin. Nothing is written and no promo use is consumed. The caller is always the
// JWT's user. Provider cost and the margin floor are never returned.
// The order is priced on the offer place-order will route this quantity to (the same router, routing.ts rankOffers) at that offer's
// retail rate (_shared/order-pricing.ts, migration 20261220000000), so the price shown is the price charged to the cent.
// volumeRates (the bulk prices) is the card's price ladder (price_ladder, migration 20261221000000): each volume step, and the quantity where
// another offer takes over (small orders through a dearer retail offer, then "from 250 · $1.19" where the cheapest one starts).
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { hasBearer, mapQuoteError, parseQuoteBody, toQuoteDto } from '../_shared/discounts.ts'
import { ladderSteps, loadPriceRules, offerRatePer1000, priceLadder, PRICED_SERVICE_COLUMNS, toPricedService, type PricedServiceRow } from '../_shared/order-pricing.ts'
import { OFFER_SELECT, buildCandidates, rankOffers, type OfferRow } from '../_shared/routing.ts'

Deno.serve(instrument('quote-order', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  // A guest of the website (no Authorization at all) gets the price list: volume steps, no tier discount, no promo code. A token that is
  // there but invalid is refused, so an expired session is asked to sign in again rather than shown guest prices.
  const guest = !hasBearer(req.headers.get('authorization'))
  const userId = guest ? null : await authenticate(req, jwtSecret)
  if (!guest && !userId) return fail(401, 'unauthorized', 'Sign in again.')
  if (userId) log.bind({ userId })

  const parsed = parseQuoteBody(await readJson(req))
  if (!parsed.ok) return fail(400, 'invalid_input', parsed.message)

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { serviceId, quantity } = parsed.value
  const runs = parsed.value.runs ?? 1
  const [{ data: service, error: serviceError }, { data: offerRows, error: offersError }, rules] = await Promise.all([
    db.from('services').select(PRICED_SERVICE_COLUMNS).eq('id', serviceId).maybeSingle(),
    db.from('provider_service_offers').select(OFFER_SELECT).eq('service_id', serviceId),
    loadPriceRules(db).catch((e: unknown) => e as Error),
  ])
  if (serviceError || offersError || rules instanceof Error) {
    log.error('quote lookup failed', { err: serviceError ?? offersError ?? rules, error_code: 'quote_failed' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
  if (!service || !service.is_active) return fail(404, 'service_unavailable', 'This service is no longer available.')
  // the offer place-order will take for this quantity: the same router with the same inputs
  const candidates = buildCandidates((offerRows ?? []) as unknown as OfferRow[])
  const offer = rankOffers(candidates.offers, candidates.providers, { quantity, runs })[0]
  if (!offer) return fail(503, 'service_unavailable', 'This service is temporarily unavailable.')
  const priced = toPricedService(service as unknown as PricedServiceRow)
  const rateOf = (o: { costPer1000: number }) => offerRatePer1000(priced, o.costPer1000, rules)
  // the ladder of a plain order (a drip-feed order keeps the steps of its own offer)
  const segments = runs === 1 ? priceLadder({ min: Number(service.min_quantity), max: Number(service.max_quantity) }, candidates.offers, candidates.providers, rateOf) : []
  const [{ data, error }, ladder] = await Promise.all([
    db.rpc('quote_order_price', {
      p_user_id: userId, p_service_id: serviceId, p_quantity: quantity, p_promo_code: guest ? null : parsed.value.promoCode,
      p_runs: runs, p_offer_id: offer.id, p_rate_per_1000: rateOf(offer),
    }),
    segments.length > 0
      ? db.rpc('price_ladder', { p_segments: segments.map(({ offerId: _offer, ...s }) => s) })
      : Promise.resolve({ data: null, error: null }),
  ])
  if (error) {
    const m = mapQuoteError(error.message)
    if (m.status === 500) log.error('quote failed', { err: error, error_code: 'quote_failed' })
    return fail(m.status, m.error, m.message)
  }
  const dto = toQuoteDto(data as Record<string, unknown>)
  // a ladder that could not be read leaves the steps of the quoted offer: the price itself never depends on it
  if (ladder.error) log.warn('price ladder failed', { err: ladder.error, error_code: 'price_ladder_failed' })
  const steps = Array.isArray(ladder.data) ? ladderSteps(ladder.data as { min_quantity: number; rate_per_1000: number }[]) : []
  return json({ success: true, ...dto, ...(steps.length > 0 ? { volumeRates: steps } : {}) })
}))
