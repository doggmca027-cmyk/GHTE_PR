// Supabase Edge Function (Deno): POST /request-refill   (signed-in users)
//   Authorization: Bearer <JWT issued by telegram-auth or web-auth>
//   Body: { orderId }
//   -> 200 { success, refillStatus: "in_progress" }     the panel accepted the refill
//      202 { success, refillStatus: "requested" }       the panel's answer was lost: the request stands, nothing is repeated today
//      4xx { success: false, error, message }           not the caller's order, not delivered, no refill, too early, expired,
//                                                       once a day (retryAfter), or the panel refused (refill_refused)
//
// Every rule is checked under the order's lock in begin_order_refill(); the caller is always the JWT's user. The panel is asked
// with the order's own provider and provider order id; a refill is free for the customer (the guarantee is in the price).
// Secrets: JWT_SECRET, PROVIDER_KEY_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { registerSecret } from '../_shared/logger.ts'
import { mockModeEnabled } from '../_shared/mock-guard.ts'
import { parseRefillBody, requestRefill } from '../_shared/refill.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'

Deno.serve(instrument('request-refill', async (req: Request, { log, correlationId }): Promise<Response> => {
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

  const parsed = parseRefillBody(await readJson(req))
  if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const mock = mockModeEnabled(Deno.env)
  const answer = await requestRefill(userId, parsed.orderId, {
    async begin(user, order) {
      const { data, error } = await db.rpc('begin_order_refill', { p_user_id: user, p_order_id: order })
      if (error) throw new Error(error.message)
      return data as { provider_id: string; provider_order_id: string }
    },
    async createRefill(providerId, providerOrderId) {
      const { data: p, error } = await db.from('providers').select('id, name, api_url, api_key_encrypted').eq('id', providerId).single()
      if (error || !p) throw new Error(`load provider: ${error?.message ?? 'not found'}`)
      const apiKey = await resolveProviderApiKey(p, Deno.env)
      registerSecret(apiKey)
      // the offer this order went to says it supports refill (orders.refill_available), so the call is allowed for this panel
      const adapter = createSMMv2Adapter(
        { id: p.id, name: p.name, apiUrl: p.api_url, apiKey, correlationId, logger: log, capabilities: { supportsRefill: true } },
        { MOCK_MODE: mock ? 'true' : undefined },
      )
      return (await adapter.createRefill(providerOrderId)).refillId
    },
    async finish(order, ok, refillId) {
      const { error } = await db.rpc('finish_order_refill', { p_order_id: order, p_ok: ok, p_refill_id: refillId })
      if (error) log.error('could not record the refill answer', { err: error, error_code: 'refill_finish_failed', orderId: order })
    },
  }).catch((e) => {
    log.error('refill request failed', { err: e, error_code: 'refill_failed' })
    return { status: 500, body: { success: false, error: 'server_error', message: 'Something went wrong. Please try again.' } }
  })
  if (answer.status >= 400 && answer.status !== 500) log.info('refill refused', { reason: answer.body.error, orderId: parsed.orderId })
  return json(answer.body, answer.status)
}))
