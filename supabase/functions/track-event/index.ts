// Supabase Edge Function (Deno): POST /track-event   (signed-in users)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   Body: { name, properties? }   or   { events: [{ name, properties? }, ...] }   (at most 20 events, 8 KB)
//   -> 200 { ok: true, accepted: <how many will be stored> }
//
// UI funnel events (catalog_view, checkout_started, ...). Built to be cheap for the app and impossible to abuse:
//   * NON-BLOCKING   the answer is sent as soon as the body is cleaned; the insert runs in the background
//                    (EdgeRuntime.waitUntil) and its failure is only logged. Nothing here can slow or fail a user action.
//   * PRIVATE        only allow-listed event names and properties survive, each with its exact value shape (_shared/analytics.ts).
//                    No free text can be stored, so no link, handle, e-mail or promo code. No IP address or header is ever read.
//   * NOT FORGEABLE  money / account events are written by database triggers only; they are refused here.
//   * LIMITED        a per-user limiter here, and the hard cross-isolate limit inside record_client_events().
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { cleanBatch, createRateLimiter, MAX_BODY_BYTES } from '../_shared/analytics.ts'
import { authenticate, corsHeaders, fail, instrument, json } from '../_shared/http.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

const allow = createRateLimiter(60, 60_000)

Deno.serve(instrument('track-event', async (req: Request, { log }): Promise<Response> => {
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
  if (!allow(userId)) return fail(429, 'rate_limited', 'Too many events.')

  // Cheap checks first; a malformed body is a 400, never an exception.
  const raw = await req.text().catch(() => '')
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'Request too large.')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(400, 'invalid_input', 'Body must be JSON.')
  }

  const { events } = cleanBatch(body)
  if (events.length > 0) {
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    const write = (async () => {
      const { error } = await db.rpc('record_client_events', { p_user_id: userId, p_events: events.map((e) => ({ name: e.name, properties: e.properties })) })
      if (error) log.warn('client events not stored', { error_code: 'track_failed' })
    })().catch(() => log.warn('client events not stored', { error_code: 'track_failed' }))
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(write) // finishes after the response has gone out
  }
  return json({ ok: true, accepted: events.length })
}))
