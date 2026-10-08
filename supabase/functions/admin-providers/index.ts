// Supabase Edge Function (Deno): POST /admin-providers   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//
// Manages the provider pool. The API key never comes back: not in a response, not encrypted, not in a log.
//
//   { action: "LIST_PROVIDERS" }
//       -> { success, providers: [{ id, name, slug, apiUrl, apiVersion, isActive, routingEnabled, priority, healthStatus,
//                                   lastHealthCheck, balance, currency, lastBalanceSync, lowBalanceThreshold,
//                                   targetTopupBalance, reliabilityPenalty, hasApiKey, createdAt, updatedAt }] }
//   { action: "UPSERT_PROVIDER", id?, name?, apiUrl?, apiKey?, apiVersion?, priority?, isActive?, currency? }
//       -> { success, created, provider }
//          Without id: creates (name + apiUrl required; routing starts OFF). With id: updates only the fields sent. An empty or
//          missing apiKey keeps the stored key. apiUrl must be https and a public host.
//   { action: "TOGGLE_ROUTING", id, enabled }
//       -> { success, provider }     enabling needs an active provider with a stored key.
//
// Key handling: the raw apiKey is read from the POST body, encrypted here with AES-256-GCM (PROVIDER_KEY_SECRET, _shared/secrets.ts,
// the exact envelope the workers decrypt with), registered with the logger's redactor and then dropped. SQL receives ciphertext only.
//
// Auth: JWT verified here, then users.is_admin / not banned is checked in the function and AGAIN inside every SQL function
// (assert_catalog_admin). The SQL functions are service-role only.
// Secrets: JWT_SECRET, PROVIDER_KEY_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapProviderError, parseProviderRequest, toProviderDto } from '../_shared/admin-providers.ts'
import { registerSecret } from '../_shared/logger.ts'
import { encryptSecret } from '../_shared/secrets.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

Deno.serve(instrument('admin-providers', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Sign in again.')
  log.bind({ userId })

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  try {
    const admin = must(await db.from('users').select('id').eq('id', userId).eq('is_admin', true).eq('is_banned', false).maybeSingle(), 'admin check')
    if (!admin) return fail(403, 'forbidden', 'Admin access required.')

    const call = async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown } | { response: Response }> => {
      const { data, error } = await db.rpc(fn, args)
      if (error) {
        const m = mapProviderError(error.message)
        if (m.status === 500) throw new Error(`${fn}: ${error.message}`)
        return { response: fail(m.status, m.error, m.message) }
      }
      return { data }
    }

    const parsed = parseProviderRequest(await readJson(req))
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    if (parsed.action === 'LIST_PROVIDERS') {
      const r = await call('admin_providers_list', { p_actor: userId })
      if ('response' in r) return r.response
      return json({ success: true, providers: (r.data as Record<string, unknown>[]).map(toProviderDto) })
    }

    if (parsed.action === 'TOGGLE_ROUTING') {
      const r = await call('admin_set_provider_routing', { p_actor: userId, p_id: parsed.id, p_enabled: parsed.enabled })
      if ('response' in r) return r.response
      return json({ success: true, provider: toProviderDto(r.data as Record<string, unknown>) })
    }

    // ---- UPSERT_PROVIDER -----------------------------------------------------------------------------
    let apiKeyEncrypted: string | null = null
    if (parsed.apiKey !== null) {
      const master = Deno.env.get('PROVIDER_KEY_SECRET')
      if (!master) {
        // Refuse rather than store a key we cannot encrypt: nothing has been written.
        log.error('PROVIDER_KEY_SECRET is not set', { error_code: 'server_misconfigured' })
        return fail(500, 'server_misconfigured', 'Server is not configured.')
      }
      registerSecret(parsed.apiKey)
      apiKeyEncrypted = await encryptSecret(parsed.apiKey, master)
    }
    const r = await call('admin_upsert_provider', {
      p_actor: userId, p_id: parsed.id, p_name: parsed.name, p_api_url: parsed.apiUrl, p_api_key_encrypted: apiKeyEncrypted,
      p_api_version: parsed.apiVersion, p_priority: parsed.priority, p_is_active: parsed.isActive, p_currency: parsed.currency,
    })
    if ('response' in r) return r.response
    const row = r.data as Record<string, unknown>
    return json({ success: true, created: row.created === true, provider: toProviderDto(row) })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
