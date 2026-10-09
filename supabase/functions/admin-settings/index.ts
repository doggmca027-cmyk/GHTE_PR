// Supabase Edge Function (Deno): POST /admin-settings   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action: "GET" }
//       -> { success, settings: { globalOrdersEnabled, globalPaymentsEnabled, maintenanceMode, deferredOrdersEnabled, deferredOrdersCap,
//                                 deferredOrdersTtlHours, updatedAt }, unfunded: { count, charge, cost, oldest, providers: [...] } }
//   { action: "UPDATE", ordersEnabled?, paymentsEnabled?, maintenanceMode?, deferredOrdersEnabled? }   (booleans; absent = unchanged)
//       -> same payload after the change. Audited in admin_audit_log.
//   unfunded = paid orders waiting for a provider top-up (deferred funding): how many, what they cost, and per provider what to transfer.
//
// The switches take effect immediately: place-order and create-deposit read platform_settings on every call.
//
// Auth: JWT verified here, then users.is_admin re-checked in the database; the update RPC checks it again with the
// caller's own token (require_admin()).
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json } from '../_shared/http.ts'
import { loadPlatformSettings, parseSettingsRequest } from '../_shared/platform-settings.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

Deno.serve(instrument('admin-settings', async (req: Request, { log }): Promise<Response> => {
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

    const raw = await req.text()
    let body: unknown = null
    if (raw.trim() !== '') {
      if (raw.length > 2048) return fail(400, 'invalid_input', 'Request too large.')
      try { body = JSON.parse(raw) } catch { return fail(400, 'invalid_input', 'Body must be valid JSON.') }
    }
    const parsed = parseSettingsRequest(body)
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    if (parsed.action === 'UPDATE') {
      if (parsed.ordersEnabled !== null || parsed.paymentsEnabled !== null || parsed.maintenanceMode !== null) {
        const asUser: Db = createClient(supabaseUrl, anonKey, {
          auth: { persistSession: false },
          global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
        })
        const { error } = await asUser.rpc('update_platform_settings', {
          p_orders_enabled: parsed.ordersEnabled,
          p_payments_enabled: parsed.paymentsEnabled,
          p_maintenance_mode: parsed.maintenanceMode,
        })
        if (error) throw new Error(`update_platform_settings: ${error.message}`)
      }
      if (parsed.deferredOrdersEnabled !== null) {
        // the admin was verified above (is_admin, not banned); the change is audited like the others
        const before = await loadPlatformSettings(db)
        const { error } = await db.from('platform_settings').update({ deferred_orders_enabled: parsed.deferredOrdersEnabled, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', 1)
        if (error) throw new Error(`update deferred_orders_enabled: ${error.message}`)
        const { error: auditError } = await db.from('admin_audit_log').insert({
          admin_id: userId, action: 'update_platform_settings', target_id: '1',
          details: { deferred_orders_enabled: [before?.deferredOrdersEnabled ?? null, parsed.deferredOrdersEnabled] },
        })
        if (auditError) throw new Error(`audit log: ${auditError.message}`)
      }
    }

    const settings = await loadPlatformSettings(db)
    if (!settings) throw new Error('platform_settings could not be read')
    const { data: unfunded } = await db.rpc('unfunded_orders_summary')
    return json({ success: true, settings, unfunded: unfunded ?? null })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
