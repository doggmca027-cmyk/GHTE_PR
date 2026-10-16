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
// Bundles: one storefront service sold through several providers. Orders go to the cheapest eligible offer (routing.ts); the price is
// built on the MOST EXPENSIVE usable offer (service-cost.ts), so the cheaper providers are margin and a failover never sells at a loss.
//   { action: "SEARCH_SERVICES", search, limit? }          -> { services: [{ id, name, platform, customerRatePer1000, offers }] }
//   { action: "LIST_SERVICE_OFFERS", serviceId }           -> { service, price, offers: [... in routing order, with why one is blocked] }
//   { action: "LINK_BY_EXTERNAL_ID", serviceId, providerId, externalServiceId, routingScore? }
//       Fetches the panel's CURRENT list, stores that service's cost / limits, links it (admin_link_provider_service), re-prices the
//       service at once and answers like LIST_SERVICE_OFFERS (+ link details).
//   { action: "UNLINK_OFFER", offerId }                    -> switches the offer off (kept: orders reference it), re-prices the service.
//                                                             The last usable offer of a service cannot be unlinked.
//
// Auth: JWT verified here, then users.is_admin / not banned is checked in the function and AGAIN inside every SQL function
// (assert_catalog_admin). The SQL functions are service-role only; clients can never reach them.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapMappingError, parseMappingRequest } from '../_shared/admin-catalog-mapping.ts'
import { calculateCustomerRate } from '../_shared/price-engine.ts'
import { mockModeEnabled } from '../_shared/mock-guard.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import { registerSecret } from '../_shared/logger.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'
import {
  BUNDLE_OFFER_COLUMNS, BundleError, bundleOffers, bundlePrice, linkByExternalId,
  type BundleOfferRow, type BundleServiceRow,
} from '../_shared/offer-bundle.ts'
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

    // ---- bundles -----------------------------------------------------------------------------------------------------------
    const loadRules = async () => (must(await db.from('price_rules').select(RULE_COLUMNS).eq('is_active', true), 'load price_rules') as Record<string, unknown>[]).map(toRule)
    const loadService = async (serviceId: string): Promise<BundleServiceRow | null> => {
      const s = must(
        await db.from('services').select('id, name, category_id, customer_rate_per_1000, is_active, min_quantity, max_quantity, category:categories(name, platform:platforms(slug))').eq('id', serviceId).maybeSingle(),
        'load service',
      ) as Record<string, unknown> | null
      if (!s) return null
      const category = s.category as { platform?: { slug?: string } | null } | null
      return { id: String(s.id), name: String(s.name), category_id: String(s.category_id), platform: (category?.platform?.slug ?? 'other') as Platform, customer_rate_per_1000: Number(s.customer_rate_per_1000) }
    }
    const loadOffers = async (serviceId: string) =>
      must(await db.from('provider_service_offers').select(BUNDLE_OFFER_COLUMNS).eq('service_id', serviceId), 'load offers') as unknown as BundleOfferRow[]
    const reprice = async (serviceId: string) => {
      const service = await loadService(serviceId)
      if (!service) throw new BundleError(404, 'service_not_found', 'Service not found.')
      const price = bundlePrice(service, await loadOffers(serviceId), await loadRules())
      if (price.changed) must(await db.rpc('apply_service_rates', { p_rows: [{ id: serviceId, rate: price.newRate }] }), 'apply service rate')
      return price
    }
    const bundleView = async (serviceId: string) => {
      const service = await loadService(serviceId)
      if (!service) return null
      const offers = await loadOffers(serviceId)
      const price = bundlePrice(service, offers, await loadRules())
      return { service: { id: service.id, name: service.name, platform: service.platform, customerRatePer1000: service.customer_rate_per_1000 }, price, offers: bundleOffers(offers, service.customer_rate_per_1000) }
    }

    if (parsed.action === 'SEARCH_SERVICES') {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.search)
      const safe = parsed.search.replace(/[%_\\,()*]/g, ' ').trim()
      let q = db.from('services').select('id, name, customer_rate_per_1000, is_active, category:categories(platform:platforms(slug)), offers:provider_service_offers(count)').eq('is_active', true)
      q = uuid ? q.eq('id', parsed.search.toLowerCase()) : q.ilike('name', `%${safe}%`)
      const rows = must(await q.order('name').limit(parsed.limit), 'search services') as unknown as Record<string, unknown>[]
      return json({
        success: true,
        services: rows.map((s) => ({
          id: s.id, name: s.name, customerRatePer1000: Number(s.customer_rate_per_1000),
          platform: ((s.category as { platform?: { slug?: string } | null } | null)?.platform?.slug) ?? 'other',
          offers: Number(((s.offers as { count?: number }[] | null) ?? [])[0]?.count ?? 0),
        })),
      })
    }

    if (parsed.action === 'LIST_SERVICE_OFFERS') {
      const view = await bundleView(parsed.serviceId)
      if (!view) return fail(404, 'service_not_found', 'Service not found.')
      return json({ success: true, ...view })
    }

    if (parsed.action === 'LINK_BY_EXTERNAL_ID') {
      try {
        const result = await linkByExternalId(parsed, {
          async loadProvider(id) {
            return must(await db.from('providers').select('id, name, is_active').eq('id', id).maybeSingle(), 'load provider') as { id: string; name: string; is_active: boolean } | null
          },
          async fetchPanelServices(id) {
            const p = must(await db.from('providers').select('id, name, api_url, api_key_encrypted').eq('id', id).single(), 'load provider') as { id: string; name: string; api_url: string; api_key_encrypted: string | null }
            const apiKey = await resolveProviderApiKey(p, Deno.env)
            if (!apiKey && !mockModeEnabled(Deno.env)) throw new BundleError(409, 'no_api_key', `Save the API key of ${p.name} first.`)
            registerSecret(apiKey)
            const adapter = createSMMv2Adapter({ id: p.id, name: p.name, apiUrl: p.api_url, apiKey, logger: log }, { MOCK_MODE: mockModeEnabled(Deno.env) ? 'true' : undefined })
            try {
              return await adapter.getServices()
            } catch (e) {
              log.warn('panel service list failed', { err: e, providerId: p.id, error_code: 'panel_fetch_failed' })
              throw new BundleError(502, 'panel_unavailable', `${p.name} did not answer with its service list. Try again later.`)
            }
          },
          async saveProviderService(providerId, s) {
            const row = must(await db.from('provider_services').upsert({
              provider_id: providerId, external_service_id: String(s.externalServiceId), name: s.name.slice(0, 500), category_raw: s.categoryRaw ?? null,
              rate_per_1000: s.ratePer1000, min_quantity: s.minQuantity, max_quantity: s.maxQuantity, refill_supported: s.refillSupported,
              cancel_supported: s.cancelSupported, service_type: s.type ?? 'Default', is_active: true, last_synced_at: new Date().toISOString(),
            }, { onConflict: 'provider_id,external_service_id' }).select('id').single(), 'save provider service') as { id: string }
            return row.id
          },
          async link(providerServiceId, serviceId, routingScore) {
            const r = await call('admin_link_provider_service', {
              p_actor: userId, p_provider_service_id: providerServiceId, p_service_id: serviceId,
              p_routing_score: routingScore, p_supports_partial: false, p_make_primary: false,
            })
            if ('response' in r) {
              const body = await r.response.clone().json() as { error?: string; message?: string }
              throw new BundleError(r.response.status, body.error ?? 'refused', body.message ?? 'Refused.')
            }
            return String(r.data.offer_id)
          },
          reprice,
        })
        log.info('panel service linked', { serviceId: parsed.serviceId, providerId: parsed.providerId, offerId: result.offerId })
        return json({ success: true, link: result, ...(await bundleView(parsed.serviceId)) })
      } catch (e) {
        if (e instanceof BundleError) return fail(e.status, e.code, e.message)
        throw e
      }
    }

    if (parsed.action === 'UNLINK_OFFER') {
      const offer = must(await db.from('provider_service_offers').select('id, service_id, is_active').eq('id', parsed.offerId).maybeSingle(), 'load offer') as { id: string; service_id: string; is_active: boolean } | null
      if (!offer) return fail(404, 'offer_not_found', 'Offer not found.')
      if (offer.is_active) {
        const usable = bundleOffers(await loadOffers(offer.service_id), Number.MAX_SAFE_INTEGER).filter((o) => o.blockedBy === null || o.blockedBy === 'routing_off' || o.blockedBy === 'unhealthy')
        if (usable.length <= 1 && usable.some((o) => o.offerId === offer.id)) {
          return fail(409, 'last_offer', 'This is the last offer of the service: link another provider first, or switch the service off.')
        }
        // an admin's "off" is final: the guard flags go too, so the sync never switches this offer back on (clear_catalog_anomalies)
        must(await db.from('provider_service_offers').update({ is_active: false, anomaly_detected: false, anomaly_reason: null, anomaly_observed: null, anomaly_detected_at: null }).eq('id', offer.id).select('id'), 'switch the offer off')
        must(await db.from('admin_audit_log').insert({ admin_id: userId, action: 'unlink_offer', target_id: offer.id, details: { service_id: offer.service_id } }), 'audit')
      }
      const price = await reprice(offer.service_id)
      return json({ success: true, price, ...(await bundleView(offer.service_id)) })
    }

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
