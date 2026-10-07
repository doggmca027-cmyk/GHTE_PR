// Supabase Edge Function (Deno): POST /admin-observability   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action?: "GET", hours?: 1..24 }   (default 24)
//   -> { success, health: SystemHealth }
//
// One read-only snapshot of how the system is doing: stuck orders and queue depths, open reconciliation cases by severity,
// provider API health (error rate, latency, error kinds from provider_health_log), the pg_cron pulse of the scheduled jobs
// (pg_cron's own log for the SQL job, worker heartbeats for the HTTP workers), treasury and active alerts.
//
// Auth: the JWT is verified here, then users.is_admin / not is_banned is re-checked in the database. get_system_health() is
// service-role only (no client grant), so nobody else can reach it. Nothing sensitive is in the snapshot: no keys, no wallets,
// no customer data (reasons are the same machine notes the Reconciliation tab shows to admins).
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { buildSystemHealth, parseObservabilityRequest, type RawHealth } from '../_shared/observability.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

Deno.serve(instrument('admin-observability', async (req: Request, { log }): Promise<Response> => {
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

  try {
    const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    const { data: admin, error: adminError } = await db.from('users').select('id').eq('id', userId).eq('is_admin', true).eq('is_banned', false).maybeSingle()
    if (adminError) throw new Error(`admin check: ${adminError.message}`)
    if (!admin) return fail(403, 'forbidden', 'Admin access required.')

    const raw = await readJson(req)
    const parsed = parseObservabilityRequest(raw)
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    const started = Date.now()
    const { data, error } = await db.rpc('get_system_health', { p_hours: parsed.hours })
    const latencyMs = Date.now() - started
    if (error) throw new Error(`get_system_health: ${error.message}`)
    return json({ success: true, health: buildSystemHealth(data as RawHealth, Date.now(), latencyMs) })
  } catch (e) {
    log.error('snapshot failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
