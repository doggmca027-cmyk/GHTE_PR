// Supabase Edge Function (Deno): POST /telegram-notifier   (scheduler only, run every minute)
//
// Tells customers on Telegram that their order is completed / partially completed / canceled (with the refund), from the durable
// notification_outbox that a database trigger fills in the same transaction as the status change. It is fully asynchronous:
// the trigger only inserts a row; this function, on its own schedule, claims due rows (FOR UPDATE SKIP LOCKED, 2-minute lease),
// sends them and records the outcome. Nothing here runs inside an order transaction or inside the sync-order-status loop.
//
//   403 (the customer blocked the bot)  -> row closed as `blocked`, the user flagged for 30 days, never retried
//   429 (rate limited)                  -> the run stops at once, Telegram's retry_after is honoured, the rest is handed back
//   network / timeout / 5xx             -> retried with 1, 2, 5, 15, 30, 60 min back-off; dead after 8 tries or 24 h
//   cancellation whose refund is not booked yet -> waits (the message promises a refund)
// The worker's own fast path and this function share one dedupe key per event: the customer is never told twice.
//
// Auth: header `x-cron-secret: $CRON_SECRET` or `Authorization: Bearer <service role key>`. Never callable by clients.
// Secrets: CRON_SECRET, TELEGRAM_BOT_TOKEN, MOCK_MODE (dev only). Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { isAuthorized } from '../_shared/catalog-sync.ts'
import { recordHeartbeat } from '../_shared/heartbeat.ts'
import { instrument } from '../_shared/http.ts'
import { registerSecret } from '../_shared/logger.ts'
import { runOutbox, type Completion, type OutboxRow } from '../_shared/notification-outbox.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

Deno.serve(instrument('telegram-notifier', async (req: Request, { log }): Promise<Response> => {
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
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
  registerSecret(botToken) // the token is part of every Bot API URL: it must never reach a log line
  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  try {
    const stats = await runOutbox({
      botToken,
      mock: Deno.env.get('MOCK_MODE') === 'true',
      log: { info: (...a) => log.info(String(a[0])), warn: (...a) => log.warn(String(a[0])) },
      async claimBatch(limit) {
        const { data, error } = await db.rpc('claim_notification_batch', { p_limit: limit })
        if (error) throw new Error(`claim_notification_batch: ${error.message}`)
        return (data ?? []) as OutboxRow[]
      },
      async complete(id: string, c: Completion) {
        const { error } = await db.rpc('complete_notification', {
          p_id: id,
          p_outcome: c.outcome,
          p_retry_after_seconds: c.outcome === 'retry' ? (c.retryAfterSeconds ?? null) : null,
          p_error: 'error' in c ? c.error : null,
        })
        if (error) throw new Error(`complete_notification: ${error.message}`)
      },
      dedupe: {
        async claim(key, userId) {
          const { error } = await db.from('notification_log').insert({ dedupe_key: key, user_id: userId, kind: key.split(':')[2] ?? 'order' })
          return !error // 23505 = already told (by the fast path or an earlier attempt)
        },
        async release(key) {
          await db.from('notification_log').delete().eq('dedupe_key', key)
        },
      },
    })

    if (stats.rateLimited) log.warn('telegram rate limit hit; the run stopped early', { error_code: 'telegram_rate_limited' })
    if (stats.blocked > 0) log.info('customers who blocked the bot', { error_code: 'user_blocked_bot', count: stats.blocked })
    log.info('notifier run complete', { ...stats })
    await recordHeartbeat(db, 'telegram-notifier', { ok: true, startedAt: started }, log)
    return json({ success: true, ...stats, durationMs: Date.now() - started })
  } catch (e) {
    log.error('run failed', { err: e, error_code: 'run_failed' })
    await recordHeartbeat(db, 'telegram-notifier', { ok: false, startedAt: started, error: e }, log)
    return json({ error: 'server_error' }, 500)
  }
}))
