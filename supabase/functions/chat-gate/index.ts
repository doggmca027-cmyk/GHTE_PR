// Supabase Edge Function (Deno): POST /chat-gate   (called by the Vercel function api/chat.ts ONLY)
//   Header: x-chat-gate-secret: <CHAT_GATE_SECRET>
//   Body:   { action: 'check', ip, token? }                  -> 200 { ok, allowed, limit, remaining, retry_after }
//           { action: 'log',   ip, token?, entry: {...} }    -> 200 { ok }
//
// The assistant's hourly limit and its log live here because a Vercel Edge instance remembers nothing between two requests, and because the key
// of the database must not leave Supabase: Vercel holds the model's key and this shared secret, nothing else.
//   * check  counts one question against the caller's hour (20 by default) and says whether it may go on. The caller is the Telegram id in the
//            customer's token (verified here, with the project's JWT secret) or, for a guest, a keyed hash of the IP address.
//   * log    stores what was asked, what the assistant understood and which services it recommended (see _shared/chat-gate.ts for what is kept).
// Neither action is ever shown to a customer: if this function is down, the chat answers anyway (api/_lib/chat-gate.ts lets the question through).
// Secrets: CHAT_GATE_SECRET (32+ characters), JWT_SECRET; optional AI_CHAT_HOURLY_LIMIT. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { MAX_BODY_BYTES, WINDOW_SECONDS, gateAuthorized, hourlyLimit, identify, parseGateRequest } from '../_shared/chat-gate.ts'
import { corsHeaders, fail, instrument, json, readBoundedText } from '../_shared/http.ts'

Deno.serve(instrument('chat-gate', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const gateSecret = Deno.env.get('CHAT_GATE_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!gateSecret || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }
  if (!gateAuthorized(req.headers, gateSecret)) return fail(401, 'unauthorized', 'Not allowed.')

  const raw = await readBoundedText(req, MAX_BODY_BYTES)
  if (raw === null) return fail(413, 'too_large', 'Request too large.')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(400, 'invalid_input', 'Body must be JSON.')
  }
  const request = parseGateRequest(body)
  if (!request) return fail(400, 'invalid_input', 'Unknown action or an empty question.')

  const identifier = await identify(request, { jwtSecret: Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET'), gateSecret })
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  if (request.action === 'check') {
    const limit = hourlyLimit(Deno.env.get('AI_CHAT_HOURLY_LIMIT'))
    const { data, error } = await db.rpc('chat_rate_hit', { p_identifier: identifier, p_limit: limit, p_window_seconds: WINDOW_SECONDS })
    const verdict = data as { allowed?: unknown; limit?: unknown; remaining?: unknown; retry_after?: unknown } | null
    if (error || typeof verdict?.allowed !== 'boolean') {
      log.error('the limit could not be checked', { error_code: 'rate_check_failed' })
      return fail(503, 'unavailable', 'The limit could not be checked.')
    }
    if (!verdict.allowed) log.info('question limit reached', { kind: identifier.split(':')[0] }) // the kind of caller only, never who
    return json({ ok: true, allowed: verdict.allowed, limit: verdict.limit, remaining: verdict.remaining, retry_after: verdict.retry_after })
  }

  const { entry } = request
  const { error } = await db.rpc('record_ai_chat_log', {
    p_user_identifier: identifier,
    p_prompt: entry.prompt,
    p_intent: entry.intent,
    p_matched: entry.matched,
    p_recommended: entry.recommended,
    p_found_count: entry.found,
    p_tool_calls: entry.toolCalls,
    p_model: entry.model,
  })
  if (error) {
    log.error('the question was not logged', { error_code: 'log_failed' }) // never the question itself
    return fail(503, 'unavailable', 'The log could not be written.')
  }
  return json({ ok: true })
}))
