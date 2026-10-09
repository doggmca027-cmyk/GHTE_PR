// Supabase Edge Function (Deno): POST /sync-catalog  { providerId?: uuid, republishOffset?: number, republishLimit?: number }
//   republishOffset / republishLimit (with providerId): put that slice of the provider's catalogue on the storefront again instead of what is new or
//   changed, e.g. after the translator improved. A run does a bounded amount of work, so a big catalogue is taken slice by slice.
//
// Pulls every active provider's catalogue THROUGH THE IProviderAdapter CONTRACT and keeps the database in step with it:
// upserts provider_services, re-prices / re-limits the storefront services that are already linked, keeps
// provider_service_offers equal to their provider service, and deactivates (never deletes) what the provider no longer lists.
// It never creates storefront services or categories: new provider services wait in provider_services for an admin.
// The logic lives in _shared/catalog-sync-run.ts (testable with MockProviderAdapter); this file is auth + wiring.
//
// Auth: header `x-cron-secret: $CRON_SECRET` (pg_cron) or `Authorization: Bearer <service role key>`.
// Secrets: CRON_SECRET, PROVIDER_KEY_SECRET (base64 32 bytes, optional),
//          PROVIDER_<NAME>_API_KEY (fallback plaintext key), MOCK_MODE (dev only).
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { createSupabaseCatalogStore, must, type Db } from './store.ts'
import { syncProviderCatalog } from '../_shared/catalog-sync-run.ts'
import { emptyProviderReport, isAuthorized, summarize, type ProviderSyncReport } from '../_shared/catalog-sync.ts'
import { recordHeartbeat } from '../_shared/heartbeat.ts'
import { instrument } from '../_shared/http.ts'
import { registerSecret, type Logger } from '../_shared/logger.ts'
import type { IProviderAdapter } from '../_shared/providers/contract.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import type { PriceRule } from '../_shared/types.ts'

interface ProviderRow {
  id: string
  name: string
  api_url: string
  api_key_encrypted: string | null
  routing_enabled: boolean
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

async function syncProvider(db: Db, provider: ProviderRow, rules: PriceRule[], log: Logger, correlationId: string, republish?: { offset: number; limit: number }): Promise<ProviderSyncReport> {
  const mockMode = Deno.env.get('MOCK_MODE') === 'true'
  const apiKey = await resolveProviderApiKey(provider, Deno.env)
  if (!apiKey && !mockMode) {
    const skipped = emptyProviderReport(provider.name)
    skipped.status = 'skipped'
    skipped.error = 'no API key configured (set api_key_encrypted + PROVIDER_KEY_SECRET, or PROVIDER_<NAME>_API_KEY)'
    return skipped
  }

  registerSecret(apiKey)
  // The only place that knows which concrete adapter talks to this panel; everything after it sees IProviderAdapter.
  const adapter: IProviderAdapter = createSMMv2Adapter(
    { id: provider.id, name: provider.name, apiUrl: provider.api_url, apiKey, correlationId, logger: log },
    { MOCK_MODE: Deno.env.get('MOCK_MODE') },
  )
  return await syncProviderCatalog({ provider, adapter, store: createSupabaseCatalogStore(db), rules, log, republish })
}

Deno.serve(instrument('sync-catalog', async (req: Request, { log, correlationId }): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    log.error('missing Supabase configuration', { error_code: 'server_misconfigured' })
    return json({ error: 'server_misconfigured' }, 500)
  }
  if (!isAuthorized(req.headers, { cronSecret: Deno.env.get('CRON_SECRET'), serviceRoleKey: serviceKey })) {
    return json({ error: 'unauthorized' }, 401)
  }

  let onlyProvider: string | undefined
  let republish: { offset: number; limit: number } | undefined
  try {
    const body = await req.json()
    if (typeof body?.providerId === 'string') onlyProvider = body.providerId
    if (onlyProvider && Number.isInteger(body?.republishOffset) && body.republishOffset >= 0 && Number.isInteger(body?.republishLimit) && body.republishLimit > 0) {
      republish = { offset: body.republishOffset, limit: Math.min(body.republishLimit, 3000) }
    }
  } catch { /* empty body is fine */ }

  const started = Date.now()
  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const reports: ProviderSyncReport[] = []
  try {
    let q = db.from('providers').select('id, name, api_url, api_key_encrypted, routing_enabled').eq('is_active', true).order('priority', { ascending: false })
    // The hourly run keeps the providers that sell current. One with routing switched off (imported, not enabled yet) is only synced when it is
    // asked for by id: a catalogue of tens of thousands of services is not worth the hourly time budget until it is actually used.
    q = onlyProvider ? q.eq('id', onlyProvider) : q.eq('routing_enabled', true)
    const providers = must(await q, 'load providers') as ProviderRow[]

    const rules = (must(
      await db.from('price_rules').select('id, type, value, platform:platforms(slug), category_id, service_id, min_rate, max_rate, priority, is_active').eq('is_active', true),
      'load price_rules',
    ) as unknown as (Omit<PriceRule, 'platform'> & { platform: { slug: string } | null })[]).map((r) => ({
      ...r,
      platform: r.platform?.slug ?? null,
      value: Number(r.value),
      min_rate: r.min_rate == null ? null : Number(r.min_rate),
      max_rate: r.max_rate == null ? null : Number(r.max_rate),
    }))

    for (const provider of providers) {
      try {
        reports.push(await syncProvider(db, provider, rules, log, correlationId, republish))
      } catch (e) {
        log.error('provider sync failed', { err: e, providerId: provider.id, error_code: 'provider_sync_failed' })
        const failed = emptyProviderReport(provider.name)
        failed.status = 'failed'
        failed.error = e instanceof Error ? e.message : 'unknown error'
        reports.push(failed)
      }
    }
  } catch (e) {
    log.error('catalog sync aborted', { err: e, error_code: 'run_failed' })
    await recordHeartbeat(db, 'sync-catalog', { ok: false, startedAt: started, error: e }, log)
    return json({ error: 'internal_error' }, 500)
  }

  log.info('catalog sync complete', { providers: reports.length, failed: reports.filter((r) => r.status === 'failed').length })
  await recordHeartbeat(db, 'sync-catalog', { ok: true, startedAt: started }, log)
  return json(summarize(reports))
}))
