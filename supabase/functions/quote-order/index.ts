// Supabase Edge Function (Deno): POST /quote-order   (signed-in users)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   Body: { serviceId, quantity, promoCode? }
//   -> { success, listPrice, tier: { slug, percentage, discount }, promo: { applied, discount }, finalPrice, totalDiscount, discountReduced }
//
// The price the customer will be charged, from the same SQL function place_order uses (calculate_order_price): list price,
// minus the tier discount, minus the promo discount, with the discounts reduced when they would take the price under the
// provider cost plus the platform's minimum margin. Nothing is written and no promo use is consumed. The caller is always the
// JWT's user. Provider cost and the margin floor are never returned.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapQuoteError, parseQuoteBody, toQuoteDto } from '../_shared/discounts.ts'

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

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Sign in again.')
  log.bind({ userId })

  const parsed = parseQuoteBody(await readJson(req))
  if (!parsed.ok) return fail(400, 'invalid_input', parsed.message)

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { data, error } = await db.rpc('quote_order_price', {
    p_user_id: userId, p_service_id: parsed.value.serviceId, p_quantity: parsed.value.quantity, p_promo_code: parsed.value.promoCode,
  })
  if (error) {
    const m = mapQuoteError(error.message)
    if (m.status === 500) log.error('quote failed', { err: error, error_code: 'quote_failed' })
    return fail(m.status, m.error, m.message)
  }
  return json({ success: true, ...toQuoteDto(data as Record<string, unknown>) })
}))
