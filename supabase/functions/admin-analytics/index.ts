// Supabase Edge Function (Deno): POST /admin-analytics   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { startDate?, endDate? }  ISO dates. Missing = default (last 30 days up to now); explicit null = unbounded ("All time").
//   -> { success, analytics: { totalOrders, grossRevenue, providerCost, grossProfit, treasuryFees, netProfit, ... } }
//
// Orders are counted by creation time in [startDate, endDate). See get_profit_analytics() for the exact math
// (partial orders count only what was actually delivered).
//
// Auth: JWT verified here, then users.is_admin is re-checked in the database; the RPC checks it a third time with the
// caller's own token (require_admin()). Never exposes business metrics to anyone else.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json } from '../_shared/http.ts'
import { analyticsFromRpc, parseAnalyticsRange } from '../_shared/admin-analytics.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

Deno.serve(instrument('admin-analytics', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !anonKey || !serviceKey) {
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

    // An empty body is fine (all defaults); a malformed one is not.
    const raw = await req.text()
    let body: unknown = {}
    if (raw.trim() !== '') {
      if (raw.length > 4096) return fail(400, 'invalid_input', 'Request too large.')
      try { body = JSON.parse(raw) } catch { return fail(400, 'invalid_input', 'Body must be valid JSON.') }
    }
    const range = parseAnalyticsRange(body)
    if ('error' in range) return fail(400, 'invalid_input', range.error)

    const asUser: Db = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
    })
    const { data, error } = await asUser.rpc('get_profit_analytics', { p_start_date: range.start, p_end_date: range.end })
    if (error) throw new Error(`get_profit_analytics: ${error.message}`)
    return json({ success: true, analytics: analyticsFromRpc(data as Record<string, unknown>) })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
