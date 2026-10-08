// The telegram-notifier's brain: takes a batch of due outbox rows, tells each customer through the Bot API and reports the outcome.
// All I/O is injected, so every Telegram answer (delivered, 403, 429, 5xx, timeout) is tested without a network.
//
// Rules:
//   * NEVER throws. One bad row, a Telegram outage or a database hiccup ends that row's attempt, not the run.
//   * 403 (the customer blocked the bot) is permanent: the row is closed as `blocked`, the user is flagged, nothing is retried.
//   * 429 stops the whole run at once (Telegram's limit is per bot, so more sends would only be refused), honours `retry_after`,
//     and hands the rows it did not reach back untouched.
//   * Transient failures (network, timeout, 5xx) go back with an increasing delay; the database turns a row dead after 8 tries.
//   * A cancellation is only announced once its refund is booked; until then the row waits.
//   * The same dedupe key as the worker's fast path (notification_log) means a customer is never told twice.

import { notifyUser, resolveLang, sendTelegramMessage, type NotifyEvent, type NotifyOutcome, type SendResult } from './telegram-notify.ts'

export interface OutboxRow {
  id: string
  kind: 'completed' | 'partial' | 'canceled'
  dedupe_key: string
  attempts: number
  order_id: string
  order_status: string
  quantity: number
  remains: number | null
  charge_amount: number | string
  partial_refund_amount: number | string
  service_name: string | null
  user_id: string
  telegram_id: number | string
  language_code: string | null
  notifications_enabled: boolean
  bot_blocked_recently: boolean
}

export type Completion =
  | { outcome: 'sent' }
  | { outcome: 'skipped'; error: string }
  | { outcome: 'blocked' }
  | { outcome: 'wait'; error: string }
  | { outcome: 'retry'; error: string; retryAfterSeconds?: number }

/** The Telegram message for a row. Amounts come from the order as it is NOW (the refund is booked by the time it is sent). */
export function eventFor(row: OutboxRow): NotifyEvent {
  const base = { orderId: row.order_id, serviceName: row.service_name ?? 'Order', quantity: Number(row.quantity) }
  if (row.kind === 'completed') return { type: 'order_completed', ...base }
  if (row.kind === 'partial') return { type: 'order_partial', ...base, remains: Number(row.remains ?? 0), refundAmount: Number(row.partial_refund_amount) }
  return { type: 'order_canceled', ...base, refundAmount: Number(row.charge_amount) - Number(row.partial_refund_amount) }
}

/**
 * Is the order in the state the message describes? A "canceled" message promises a refund, so it waits for status `refunded`.
 * (completed / partial are final; a completed or partial order refunded later by an admin was still completed / partial when announced.)
 */
export function isReady(row: OutboxRow): boolean {
  if (row.kind === 'canceled') return row.order_status === 'refunded'
  if (row.kind === 'partial') return row.order_status === 'partial' || row.order_status === 'refunded'
  return row.order_status === 'completed' || row.order_status === 'refunded'
}

export interface RunDeps {
  /** claim_notification_batch */
  claimBatch(limit: number): Promise<OutboxRow[]>
  /** complete_notification */
  complete(id: string, completion: Completion): Promise<void>
  /** notification_log claim / release: the dedupe shared with the worker's fast path. */
  dedupe: { claim(key: string, userId: string): Promise<boolean>; release(key: string): Promise<void> }
  botToken?: string
  mock?: boolean
  send?: typeof sendTelegramMessage
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  batchSize?: number
  /** Stop starting rows after this long; the rest are handed back and the next run takes them. */
  budgetMs?: number
  /** Pause between messages (Telegram allows about 30 per second to different chats). */
  paceMs?: number
}

export interface RunStats {
  claimed: number
  sent: number
  skipped: number
  blocked: number
  retried: number
  waiting: number
  rateLimited: boolean
  deferred: number
  errors: number
}

const emptyStats = (): RunStats => ({ claimed: 0, sent: 0, skipped: 0, blocked: 0, retried: 0, waiting: 0, rateLimited: false, deferred: 0, errors: 0 })

/** One row -> what to record. Never throws. */
export async function deliver(row: OutboxRow, deps: RunDeps): Promise<{ completion: Completion; rateLimited: boolean }> {
  const log = deps.log ?? console
  try {
    if (!row.notifications_enabled) return { completion: { outcome: 'skipped', error: 'notifications_off' }, rateLimited: false }
    if (row.bot_blocked_recently) return { completion: { outcome: 'skipped', error: 'bot_blocked' }, rateLimited: false }
    if (!isReady(row)) return { completion: { outcome: 'wait', error: 'refund_not_booked' }, rateLimited: false }

    let last: SendResult | null = null
    const sender = deps.send ?? sendTelegramMessage
    const outcome: NotifyOutcome = await notifyUser(
      {
        botToken: deps.botToken,
        mock: deps.mock,
        claim: (key) => deps.dedupe.claim(key, row.user_id),
        release: (key) => deps.dedupe.release(key),
        send: async (o) => (last = await sender(o)),
        log,
      },
      { chatId: Number(row.telegram_id), lang: resolveLang(row.language_code), enabled: true },
      eventFor(row),
      row.dedupe_key,
    )

    switch (outcome) {
      case 'sent':
      case 'mock_logged':
      case 'duplicate': // the worker's fast path (or an earlier attempt) already told them
        return { completion: { outcome: 'sent' }, rateLimited: false }
      case 'disabled':
        return { completion: { outcome: 'skipped', error: 'notifications_off' }, rateLimited: false }
      case 'unconfigured':
        // a missing bot token is a deployment problem, not the customer's: keep the message until it is fixed
        return { completion: { outcome: 'wait', error: 'bot_not_configured' }, rateLimited: false }
      case 'failed': {
        const r = last as SendResult | null
        if (r && !r.ok) {
          if (r.reason === 'blocked') return { completion: { outcome: 'blocked' }, rateLimited: false }
          if (r.reason === 'rate_limited') {
            return { completion: { outcome: 'retry', error: 'rate_limited', retryAfterSeconds: r.retryAfter ?? 30 }, rateLimited: true }
          }
          if (r.retryable) return { completion: { outcome: 'retry', error: `${r.reason}${r.status ? ` ${r.status}` : ''}` }, rateLimited: false }
          // a permanent refusal other than "blocked" (for example 400: chat not found): no point asking again
          return { completion: { outcome: 'skipped', error: `telegram_${r.status ?? r.reason}` }, rateLimited: false }
        }
        return { completion: { outcome: 'retry', error: 'send_failed' }, rateLimited: false }
      }
      default:
        return { completion: { outcome: 'retry', error: 'unexpected' }, rateLimited: false }
    }
  } catch {
    return { completion: { outcome: 'retry', error: 'unexpected' }, rateLimited: false }
  }
}

/** Claims a batch and delivers it. Never throws. */
export async function runOutbox(deps: RunDeps): Promise<RunStats> {
  const stats = emptyStats()
  const log = deps.log ?? console
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const budget = deps.budgetMs ?? 45_000

  let rows: OutboxRow[]
  try {
    rows = await deps.claimBatch(deps.batchSize ?? 25)
  } catch (e) {
    log.warn('telegram-notifier: could not claim a batch', e instanceof Error ? e.name : 'unknown')
    stats.errors++
    return stats
  }
  stats.claimed = rows.length

  const record = async (row: OutboxRow, completion: Completion) => {
    try {
      await deps.complete(row.id, completion)
    } catch {
      stats.errors++ // the lease expires and the row comes back; the dedupe key keeps a repeat harmless
    }
  }

  let stop = false
  for (const row of rows) {
    if (stop || now() - started > budget) {
      // not reached: hand it back as "wait" so its attempt does not count
      stats.deferred++
      await record(row, { outcome: 'wait', error: 'deferred' })
      continue
    }
    const { completion, rateLimited } = await deliver(row, deps)
    await record(row, completion)
    switch (completion.outcome) {
      case 'sent': stats.sent++; break
      case 'skipped': stats.skipped++; break
      case 'blocked': stats.blocked++; break
      case 'retry': stats.retried++; break
      case 'wait': stats.waiting++; break
    }
    if (rateLimited) {
      stats.rateLimited = true
      stop = true // Telegram's limit is per bot: the rest of the batch would only be refused too
      continue
    }
    if (completion.outcome === 'sent') await sleep(deps.paceMs ?? 40).catch(() => {})
  }
  return stats
}
