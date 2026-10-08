// Supabase Edge Function (Deno): GET|POST /ad-webhook?provider=<adsgram|monetag|gigapub>&<the network's postback parameters>
//
// Server-to-server reward postbacks from the ad networks. Nothing the app (client) says is ever used to pay anyone.
//   1. the network is identified by ?provider=; its signing secret comes from the environment (ADSGRAM_SECRET, MONETAG_SECRET,
//      GIGAPUB_SECRET); a missing secret refuses everything (503), never accepts unsigned traffic
//   2. the signature is verified (HMAC-SHA-256 through Web Crypto, or MD5), in constant time; a wrong one is a 401
//   3. only the user and the network's transaction id are read. The payout is ad_providers.reward_amount in the database
//   4. process_ad_reward credits once per transaction id and enforces the rolling 24 h caps under a wallet lock
// Answers: 200 for credited, duplicate and soft-rejected (so the network stops retrying); 401/403-class only for bad signatures.
//
// Secrets: ADSGRAM_SECRET, MONETAG_SECRET, GIGAPUB_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { checkPostback } from '../_shared/ad-postback.ts'
import { fail, instrument, json } from '../_shared/http.ts'
import { registerSecret } from '../_shared/logger.ts'
import { AD_PROTOCOLS, secretEnvName } from '../_shared/ad-postback.ts'

const MAX_BODY_BYTES = 4096

/** Query parameters win; a POST body (form or JSON) fills in what the network sent there. */
async function collectParams(req: Request, url: URL): Promise<URLSearchParams | null> {
  const params = new URLSearchParams(url.searchParams)
  if (req.method !== 'POST') return params
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return null
  if (!raw) return params
  const type = req.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) {
      const body = JSON.parse(raw) as Record<string, unknown>
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body)) if ((typeof v === 'string' || typeof v === 'number') && !params.has(k)) params.set(k, String(v))
      }
    } else {
      for (const [k, v] of new URLSearchParams(raw)) if (!params.has(k)) params.set(k, v)
    }
  } catch {
    return null
  }
  return params
}

Deno.serve(instrument('ad-webhook', async (req: Request, { log }): Promise<Response> => {
  if (req.method !== 'GET' && req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use GET or POST.')

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const url = new URL(req.url)
  const params = await collectParams(req, url)
  if (!params) return fail(400, 'invalid_postback', 'Invalid request.')
  const provider = url.searchParams.get('provider')

  // Secrets must never reach a log line, whatever else is logged.
  for (const name of Object.keys(AD_PROTOCOLS)) registerSecret(Deno.env.get(secretEnvName(name)))

  const decision = await checkPostback(provider, params, Deno.env)
  if (!decision.ok) {
    // never the signature or the expected value
    log.warn('postback refused', { error_code: decision.error, provider: String(provider).slice(0, 30) })
    return fail(decision.status, decision.error, decision.status === 401 ? 'Invalid signature.' : 'Postback refused.')
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { data: user, error: userError } = await db.from('users').select('id').eq('telegram_id', decision.telegramId).maybeSingle()
  if (userError) {
    log.error('user lookup failed', { err: userError, error_code: 'user_lookup_failed' })
    return fail(500, 'server_error', 'Try again.') // the network retries; the reward is idempotent
  }
  if (!user) return json({ success: true, status: 'ignored', reason: 'unknown_user' }) // validly signed, but nobody to pay: stop retries

  const { data, error } = await db.rpc('process_ad_reward', { p_user_id: user.id, p_provider_id: decision.provider, p_external_tx_id: decision.txId })
  if (error) {
    if (/ad_provider_not_found/.test(error.message)) return fail(404, 'unknown_provider', 'Postback refused.')
    if (/ad_tx_conflict/.test(error.message)) {
      log.warn('transaction id used by another user', { error_code: 'ad_tx_conflict', provider: decision.provider })
      return json({ success: true, status: 'ignored', reason: 'tx_conflict' })
    }
    log.error('reward failed', { err: error, error_code: 'reward_failed', provider: decision.provider })
    return fail(500, 'server_error', 'Try again.')
  }
  const r = data as { status: string; reason?: string }
  log.info('ad postback processed', { userId: user.id, provider: decision.provider, status: r.status, reason: r.reason })
  return json({ success: true, status: r.status, ...(r.reason ? { reason: r.reason } : {}) })
}))
