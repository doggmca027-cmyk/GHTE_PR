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
//   { action: "ARBITRAGE_STATUS" }
//       -> { success, enabled, primary: [{ id, name, routingEnabled, healthStatus }], donors: [ArbitrageDonor] }
//   { action: "SET_ARBITRAGE_MODE", enabled }
//       -> { success, enabled, skipped: [{ id, name, reason }], donors: [{ id, name, isActive, routingEnabled, healthStatus,
//                                                                         balance, currency, lastBalanceSync, hasApiKey,
//                                                                         activeOffers, ready }] }
//          Donors are the providers with catalog_mode = 'linked_only'; the primary ('publish') is never touched.
//          enabled=false: every donor is switched off (routing off, health 'disabled') in one transaction.
//          enabled=true: the live balance of every active donor with a key is read from its panel first (in parallel, 8 s each),
//          then one transaction stores it and switches routing on: 'healthy' if the panel answered, even at a zero balance (the
//          router only sends what the balance covers and falls back to the primary), 'unavailable' if it did not.
//   { action: "ARBITRAGE_CANDIDATES", status?: pending|auto_linked|approved|rejected, offset? }
//       -> { success, items: [candidate], counts: { status: n }, refreshedAt }   cheaper donor services the matcher found (50 a page)
//   { action: "DECIDE_CANDIDATE", id, approve }   approve links the offer; reject (also of an automatic link) removes it for good
//   { action: "RUN_ARBITRAGE_MATCH" }              asks for a matcher run: pg_cron runs it within 5 minutes (otherwise hourly)
//
// Key handling: the raw apiKey is read from the POST body, encrypted here with AES-256-GCM (PROVIDER_KEY_SECRET, _shared/secrets.ts,
// the exact envelope the workers decrypt with), registered with the logger's redactor and then dropped. SQL receives ciphertext only.
//
// Auth: JWT verified here, then users.is_admin / not banned is checked in the function and AGAIN inside every SQL function
// (assert_catalog_admin). The SQL functions are service-role only.
// Secrets: JWT_SECRET, PROVIDER_KEY_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapProviderError, parseProviderRequest, readDonorBalances, toArbitrageDonorDto, toCandidateDto, toProviderDto } from '../_shared/admin-providers.ts'
import { PING_TIMEOUT_MS } from '../_shared/health-monitor.ts'
import { registerSecret } from '../_shared/logger.ts'
import { mockModeEnabled } from '../_shared/mock-guard.ts'
import { encryptSecret, resolveProviderApiKey } from '../_shared/secrets.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'
import { checkResolvedHost, type DnsResolver } from '../_shared/admin-providers.ts'

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

    if (parsed.action === 'ARBITRAGE_STATUS') {
      const r = await call('admin_arbitrage_status', { p_actor: userId })
      if ('response' in r) return r.response
      const data = r.data as { primary: Record<string, unknown>[]; donors: Record<string, unknown>[] }
      const donors = data.donors.map(toArbitrageDonorDto)
      return json({
        success: true, enabled: donors.some((d) => d.routingEnabled), donors,
        primary: data.primary.map((p) => ({ id: p.id, name: p.name, routingEnabled: p.routing_enabled === true, healthStatus: p.health_status })),
      })
    }

    if (parsed.action === 'SET_ARBITRAGE_MODE') {
      let readings: unknown[] = []
      if (parsed.enabled) {
        // live balances first (outside the transaction: panels can be slow), then one atomic switch
        const donors = must(
          await db.from('providers').select('id, name, api_url, api_key_encrypted').eq('catalog_mode', 'linked_only').eq('is_active', true).not('api_key_encrypted', 'is', null),
          'load donors',
        ) as { id: string; name: string; api_url: string; api_key_encrypted: string | null }[]
        const mock = mockModeEnabled(Deno.env)
        readings = await readDonorBalances(donors, async (d) => {
          const p = donors.find((x) => x.id === d.id)!
          const apiKey = await resolveProviderApiKey(p, Deno.env)
          if (!apiKey && !mock) throw new Error('no API key')
          registerSecret(apiKey)
          const adapter = createSMMv2Adapter({ id: p.id, name: p.name, apiUrl: p.api_url, apiKey, timeoutMs: PING_TIMEOUT_MS, logger: log }, { MOCK_MODE: mock ? 'true' : undefined })
          return adapter.getBalance()
        })
        const failed = (readings as { ok: boolean }[]).filter((x) => !x.ok).length
        if (failed > 0) log.warn('some donor panels did not answer with a balance', { failed, error_code: 'donor_balance_unread' })
      }
      const r = await call('admin_set_arbitrage_mode', { p_actor: userId, p_enabled: parsed.enabled, p_readings: readings })
      if ('response' in r) return r.response
      const data = r.data as { enabled: boolean; skipped: unknown[]; donors: Record<string, unknown>[] }
      log.info('arbitrage mode set', { enabled: parsed.enabled })
      return json({ success: true, enabled: data.enabled, skipped: data.skipped, donors: data.donors.map(toArbitrageDonorDto) })
    }

    // ---- automatic matching of cheaper donor services ---------------------------------------------------
    if (parsed.action === 'ARBITRAGE_CANDIDATES') {
      const r = await call('admin_arbitrage_candidates', { p_actor: userId, p_status: parsed.status, p_limit: 50, p_offset: parsed.offset })
      if ('response' in r) return r.response
      const data = r.data as { items: Record<string, unknown>[]; counts: Record<string, number> | null; refreshed_at: string | null }
      return json({ success: true, items: data.items.map(toCandidateDto), counts: data.counts ?? {}, refreshedAt: data.refreshed_at })
    }

    if (parsed.action === 'DECIDE_CANDIDATE') {
      const r = await call('admin_decide_arbitrage_candidate', { p_actor: userId, p_id: parsed.id, p_approve: parsed.approve })
      if ('response' in r) return r.response
      log.info('arbitrage candidate decided', { approve: parsed.approve })
      return json({ success: true, result: r.data })
    }

    if (parsed.action === 'RUN_ARBITRAGE_MATCH') {
      const r = await call('admin_refresh_arbitrage', { p_actor: userId })
      if ('response' in r) return r.response
      log.info('arbitrage matcher requested by an admin')
      return json({ success: true, result: r.data })
    }

    // ---- UPSERT_PROVIDER -----------------------------------------------------------------------------
    // The URL is called by our servers: its host must resolve, and only to public addresses (SSRF guard, second half).
    if (parsed.apiUrl !== null) {
      const dns = (Deno as unknown as { resolveDns?: (h: string, t: 'A' | 'AAAA') => Promise<string[]> }).resolveDns
      const resolver: DnsResolver | null = typeof dns === 'function' ? (h, t) => dns(h, t) : null
      const host = await checkResolvedHost(parsed.apiUrl, resolver)
      if ('error' in host) return fail(400, 'invalid_input', host.error)
      if (host.skipped) log.warn('DNS is not available here: the provider host was not resolved before saving', { error_code: 'dns_check_skipped' })
    }
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
      p_catalog_mode: parsed.catalogMode,
    })
    if ('response' in r) return r.response
    const row = r.data as Record<string, unknown>
    return json({ success: true, created: row.created === true, provider: toProviderDto(row) })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
