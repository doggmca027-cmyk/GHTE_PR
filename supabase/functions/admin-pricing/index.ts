// Supabase Edge Function (Deno): POST /admin-pricing   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action: "GET" }
//       -> { success, services: [...] }  via get_admin_pricing_view() (the offer routing would pick, and the base cost, vs retail price)
//   { action: "UPDATE_RULE", serviceId? | categoryId? | platform?, type: "fixed" | "percentage", value }
//       -> upserts the price rule for that scope, then re-prices every affected service right away with
//          _shared/price-engine.ts (the same math sync-catalog uses) and writes services.customer_rate_per_1000. The markup is applied to the
//          CHEAPEST offer that can receive an order (_shared/service-cost.ts), not to the legacy primary provider service.
//
// Auth: JWT verified here, then users.is_admin is re-checked in the database; the pricing view RPC checks it
// again with the caller's own token (require_admin()).
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { groupByService, OFFER_PRICING_COLUMNS, serviceCostBasis, toPricingOffer, type PricingOfferRow } from '../_shared/service-cost.ts'
import { affectedServices, pagePricingRows, parsePricingRequest, repriceServices, type RepriceService } from '../_shared/admin-pricing.ts'
import type { Platform, PriceRule } from '../_shared/types.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

// platform is the joined slug: the pricing engine and the reprice logic keep working with the slug
const RULE_COLUMNS = 'id, type, value, platform:platforms(slug), category_id, service_id, min_rate, max_rate, priority, is_active'
const WRITE_CHUNK = 500
const ALL_OFFERS_ABOVE = 300
const OFFER_ID_CHUNK = 100
const OFFER_PAGE = 1000

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

/** Active services with their platform, a page at a time (PostgREST cuts a response at 1000 rows). */
async function loadActiveServices(db: Db): Promise<{ id: string; category_id: string; customer_rate_per_1000: number; category: { platform: { slug: Platform } } }[]> {
  const out: { id: string; category_id: string; customer_rate_per_1000: number; category: { platform: { slug: Platform } } }[] = []
  for (let from = 0; ; from += OFFER_PAGE) {
    const page = must(
      await db.from('services')
        .select('id, category_id, customer_rate_per_1000, category:categories!inner(platform:platforms!inner(slug))')
        .eq('is_active', true).order('id').range(from, from + OFFER_PAGE - 1),
      'load services',
    ) as unknown as typeof out
    out.push(...page)
    if (page.length < OFFER_PAGE) break
  }
  return out
}

/** All offers of the given services. A few services: chunked by id (the ids travel in the URL); a whole catalogue: the table in pages. */
async function loadOffers(db: Db, serviceIds: string[]): Promise<PricingOfferRow[]> {
  const out: PricingOfferRow[] = []
  if (serviceIds.length > ALL_OFFERS_ABOVE) {
    for (let from = 0; ; from += OFFER_PAGE) {
      const page = must(await db.from('provider_service_offers').select(OFFER_PRICING_COLUMNS).order('id').range(from, from + OFFER_PAGE - 1), 'load offers') as unknown as PricingOfferRow[]
      out.push(...page)
      if (page.length < OFFER_PAGE) break
    }
    return out
  }
  for (let i = 0; i < serviceIds.length; i += OFFER_ID_CHUNK) {
    for (let from = 0; ; from += OFFER_PAGE) {
      const page = must(
        await db.from('provider_service_offers').select(OFFER_PRICING_COLUMNS).in('service_id', serviceIds.slice(i, i + OFFER_ID_CHUNK)).order('id').range(from, from + OFFER_PAGE - 1),
        'load offers',
      ) as unknown as PricingOfferRow[]
      out.push(...page)
      if (page.length < OFFER_PAGE) break
    }
  }
  return out
}

Deno.serve(instrument('admin-pricing', async (req: Request, { log }): Promise<Response> => {
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

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  try {
    const admin = must(await db.from('users').select('id').eq('id', userId).eq('is_admin', true).eq('is_banned', false).maybeSingle(), 'admin check')
    if (!admin) return fail(403, 'forbidden', 'Admin access required.')

    const parsed = parsePricingRequest(await readJson(req))
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    if (parsed.action === 'GET') {
      // The caller's own token, so the RPC's require_admin() (auth.uid()) is the second gate.
      const asUser: Db = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: req.headers.get('authorization') ?? '' } },
      })
      const view = must(await asUser.rpc('get_admin_pricing_view'), 'pricing view') as Record<string, unknown>[]
      const page = pagePricingRows(view, parsed)
      return json({ success: true, services: page.rows, total: page.total })
    }

    // ---- UPDATE_RULE ---------------------------------------------------------------------------------
    const { serviceId, categoryId, platform, type, value } = parsed

    // Upsert: one flat (non-tier) rule per scope.
    // deno-lint-ignore no-explicit-any
    let q: any = db.from('price_rules').select('id').neq('type', 'tier').is('min_rate', null)
    q = serviceId ? q.eq('service_id', serviceId) : q.is('service_id', null)
    q = categoryId ? q.eq('category_id', categoryId) : q.is('category_id', null)
    let platformId: string | null = null
    if (platform) {
      const found = must(await db.from('platforms').select('id').eq('slug', platform).limit(1), 'load platform') as { id: string }[]
      if (found.length === 0) return fail(400, 'invalid_input', 'Unknown platform.')
      platformId = found[0].id
    }
    q = platformId ? q.eq('platform_id', platformId) : q.is('platform_id', null)
    const existing = must(await q.order('priority', { ascending: false }).order('created_at', { ascending: true }).limit(1), 'load rule') as { id: string }[]

    let ruleId: string
    if (existing[0]) {
      ruleId = existing[0].id
      must(await db.from('price_rules').update({ type, value, is_active: true }).eq('id', ruleId).select('id').single(), 'update rule')
    } else {
      const scopeName = serviceId ? 'Service' : categoryId ? 'Category' : platform ? `Platform ${platform}` : 'Global'
      ruleId = (must(
        await db.from('price_rules').insert({
          name: `Admin margin: ${scopeName}`, type, value, service_id: serviceId, category_id: categoryId, platform_id: platformId, priority: 0, is_active: true,
        }).select('id').single(),
        'insert rule',
      ) as { id: string }).id
    }

    // Re-price immediately with the shared engine, from the same basis as sync-catalog: the cheapest offer that can receive orders.
    const rules = (must(await db.from('price_rules').select(RULE_COLUMNS).eq('is_active', true), 'load price_rules') as Record<string, unknown>[]).map(toRule)
    const all = await loadActiveServices(db)
    const inScope = all.filter((r) => (serviceId ? r.id === serviceId : categoryId ? r.category_id === categoryId : platform ? r.category.platform.slug === platform : true))
    const offerRows = inScope.length === 0 ? [] : await loadOffers(db, inScope.map((r) => r.id))
    const offersByService = groupByService(offerRows.map(toPricingOffer))
    const services: RepriceService[] = inScope.flatMap((r) => {
      const basis = serviceCostBasis(offersByService.get(r.id) ?? [])
      // no offer can receive an order: there is no cost to mark up, so the price is left alone
      return basis ? [{ id: r.id, category_id: r.category_id, platform: r.category.platform.slug, customer_rate_per_1000: Number(r.customer_rate_per_1000), provider_rate: basis.cost }] : []
    })
    const changes = repriceServices(affectedServices(services, parsed), rules)
    // the engine computes the rates; the database writes them a chunk at a time
    for (let i = 0; i < changes.length; i += WRITE_CHUNK) {
      must(await db.rpc('apply_service_rates', { p_rows: changes.slice(i, i + WRITE_CHUNK).map((c) => ({ id: c.id, rate: c.rate })) }), 'apply service rates')
    }

    must(await db.from('admin_audit_log').insert({
      admin_id: userId, action: 'set_margin_rule', target_id: ruleId,
      details: { scope: { serviceId, categoryId, platform }, type, value, repriced: changes.length },
    }), 'audit log')

    return json({ success: true, ruleId, repriced: changes.length })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
