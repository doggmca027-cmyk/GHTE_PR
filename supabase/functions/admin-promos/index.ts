// Supabase Edge Function (Deno): POST /admin-promos   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action: "LIST" }
//       -> { success, promos: [{ id, code, discountType, discountValue, maxUses, currentUses, expiresAt, isActive, createdAt }] }  newest first
//   { action: "CREATE", code?, discountType: "percentage" | "fixed", discountValue, maxUses?, expiresAt? }
//       -> { success, promo }   an empty code is generated ("PROMO-XXXXXX"); a taken code answers 409 code_taken
//   { action: "SET_ACTIVE", id, active }
//       -> { success, promo }
//
// A promo code is a discount on the list price that the discount engine applies at order time (never below cost + the minimum margin,
// see discounts.ts). Every create / switch is written to admin_audit_log.
//
// Auth: JWT verified here, then users.is_admin re-checked in the database. The table is not readable by clients at all
// (all privileges revoked), so this function is the only way in.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { parsePromoRequest, toPromoDto } from '../_shared/admin-promos.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const COLUMNS = 'id, code, discount_type, discount_value, max_uses, current_uses, expires_at, is_active, created_at'
const LIST_LIMIT = 200

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

Deno.serve(instrument('admin-promos', async (req: Request, { log }): Promise<Response> => {
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

    const parsed = parsePromoRequest(await readJson(req))
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    if (parsed.action === 'LIST') {
      const rows = must(await db.from('promo_codes').select(COLUMNS).order('created_at', { ascending: false }).limit(LIST_LIMIT), 'list promo codes') as Record<string, unknown>[]
      return json({ success: true, promos: rows.map(toPromoDto) })
    }

    if (parsed.action === 'CREATE') {
      const { data, error } = await db.from('promo_codes').insert({
        code: parsed.code, discount_type: parsed.discountType, discount_value: parsed.discountValue,
        max_uses: parsed.maxUses, expires_at: parsed.expiresAt, created_by: userId,
      }).select(COLUMNS).single()
      if (error?.code === '23505') return fail(409, 'code_taken', 'This code already exists.')
      if (error) throw new Error(`insert promo code: ${error.message}`)
      const promo = toPromoDto(data as Record<string, unknown>)
      must(await db.from('admin_audit_log').insert({
        admin_id: userId, action: 'create_promo_code', target_id: promo.id,
        details: { code: promo.code, type: promo.discountType, value: promo.discountValue, maxUses: promo.maxUses, expiresAt: promo.expiresAt },
      }), 'audit log')
      return json({ success: true, promo })
    }

    // SET_ACTIVE
    const { data, error } = await db.from('promo_codes').update({ is_active: parsed.active }).eq('id', parsed.id).select(COLUMNS).maybeSingle()
    if (error) throw new Error(`update promo code: ${error.message}`)
    if (!data) return fail(404, 'not_found', 'Promo code not found.')
    const promo = toPromoDto(data as Record<string, unknown>)
    must(await db.from('admin_audit_log').insert({
      admin_id: userId, action: parsed.active ? 'enable_promo_code' : 'disable_promo_code', target_id: promo.id, details: { code: promo.code },
    }), 'audit log')
    return json({ success: true, promo })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
