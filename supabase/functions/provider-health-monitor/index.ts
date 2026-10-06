// Supabase Edge Function (Deno): POST /provider-health-monitor   (scheduler only, run every minute)
//
// Pings every active, routing-enabled provider with a cheap authenticated call (balance, 8 s timeout),
// stores providers.health_status (healthy | unavailable) + last_health_check, appends provider_health_log and
// alerts admins on Telegram when a provider goes down or comes back, stores the balance it just read and
// raises ONE low-balance alert per dip (providers.balance_alert_sent is the lock). The routing engine reads health_status,
// so failover to the next-best offer happens on the very next order.
//
// Auth: header `x-cron-secret: $CRON_SECRET` or `Authorization: Bearer <service role key>`. Never callable by clients.
// Secrets: CRON_SECRET, TELEGRAM_BOT_TOKEN (alerts), PROVIDER_KEY_SECRET / PROVIDER_<NAME>_API_KEY, MOCK_MODE (dev only).
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { isAuthorized } from '../_shared/catalog-sync.ts'
import { PING_TIMEOUT_MS, isBalanceParseError, runHealthChecks, type MonitoredProvider } from '../_shared/health-monitor.ts'
import { createNotifier } from '../_shared/notify-db.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import { SMMProviderError, createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'
import type { HealthStatus } from '../_shared/types.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

interface ProviderRow extends MonitoredProvider {
  apiUrl: string
  apiKeyEncrypted: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    console.error('provider-health-monitor: missing Supabase configuration')
    return json({ error: 'server_misconfigured' }, 500)
  }
  if (!isAuthorized(req.headers, { cronSecret: Deno.env.get('CRON_SECRET'), serviceRoleKey: serviceKey })) {
    return json({ error: 'unauthorized' }, 401)
  }

  // service_role: bypasses RLS for the provider updates and the log.
  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const notify = createNotifier(db, Deno.env)
  const mockMode = Deno.env.get('MOCK_MODE') === 'true'

  try {
    const report = await runHealthChecks<ProviderRow>({
      async listProviders() {
        const { data, error } = await db
          .from('providers')
          .select('id, name, api_url, api_key_encrypted, health_status')
          .eq('is_active', true)
          .eq('routing_enabled', true)
        if (error) throw new Error(`load providers: ${error.message}`)
        return (data ?? []).map((r: Record<string, unknown>) => ({
          id: String(r.id), name: String(r.name), apiUrl: String(r.api_url),
          apiKeyEncrypted: (r.api_key_encrypted as string | null) ?? null, healthStatus: r.health_status as HealthStatus,
        }))
      },

      async ping(p) {
        const apiKey = await resolveProviderApiKey({ name: p.name, api_key_encrypted: p.apiKeyEncrypted }, Deno.env)
        // Without a key the adapter would silently run in mock mode and report "healthy": that is a lie in production.
        if (!apiKey && !mockMode) throw new SMMProviderError('misconfigured', 'no API key configured')
        const adapter = createSMMv2Adapter(
          { id: p.id, name: p.name, apiUrl: p.apiUrl, apiKey, timeoutMs: PING_TIMEOUT_MS },
          { MOCK_MODE: Deno.env.get('MOCK_MODE') },
        )
        try {
          return await adapter.getBalance()
        } catch (e) {
          // The panel answered but the balance is unreadable: it is up, so no outage and no balance update.
          if (isBalanceParseError(e)) return
          throw e
        }
      },

      async saveBalance(p, reading, at) {
        const patch: Record<string, unknown> = { provider_balance: reading.balance, last_balance_sync: at }
        if (reading.currency) patch.currency = reading.currency
        const { data, error } = await db
          .from('providers')
          .update(patch)
          .eq('id', p.id)
          .select('low_balance_threshold, balance_alert_sent, currency')
          .single()
        if (error) throw new Error(`save balance: ${error.message}`)
        return { threshold: Number(data.low_balance_threshold), alertSent: data.balance_alert_sent === true, currency: String(data.currency) }
      },

      async setBalanceAlertSent(p, from, to) {
        const { data, error } = await db
          .from('providers')
          .update({ balance_alert_sent: to })
          .eq('id', p.id)
          .eq('balance_alert_sent', from)
          .select('id')
        if (error) throw new Error(`balance alert lock: ${error.message}`)
        return (data ?? []).length > 0
      },

      async notifyLowBalance(p, reading, at) {
        const { data: admins } = await db.from('users').select('id').eq('is_admin', true).eq('is_banned', false)
        const outcomes = await Promise.all((admins ?? []).map((a: { id: string }) =>
          notify(a.id, { type: 'provider_low_balance', providerName: p.name, balance: reading.balance, currency: reading.currency }, `provider-balance:${p.id}:${at}`)))
        return outcomes.some((o) => o === 'sent' || o === 'mock_logged' || o === 'duplicate')
      },

      async applyCheck(p, from, to, checkedAt) {
        if (from === to) {
          const { error } = await db.from('providers').update({ last_health_check: checkedAt }).eq('id', p.id)
          if (error) throw new Error(`touch provider: ${error.message}`)
          return 'unchanged'
        }
        // Compare-and-set: only the run that actually flips the status may alert.
        const { data, error } = await db
          .from('providers')
          .update({ health_status: to, last_health_check: checkedAt })
          .eq('id', p.id)
          .eq('health_status', from)
          .select('id')
        if (error) throw new Error(`update provider health: ${error.message}`)
        return data && data.length > 0 ? 'changed' : 'lost_race'
      },

      async appendLog(e) {
        const { error } = await db.from('provider_health_log').insert({
          provider_id: e.providerId, status: e.status, previous_status: e.previousStatus,
          latency_ms: e.latencyMs, error_kind: e.errorKind, checked_at: e.checkedAt,
        })
        if (error) throw new Error(`health log: ${error.message}`)
      },

      async notify(p, kind, checkedAt) {
        const { data: admins } = await db.from('users').select('id').eq('is_admin', true).eq('is_banned', false)
        const status = kind === 'down' ? 'unavailable' : 'healthy'
        await Promise.all((admins ?? []).map((a: { id: string }) =>
          notify(a.id, { type: 'provider_health', providerName: p.name, status }, `provider-health:${p.id}:${status}:${checkedAt}`)))
      },
    })
    return json({ success: true, ...report, providers: report.providers.map(({ name, from, to, alert, balanceAlert, errorKind }) => ({ name, from, to, alert, balanceAlert, errorKind })) })
  } catch (e) {
    console.error('provider-health-monitor failed', e instanceof Error ? e.message : 'unknown')
    return json({ error: 'server_error' }, 500)
  }
})
