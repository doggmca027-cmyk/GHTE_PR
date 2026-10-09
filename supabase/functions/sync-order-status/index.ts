// Supabase Edge Function (Deno): POST /sync-order-status   (call every minute from pg_cron / a scheduler)
//
// Polls the SMM providers for orders that are still moving and keeps our database in step:
//   Completed -> completed | Pending/In progress -> progress fields | Canceled/Fail -> full refund
//   Partial -> exact partial refund | stuck `processing` orders -> recover id or refund after 1 h.
// All money movement goes through idempotent DB functions, so overlapping or repeated runs are safe, and on top of that only ONE run
// works at a time (a lease in worker_locks: a run that finds it taken answers 200 "skipped" and does nothing).
//
// Circuit breaker: a provider whose every status query fails is left alone for 1, 2, 4 ... 60 minutes (providers.sync_backoff_until,
// record_provider_sync_result); its orders drop out of the work list (get_order_sync_batch) until the time is up, then ONE probe
// decides: success closes the breaker, failure doubles the pause. Orders held for a human (processing, no provider order id) are not
// polled at all: there is nobody to ask.
//
// Auth: header `x-cron-secret: $CRON_SECRET` or `Authorization: Bearer <service role key>`.
// Secrets: CRON_SECRET, PROVIDER_KEY_SECRET / PROVIDER_<NAME>_API_KEY, MOCK_MODE (dev only),
//          SYNC_BATCH_SIZE (default 50). (RECONCILE_AFTER_MINUTES is no longer used: held orders are never auto-refunded.)
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { isAuthorized } from '../_shared/catalog-sync.ts'
import {
  emptySyncStats,
  groupOrdersByProvider,
  mergeSyncStats,
  providerPollOutcome,
  syncProviderOrders,
  type SyncEvent,
  type OrderProviderRef,
  type SyncOrder,
  type SyncPorts,
} from '../_shared/order-sync.ts'
import { recordHeartbeat } from '../_shared/heartbeat.ts'
import { withWorkerLock } from '../_shared/worker-lock.ts'
import { instrument } from '../_shared/http.ts'
import { registerSecret, type Logger } from '../_shared/logger.ts'
import { createNotifier } from '../_shared/notify-db.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import type { NotifyEvent } from '../_shared/telegram-notify.ts'
import type { IProviderAdapter } from '../_shared/providers/contract.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'

const DEFAULT_BATCH = 50
/** Stop starting new providers after this long; the next scheduled run picks up the rest. */
const TIME_BUDGET_MS = 100_000
/** Notifications are sent after all DB work, this many at a time, and abandoned past this deadline. */
const NOTIFY_CONCURRENCY = 5
const NOTIFY_DEADLINE_MS = 130_000

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

interface ProviderRow {
  id: string
  name: string
  api_url: string
  api_key_encrypted: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

function buildPorts(db: Db, onEvent: (e: SyncEvent) => void): SyncPorts {
  const check = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`${what}: ${error.message}`)
  }
  return {
    async setProviderOrderId(orderId, providerOrderId) {
      const { error } = await db.from('orders').update({ provider_order_id: providerOrderId }).eq('id', orderId).eq('status', 'processing')
      check(error, 'set provider_order_id')
    },
    async updateOrder(orderId, patch, expect) {
      const { data, error } = await db.from('orders').update(patch).eq('id', orderId).in('status', expect).select('id')
      check(error, 'update order')
      return (data?.length ?? 0) > 0
    },
    async applyPartialRefund(orderId, remains, startCount) {
      const { data, error } = await db.rpc('apply_partial_refund', { p_order_id: orderId, p_remains: remains, p_start_count: startCount })
      check(error, 'apply_partial_refund')
      return Number((data as { partial_refund_amount: number | string }).partial_refund_amount)
    },
    async refundOrder(orderId, comment) {
      const { error } = await db.rpc('refund_order', { p_order_id: orderId, p_amount: null, p_comment: comment })
      check(error, 'refund_order')
    },
    notify: onEvent, // only enqueues; delivery happens after the DB work (see end of handler)
    async touch(orderId) {
      // Any UPDATE bumps updated_at (trigger), so checked orders rotate to the back of the queue.
      await db.from('orders').update({ updated_at: new Date().toISOString() }).eq('id', orderId)
    },
  }
}

/** Turns sync events into Telegram messages. Best effort: nothing in here can throw. */
async function deliverNotifications(db: Db, events: SyncEvent[], started: number, log: Logger): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (events.length === 0) return counts
  try {
    const serviceIds = [...new Set(events.map((e) => e.order.service_id))]
    const { data } = await db.from('services').select('id, name').in('id', serviceIds)
    const names = new Map(((data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]))
    const notify = createNotifier(db, Deno.env)

    const toMessage = (e: SyncEvent): NotifyEvent => {
      const base = { orderId: e.order.id, serviceName: names.get(e.order.service_id) ?? 'Order', quantity: e.order.quantity }
      if (e.type === 'completed') return { type: 'order_completed', ...base }
      if (e.type === 'partial') return { type: 'order_partial', ...base, remains: e.order.remains ?? 0, refundAmount: e.refundAmount ?? 0 }
      return { type: 'order_canceled', ...base, refundAmount: e.refundAmount ?? 0 }
    }

    for (let i = 0; i < events.length; i += NOTIFY_CONCURRENCY) {
      if (Date.now() - started > NOTIFY_DEADLINE_MS) break
      const results = await Promise.all(
        events.slice(i, i + NOTIFY_CONCURRENCY).map((e) => notify(e.order.user_id, toMessage(e), `order:${e.order.id}:${e.type}`)),
      )
      for (const r of results) counts[r] = (counts[r] ?? 0) + 1
    }
  } catch (e) {
    log.warn('notification delivery failed', { err: e, error_code: 'notify_failed' })
  }
  return counts
}

Deno.serve(instrument('sync-order-status', async (req: Request, { log, correlationId }): Promise<Response> => {
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

  const started = Date.now()
  const batchSize = Math.min(200, Math.max(1, Number(Deno.env.get('SYNC_BATCH_SIZE')) || DEFAULT_BATCH))
  const mockMode = Deno.env.get('MOCK_MODE') === 'true'
  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Only one run at a time. A second copy (the scheduler fires every minute, a run can take longer) would poll the same orders and,
  // during a provider outage, double the load on a provider that is already failing.
  const locked = await withWorkerLock(db, 'sync-order-status', () => runSync())
  if (!locked.acquired) {
    log.info('another sync run holds the lease; skipping this one', { error_code: 'sync_busy' })
    return json({ success: true, skipped: 'another_run_in_progress' })
  }
  return locked.value

  async function runSync(): Promise<Response> {
  // The work list comes from SQL (get_order_sync_batch): oldest-checked first; in-flight orders, recoverable held orders and owed
  // refunds; NOT providers in backoff, NOT orders waiting for a human.
  const { data: rows, error } = await db.rpc('get_order_sync_batch', { p_limit: batchSize })
  if (error) {
    log.error('batch query failed', { err: error, error_code: 'batch_query_failed' })
    await recordHeartbeat(db, 'sync-order-status', { ok: false, startedAt: started, error }, log)
    return json({ error: 'internal_error' }, 500)
  }

  // An order is polled at the panel that ACCEPTED it: the provider of its offer (failover picks the offer, and with it the
  // provider, before the order exists). orders.provider_id is only the fallback for orders that have no offer.
  type Row = SyncOrder & OrderProviderRef
  const orders = ((rows ?? []) as unknown as (SyncOrder & { provider_id: string | null; offer_provider_id: string | null; updated_at: string })[]).map((o): Row => ({
    ...o,
    charge_amount: Number(o.charge_amount),
  }))
  const { byProvider, unassigned, mismatched } = groupOrdersByProvider(orders)
  for (const o of mismatched) {
    log.error('order provider and offer provider disagree; not polled', { orderId: o.id, error_code: 'order_provider_mismatch' })
  }

  const events: SyncEvent[] = []
  const ports = buildPorts(db, (e) => void events.push(e))
  const stats = emptySyncStats()
  const skippedProviders: { provider: string; reason: string }[] = []

  if (byProvider.size > 0) {
    const { data: providers, error: pErr } = await db
      .from('providers')
      .select('id, name, api_url, api_key_encrypted')
      .in('id', [...byProvider.keys()])
    if (pErr) {
      log.error('provider query failed', { err: pErr, error_code: 'provider_query_failed' })
      await recordHeartbeat(db, 'sync-order-status', { ok: false, startedAt: started, error: pErr }, log)
      return json({ error: 'internal_error' }, 500)
    }

    for (const provider of (providers ?? []) as ProviderRow[]) {
      const batch = byProvider.get(provider.id) ?? []
      if (Date.now() - started > TIME_BUDGET_MS) {
        skippedProviders.push({ provider: provider.name, reason: 'time budget exhausted; next run will continue' })
        continue
      }
      let apiKey = ''
      try {
        apiKey = await resolveProviderApiKey(provider, Deno.env)
      } catch (e) {
        log.error('cannot decrypt the provider key', { err: e, providerId: provider.id, error_code: 'key_decrypt_failed' })
      }
      if (!apiKey && !mockMode) {
        // Rotate these to the back of the queue so one unconfigured panel cannot starve the others.
        for (const o of batch) await ports.touch(o.id)
        skippedProviders.push({ provider: provider.name, reason: 'no API key configured' })
        continue
      }
      registerSecret(apiKey)
      const adapter: IProviderAdapter = createSMMv2Adapter(
        { id: provider.id, name: provider.name, apiUrl: provider.api_url, apiKey, correlationId, logger: log },
        { MOCK_MODE: Deno.env.get('MOCK_MODE') },
      )
      const result = await syncProviderOrders(batch, adapter, ports)
      mergeSyncStats(stats, result)

      // The circuit breaker. A provider that answered (even to say "I do not know this order") closes it; one whose every status query
      // failed opens it for 1, 2, 4 ... 60 minutes. Nothing was asked (only refunds to finish) = nothing to learn.
      const outcome = providerPollOutcome(result)
      if (outcome) {
        const { data: breaker, error: breakerError } = await db.rpc('record_provider_sync_result', { p_provider_id: provider.id, p_ok: outcome === 'ok' })
        if (breakerError) log.warn('could not record the provider poll result', { err: breakerError, providerId: provider.id, error_code: 'breaker_update_failed' })
        else if (outcome === 'failed') {
          const b = breaker as { failures: number; backoff_until: string }
          log.warn('provider status polling failed; backing off', { providerId: provider.id, provider: provider.name, failures: b.failures, backoffUntil: b.backoff_until, error_code: 'provider_poll_backoff' })
          skippedProviders.push({ provider: provider.name, reason: `status queries failed; paused until ${b.backoff_until}` })
        }
      }
    }
  }

  // Orders without a provider id at all (should not exist for these statuses): just rotate them.
  for (const o of [...unassigned, ...mismatched]) await ports.touch(o.id)

  // Telegram messages: strictly after the database work, never able to affect it.
  const notified = await deliverNotifications(db, events, started, log)

  log.info('order sync complete', {
    checked: stats.checked, completed: stats.completed, progressed: stats.progressed, canceled: stats.canceledRefunded,
    partial: stats.partial, held: stats.heldForReconciliation, errors: stats.errors.length, skippedProviders: skippedProviders.length,
  })
  await recordHeartbeat(db, 'sync-order-status', { ok: true, startedAt: started }, log)
  return json({ ...stats, notifications: notified, partialRefunded: stats.partialRefundedUnits / 10_000, skippedProviders, durationMs: Date.now() - started })
  }
}))
