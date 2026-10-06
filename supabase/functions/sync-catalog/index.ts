// Supabase Edge Function (Deno): POST /sync-catalog  { providerId?: uuid }
//
// Pulls every active provider's catalogue, upserts provider_services, creates missing
// categories/services, re-prices from price_rules and deactivates (never deletes) what
// the provider no longer lists.
//
// Auth: header `x-cron-secret: $CRON_SECRET` or `Authorization: Bearer <service role key>`.
// Secrets: CRON_SECRET, PROVIDER_KEY_SECRET (base64 32 bytes, optional),
//          PROVIDER_<NAME>_API_KEY (fallback plaintext key), MOCK_MODE (dev only).
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import {
  diffProviderServices,
  emptyProviderReport,
  isAuthorized,
  normalizeProviderServices,
  planService,
  resolveCategory,
  summarize,
  type ExistingProviderService,
  type ExistingService,
  type ProviderSyncReport,
  type ServiceRow,
} from '../_shared/catalog-sync.ts'
import type { PriceRule } from '../_shared/types.ts'

const PAGE = 1000
const WRITE_CHUNK = 500
const ID_CHUNK = 100
/** Refuse to deactivate more than this share of a large catalogue in one run (guards against partial provider responses). */
const MAX_DEACTIVATION_RATIO = 0.5
const MIN_CATALOG_FOR_RATIO_GUARD = 20

interface ProviderRow {
  id: string
  name: string
  api_url: string
  api_key_encrypted: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

/** PostgREST caps responses at 1000 rows, so page through everything. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = must(await page(from, from + PAGE - 1), what)
    all.push(...rows)
    if (rows.length < PAGE) return all
  }
}

async function syncProvider(db: Db, provider: ProviderRow, rules: PriceRule[]): Promise<ProviderSyncReport> {
  const report = emptyProviderReport(provider.name)
  const mockMode = Deno.env.get('MOCK_MODE') === 'true'
  const apiKey = await resolveProviderApiKey(provider, Deno.env)
  if (!apiKey && !mockMode) {
    report.status = 'skipped'
    report.error = 'no API key configured (set api_key_encrypted + PROVIDER_KEY_SECRET, or PROVIDER_<NAME>_API_KEY)'
    return report
  }

  const adapter = createSMMv2Adapter(
    { id: provider.id, name: provider.name, apiUrl: provider.api_url, apiKey },
    { MOCK_MODE: Deno.env.get('MOCK_MODE') },
  )

  // 1. Fetch. Any failure here aborts this provider BEFORE anything is written or deactivated.
  const { valid, skipped } = normalizeProviderServices(await adapter.getServices())
  report.skippedInvalid = skipped.length
  if (valid.length === 0) {
    report.status = 'skipped'
    report.error = 'provider returned no valid services; nothing changed'
    return report
  }

  // Cache the provider's balance for the admin dashboard (best effort: never blocks the catalog sync).
  try {
    const { balance } = await adapter.getBalance()
    await db.from('providers').update({ balance, balance_updated_at: new Date().toISOString() }).eq('id', provider.id)
  } catch (e) {
    console.warn(`sync-catalog: could not refresh balance for ${provider.name}`, e instanceof Error ? e.name : 'unknown')
  }

  // 2. Diff provider_services.
  const existingPS = await fetchAll<ExistingProviderService>(
    (from, to) =>
      db.from('provider_services')
        .select('id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported, is_active')
        .eq('provider_id', provider.id).order('id').range(from, to),
    'load provider_services',
  )
  const nowIso = new Date().toISOString()
  const diff = diffProviderServices(provider.id, existingPS, valid, nowIso)

  const activeBefore = existingPS.filter((e) => e.is_active).length
  const deactivationBlocked =
    activeBefore >= MIN_CATALOG_FOR_RATIO_GUARD && diff.missing.length / activeBefore > MAX_DEACTIVATION_RATIO
  if (deactivationBlocked) {
    report.warning = `deactivation skipped: ${diff.missing.length}/${activeBefore} services missing from provider response`
  }

  // 3. Upsert provider_services.
  const extToId = new Map(existingPS.map((e) => [e.external_service_id, e.id]))
  for (const part of chunks(diff.rows, WRITE_CHUNK)) {
    const saved = must(
      await db.from('provider_services')
        .upsert(part, { onConflict: 'provider_id,external_service_id' })
        .select('id, external_service_id'),
      'upsert provider_services',
    ) as { id: string; external_service_id: string }[]
    for (const r of saved) extToId.set(r.external_service_id, r.id)
  }
  report.added = diff.added.length
  report.updated = diff.updated.length

  // 4. Categories: match by slug, create the missing ones.
  const resolved = new Map(valid.map((s) => [s.externalServiceId, resolveCategory(s.categoryRaw, s.name)]))
  const loadCategories = async () =>
    new Map(
      (must(await db.from('categories').select('id, slug'), 'load categories') as { id: string; slug: string }[])
        .map((c) => [c.slug, c.id]),
    )
  let categoryBySlug = await loadCategories()
  const newCategories = new Map<string, { platform: string; name: string; slug: string; sort_order: number }>()
  for (const c of resolved.values()) {
    if (!categoryBySlug.has(c.slug) && !newCategories.has(c.slug)) {
      newCategories.set(c.slug, { ...c, sort_order: 100 })
    }
  }
  if (newCategories.size > 0) {
    must(
      await db.from('categories').upsert([...newCategories.values()], { onConflict: 'slug', ignoreDuplicates: true }),
      'create categories',
    )
    categoryBySlug = await loadCategories()
    report.categoriesCreated = newCategories.size
  }

  // 5. Services: create / re-price / re-limit.
  const existingServices = await fetchAll<ExistingService>(
    (from, to) =>
      db.from('services')
        .select('id, category_id, name, description, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active, sort_order, refill_supported, provider_service:primary_provider_service_id!inner(provider_id)')
        .eq('provider_service.provider_id', provider.id).order('id').range(from, to),
    'load services',
  )
  const serviceByPS = new Map(existingServices.map((s) => [s.primary_provider_service_id, s]))

  const toCreate: ServiceRow[] = []
  const toUpdate: ServiceRow[] = []
  for (const p of valid) {
    const psId = extToId.get(p.externalServiceId)
    const category = resolved.get(p.externalServiceId)
    const categoryId = category && categoryBySlug.get(category.slug)
    if (!psId || !category || !categoryId) continue
    const plan = planService({
      existing: serviceByPS.get(psId),
      providerServiceId: psId,
      provider: p,
      categoryId,
      platform: category.platform,
      rules,
      providerServiceReactivated: diff.reactivated.has(p.externalServiceId),
    })
    if (plan.action === 'create' && plan.row) {
      toCreate.push(plan.row)
    } else if (plan.action === 'update' && plan.row) {
      toUpdate.push(plan.row)
      report.services.updated++
      if (plan.repriced) report.services.repriced++
      if (plan.reactivated) report.services.reactivated++
    }
  }
  for (const part of chunks(toCreate, WRITE_CHUNK)) must(await db.from('services').insert(part), 'create services')
  for (const part of chunks(toUpdate, WRITE_CHUNK)) {
    must(await db.from('services').upsert(part, { onConflict: 'id' }), 'update services')
  }
  report.services.created = toCreate.length

  // 6. Deactivate what disappeared. Rows are kept so orders / history stay intact.
  if (!deactivationBlocked && diff.missing.length > 0) {
    const missingIds = diff.missing.map((m) => m.id)
    for (const part of chunks(missingIds, ID_CHUNK)) {
      must(await db.from('provider_services').update({ is_active: false }).in('id', part), 'deactivate provider_services')
    }
    const serviceIds = missingIds
      .map((id) => serviceByPS.get(id))
      .filter((s): s is ExistingService => !!s && s.is_active)
      .map((s) => s.id)
    for (const part of chunks(serviceIds, ID_CHUNK)) {
      must(await db.from('services').update({ is_active: false }).in('id', part), 'deactivate services')
    }
    report.deactivated = missingIds.length
    report.services.deactivated = serviceIds.length
  }
  return report
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    console.error('sync-catalog: missing Supabase configuration')
    return json({ error: 'server_misconfigured' }, 500)
  }
  if (!isAuthorized(req.headers, { cronSecret: Deno.env.get('CRON_SECRET'), serviceRoleKey: serviceKey })) {
    return json({ error: 'unauthorized' }, 401)
  }

  let onlyProvider: string | undefined
  try {
    const body = await req.json()
    if (typeof body?.providerId === 'string') onlyProvider = body.providerId
  } catch { /* empty body is fine */ }

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const reports: ProviderSyncReport[] = []
  try {
    let q = db.from('providers').select('id, name, api_url, api_key_encrypted').eq('is_active', true).order('priority', { ascending: false })
    if (onlyProvider) q = q.eq('id', onlyProvider)
    const providers = must(await q, 'load providers') as ProviderRow[]

    const rules = (must(
      await db.from('price_rules').select('id, type, value, platform, category_id, service_id, min_rate, max_rate, priority, is_active').eq('is_active', true),
      'load price_rules',
    ) as PriceRule[]).map((r) => ({
      ...r,
      value: Number(r.value),
      min_rate: r.min_rate == null ? null : Number(r.min_rate),
      max_rate: r.max_rate == null ? null : Number(r.max_rate),
    }))

    for (const provider of providers) {
      try {
        reports.push(await syncProvider(db, provider, rules))
      } catch (e) {
        console.error(`sync-catalog: provider ${provider.name} failed`, e)
        const failed = emptyProviderReport(provider.name)
        failed.status = 'failed'
        failed.error = e instanceof Error ? e.message : 'unknown error'
        reports.push(failed)
      }
    }
  } catch (e) {
    console.error('sync-catalog: aborted', e)
    return json({ error: 'internal_error' }, 500)
  }

  return json(summarize(reports))
})
