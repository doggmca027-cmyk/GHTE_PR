// Supabase Edge Function (Deno): POST /admin-catalog-mapping   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//
// Puts panel services (provider_services, which sync-catalog stores but never sells) on the storefront.
//
//   { action: "LIST_UNLINKED", providerId?, search?, limit? (1..200, default 50), offset? }
//       -> { success, items: [{ id, providerId, providerName, externalServiceId, name, categoryRaw, ratePer1000, minQuantity,
//                               maxQuantity, refillSupported, cancelSupported, lastSyncedAt }], total, limit, offset }
//          Active panel services that have no offer and are nobody's primary / fallback.
//   { action: "LINK", providerServiceId, serviceId, routingScore? (0..1000), supportsPartial?, makePrimary? }
//       -> { success, offerId, serviceId, providerServiceId, costPer1000, routingScore, isPrimary }
//          Creates a provider_service_offer for an existing service with the panel's own cost, limits and flags.
//          services.primary_provider_service_id is NOT NULL, so it is only changed when makePrimary is true.
//   { action: "CREATE_AND_LINK", providerServiceId, categoryId, name, description?, customerRatePer1000?, minQuantity?, maxQuantity?,
//                                supportsPartial? }
//       -> { success, serviceId, offerId, providerServiceId, customerRatePer1000, costPer1000, minQuantity, maxQuantity }
//          Creates the storefront service (primary = the panel service) and its offer in ONE database transaction.
//          Without customerRatePer1000 the price comes from the price rules; a price below the panel cost is refused.
//
// Auth: JWT verified here, then users.is_admin / not banned is checked in the function and AGAIN inside every SQL function
// (assert_catalog_admin). The SQL functions are service-role only; clients can never reach them.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapMappingError, parseMappingRequest } from '../_shared/admin-catalog-mapping.ts'
import { calculateCustomerRate } from '../_shared/price-engine.ts'
import type { Platform, PriceRule } from '../_shared/types.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const RULE_COLUMNS = 'id, type, value, platform:platforms(slug), category_id, service_id, min_rate, max_rate, name_all, name_any, priority, is_active'

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

const toRule = (r: Record<string, unknown>): PriceRule => ({
  ...(r as unknown as PriceRule),
  platform: (r.platform as { slug?: string } | null)?.slug ?? null,
  value: Number(r.value),
  min_rate: r.min_rate == null ? null : Number(r.min_rate),
  max_rate: r.max_rate == null ? null : Number(r.max_rate),
})

Deno.serve(instrument('admin-catalog-mapping', async (req: Request, { log }): Promise<Response> => {
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

    // Everything below runs for an admin only; a business error from SQL becomes a 4xx, anything else is a 500.
    const call = async (fn: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> } | { response: Response }> => {
      const { data, error } = await db.rpc(fn, args)
      if (error) {
        const m = mapMappingError(error.message)
        if (m.status === 500) throw new Error(`${fn}: ${error.message}`)
        return { response: fail(m.status, m.error, m.message) }
      }
      return { data: data as Record<string, unknown> }
    }

    const parsed = parseMappingRequest(await readJson(req))
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    if (parsed.action === 'LIST_UNLINKED') {
      const r = await call('admin_unlinked_provider_services', {
        p_actor: userId, p_provider_id: parsed.providerId, p_search: parsed.search, p_limit: parsed.limit, p_offset: parsed.offset,
      })
      if ('response' in r) return r.response
      return json({ success: true, items: r.data.items, total: r.data.total, limit: r.data.limit, offset: r.data.offset })
    }

    if (parsed.action === 'LINK') {
      const r = await call('admin_link_provider_service', {
        p_actor: userId, p_provider_service_id: parsed.providerServiceId, p_service_id: parsed.serviceId,
        p_routing_score: parsed.routingScore, p_supports_partial: parsed.supportsPartial, p_make_primary: parsed.makePrimary,
      })
      if ('response' in r) return r.response
      const d = r.data
      return json({
        success: true, offerId: d.offer_id, serviceId: d.service_id, providerServiceId: d.provider_service_id,
        costPer1000: Number(d.cost_per_1000), routingScore: Number(d.routing_score), isPrimary: d.is_primary === true,
      })
    }

    // ---- CREATE_AND_LINK -----------------------------------------------------------------------------
    let rate = parsed.customerRatePer1000
    if (rate === null) {
      // Same engine and rules as sync-catalog / admin-pricing; the panel cost is the basis.
      const ps = must(await db.from('provider_services').select('rate_per_1000').eq('id', parsed.providerServiceId).maybeSingle(), 'load provider service') as { rate_per_1000: number } | null
      if (!ps) return fail(404, 'provider_service_not_found', 'Provider service not found.')
      const category = must(
        await db.from('categories').select('id, platform:platforms(slug)').eq('id', parsed.categoryId).eq('is_active', true).maybeSingle(),
        'load category',
      ) as unknown as { id: string; platform: { slug: Platform } | null } | null
      if (!category) return fail(404, 'category_not_found', 'Category not found or inactive.')
      const rules = (must(await db.from('price_rules').select(RULE_COLUMNS).eq('is_active', true), 'load price_rules') as Record<string, unknown>[]).map(toRule)
      rate = calculateCustomerRate(Number(ps.rate_per_1000), rules, { categoryId: category.id, platform: category.platform?.slug ?? 'other', serviceName: parsed.name })
    }

    const r = await call('admin_create_service_with_offer', {
      p_actor: userId, p_provider_service_id: parsed.providerServiceId, p_category_id: parsed.categoryId, p_name: parsed.name,
      p_description: parsed.description, p_customer_rate: rate, p_min_quantity: parsed.minQuantity, p_max_quantity: parsed.maxQuantity,
      p_supports_partial: parsed.supportsPartial,
    })
    if ('response' in r) return r.response
    const d = r.data
    return json({
      success: true, serviceId: d.service_id, offerId: d.offer_id, providerServiceId: d.provider_service_id,
      customerRatePer1000: Number(d.customer_rate_per_1000), costPer1000: Number(d.cost_per_1000),
      minQuantity: Number(d.min_quantity), maxQuantity: Number(d.max_quantity),
    })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
