// Live flight-test observer, pure part (docs/LIVE_TEST_RUNBOOK.md). STRICTLY READ-ONLY.
//
// One poll = ONE statement: a single SELECT that returns the whole picture as a JSON document (the order, its status history and
// wallet entries, the providers with their circuit breaker, the worker heartbeats, the sync lease, open reconciliation cases and
// the notification outbox). Every statement passes assertReadOnly (the same guard the live smoke test uses), so nothing in here
// can write: there is no code path that sends anything else. The provider's API key is never selected.
//
// This file has no I/O of its own: the caller injects the query function, the clock, the sleep and the output, so the whole loop
// is tested against the real schema without a network.

import { assertReadOnly } from './live-smoke.ts'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

export const WATCHED_WORKERS = ['sync-order-status', 'provider-health-monitor', 'telegram-notifier'] as const
/** The order moves on by itself in these states. */
export const IN_FLIGHT = new Set(['paid', 'processing', 'submitted', 'in_progress'])
/** Final states: nothing more will happen to the order or the money. */
export const FINAL = new Set(['completed', 'partial', 'refunded'])
/** The provider gave up on the order; the sync worker owes the customer a refund, after which the status becomes `refunded`. */
export const REFUND_PENDING = new Set(['canceled', 'failed'])

/** A worker that runs every minute and has not succeeded for this long has missed at least two runs. */
export const STALE_WORKER_MS = 150_000
/** The sync lease lasts 140 s (_shared/worker-lock.ts); held longer than this means the run overran. */
export const LEASE_MS = 150_000

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/** Watch one order by id, or (watch mode) the first order created at or after `since` (ISO, UTC). */
export type Target = { orderId: string } | { since: string }

export function snapshotQuery(target: Target): string {
  let filter: string
  if ('orderId' in target) {
    if (!UUID_RE.test(target.orderId)) throw new Error('order id must be a UUID')
    filter = `o.id = '${target.orderId.toLowerCase()}'::uuid`
  } else {
    if (!ISO_RE.test(target.since)) throw new Error('since must be an ISO UTC timestamp')
    filter = `o.created_at >= '${target.since}'::timestamptz`
  }
  // The history is selected as a whole row (minus its id) on purpose: the column holding the admin's note is named like a SQL keyword
  // that assertReadOnly forbids as a word, and no note is ever written by this tool.
  return `with o as (
  select o.id, o.status::text as status, o.provider_order_id, o.error_message, o.quantity, o.remains, o.start_count,
         o.charge_amount, o.cost_amount, o.profit_amount, o.partial_refund_amount,
         coalesce(po.provider_id, o.provider_id) as effective_provider_id, o.created_at, o.updated_at
    from public.orders o
    left join public.provider_service_offers po on po.id = o.provider_offer_id
   where ${filter}
   order by o.created_at
   limit 1
)
select jsonb_build_object(
  'now', now(),
  'order', (select to_jsonb(o) from o),
  'history', coalesce((select jsonb_agg(to_jsonb(h) - 'id' order by h.created_at) from public.order_status_history h where h.order_id = (select id from o)), '[]'::jsonb),
  'wallet', coalesce((select jsonb_agg(jsonb_build_object('type', t.type::text, 'status', t.status::text, 'amount', t.amount, 'balance_after', t.balance_after, 'at', t.created_at) order by t.created_at, t.id)
                        from public.wallet_transactions t where t.reference_id = (select id from o)), '[]'::jsonb),
  'providers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'is_active', p.is_active, 'routing_enabled', p.routing_enabled,
                          'health_status', p.health_status::text, 'last_health_check', p.last_health_check, 'provider_balance', p.provider_balance,
                          'currency', p.currency, 'last_balance_sync', p.last_balance_sync, 'sync_backoff_until', p.sync_backoff_until,
                          'sync_failure_count', p.sync_failure_count) order by p.priority desc, p.name)
                        from public.providers p), '[]'::jsonb),
  'heartbeats', coalesce((select jsonb_agg(jsonb_build_object('worker', w.worker, 'last_run_at', w.last_run_at, 'last_success_at', w.last_success_at,
                          'last_error_at', w.last_error_at, 'last_error', w.last_error, 'runs', w.runs, 'failures', w.failures) order by w.worker)
                        from public.worker_heartbeats w where w.worker = any(array[${WATCHED_WORKERS.map((w) => `'${w}'`).join(', ')}])), '[]'::jsonb),
  'lease', (select jsonb_build_object('held', l.locked_until > now(), 'locked_until', l.locked_until, 'acquired_at', l.acquired_at)
             from public.worker_locks l where l.name = 'sync-order-status'),
  'open_cases', (select count(*) from public.reconciliation_cases c where c.status = 'open' and c.entity_type = 'order' and c.entity_id = (select id::text from o)),
  'outbox', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind, 'status', n.status::text, 'attempts', n.attempts, 'last_error', n.last_error) order by n.created_at)
                        from public.notification_outbox n where n.order_id = (select id from o)), '[]'::jsonb)
) as snapshot`
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface OrderRow {
  id: string; status: string; provider_order_id: string | null; error_message: string | null
  quantity: number; remains: number | null; start_count: number | null
  charge_amount: number; cost_amount: number | null; profit_amount: number | null; partial_refund_amount: number | null
  effective_provider_id: string | null; created_at: string; updated_at: string
}
export interface HistoryRow { old_status: string | null; new_status: string; comment: string | null; created_at: string }
export interface WalletRow { type: string; status: string; amount: number; balance_after: number | null; at: string }
export interface ProviderRow {
  id: string; name: string; is_active: boolean; routing_enabled: boolean; health_status: string; last_health_check: string | null
  provider_balance: number | null; currency: string | null; last_balance_sync: string | null; sync_backoff_until: string | null; sync_failure_count: number
}
export interface HeartbeatRow { worker: string; last_run_at: string | null; last_success_at: string | null; last_error_at: string | null; last_error: string | null; runs: number; failures: number }
export interface LockRow { held: boolean; locked_until: string | null; acquired_at: string | null }
export interface OutboxRow { kind: string; status: string; attempts: number; last_error: string | null }
export interface Snapshot {
  /** The DATABASE clock: every age below is measured against it, so a skewed laptop clock cannot fake a stale worker. */
  now: string
  order: OrderRow | null
  history: HistoryRow[]
  wallet: WalletRow[]
  providers: ProviderRow[]
  heartbeats: HeartbeatRow[]
  lock: LockRow | null
  openCases: number
  outbox: OutboxRow[]
}

type Obj = Record<string, unknown>
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : [])

/** The one row the query returns -> a typed snapshot. Throws on anything that is not that document. */
export function parseSnapshot(rows: unknown): Snapshot {
  const first = Array.isArray(rows) ? (rows[0] as Obj | undefined) : undefined
  const raw = first?.snapshot as Obj | string | undefined
  const s: Obj | undefined = typeof raw === 'string' ? (JSON.parse(raw) as Obj) : raw
  if (!s || typeof s !== 'object' || typeof s.now !== 'string') throw new Error('unexpected answer: no snapshot document')
  const o = s.order as Obj | null | undefined
  const lock = s.lease as Obj | null | undefined
  return {
    now: s.now,
    order: o
      ? {
          id: String(o.id), status: String(o.status), provider_order_id: str(o.provider_order_id), error_message: str(o.error_message),
          quantity: Number(o.quantity), remains: num(o.remains), start_count: num(o.start_count), charge_amount: Number(o.charge_amount),
          cost_amount: num(o.cost_amount), profit_amount: num(o.profit_amount), partial_refund_amount: num(o.partial_refund_amount),
          effective_provider_id: str(o.effective_provider_id), created_at: String(o.created_at), updated_at: String(o.updated_at),
        }
      : null,
    history: arr(s.history).map((h) => ({ old_status: str(h.old_status), new_status: String(h.new_status), comment: str(h.comment), created_at: String(h.created_at) })),
    wallet: arr(s.wallet).map((w) => ({ type: String(w.type), status: String(w.status), amount: Number(w.amount), balance_after: num(w.balance_after), at: String(w.at) })),
    providers: arr(s.providers).map((p) => ({
      id: String(p.id), name: String(p.name), is_active: p.is_active === true, routing_enabled: p.routing_enabled === true, health_status: String(p.health_status),
      last_health_check: str(p.last_health_check), provider_balance: num(p.provider_balance), currency: str(p.currency), last_balance_sync: str(p.last_balance_sync),
      sync_backoff_until: str(p.sync_backoff_until), sync_failure_count: Number(p.sync_failure_count ?? 0),
    })),
    heartbeats: arr(s.heartbeats).map((h) => ({
      worker: String(h.worker), last_run_at: str(h.last_run_at), last_success_at: str(h.last_success_at), last_error_at: str(h.last_error_at),
      last_error: str(h.last_error), runs: Number(h.runs ?? 0), failures: Number(h.failures ?? 0),
    })),
    lock: lock ? { held: lock.held === true, locked_until: str(lock.locked_until), acquired_at: str(lock.acquired_at) } : null,
    openCases: Number(s.open_cases ?? 0),
    outbox: arr(s.outbox).map((n) => ({ kind: String(n.kind), status: String(n.status), attempts: Number(n.attempts ?? 0), last_error: str(n.last_error) })),
  }
}

/** The provider that serves the order (its offer's provider), else the only provider there is. */
export function providerOf(s: Snapshot): ProviderRow | null {
  if (s.order?.effective_provider_id) return s.providers.find((p) => p.id === s.order!.effective_provider_id) ?? null
  return s.providers.length === 1 ? s.providers[0] : null
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** $0.015, $4.50, -$0.015: trailing zeros trimmed, never fewer than two decimals. */
const money = (v: number | null, digits = 4) => {
  if (v === null) return '-'
  const [whole, frac = ''] = Math.abs(v).toFixed(digits).replace(/0+$/, '').split('.')
  return `${v < 0 ? '-' : ''}$${whole}.${frac.padEnd(2, '0')}`
}
export const clock = (iso: string | number) => new Date(iso).toISOString().slice(11, 19)
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`
}
const ageSince = (iso: string | null, now: number) => (iso ? age(now - Date.parse(iso)) : 'never')

// ---------------------------------------------------------------------------
// What changed between two polls
// ---------------------------------------------------------------------------

/** Lines to print for everything that is new in `next` compared with `prev` (null = the first poll). */
export function diff(prev: Snapshot | null, next: Snapshot): string[] {
  const out: string[] = []
  const o = next.order
  const po = prev?.order ?? null

  if (o && !po) {
    out.push(`ORDER   found ${o.id}: ${o.quantity} units, charge ${money(o.charge_amount)}, cost ${money(o.cost_amount)}, status ${o.status}`)
  }
  if (o) {
    for (const h of next.history.slice(prev && po && prev.order?.id === o.id ? prev.history.length : 0)) {
      out.push(`STATUS  ${clock(h.created_at)} ${h.old_status ?? '(new)'} -> ${h.new_status}${h.comment ? ` (${h.comment})` : ''}`)
    }
    const field = <T,>(label: string, a: T | null | undefined, b: T | null | undefined, show: (v: T) => string = String) => {
      if (po && a !== b) out.push(`ORDER   ${label}: ${a === null || a === undefined ? '-' : show(a)} -> ${b === null || b === undefined ? '-' : show(b)}`)
    }
    field('provider_order_id', po?.provider_order_id, o.provider_order_id)
    field('error_message', po?.error_message, o.error_message)
    field('start_count', po?.start_count, o.start_count)
    field('remains', po?.remains, o.remains)
    field('partial_refund_amount', po?.partial_refund_amount, o.partial_refund_amount, (v) => money(v))
    if (!po && o.provider_order_id) out.push(`ORDER   provider_order_id: ${o.provider_order_id}`)
    if (!po && o.error_message) out.push(`ORDER   error_message: ${o.error_message}`)

    for (const w of next.wallet.slice(prev && prev.order?.id === o.id ? prev.wallet.length : 0)) {
      out.push(`WALLET  ${clock(w.at)} ${w.type} ${w.amount < 0 ? '-' : '+'}${money(Math.abs(w.amount))} (${w.status}), balance after ${money(w.balance_after)}`)
    }
    if (next.openCases !== (prev?.openCases ?? 0)) out.push(`RECON   open reconciliation cases for this order: ${prev?.openCases ?? 0} -> ${next.openCases}`)
    const sig = (s: Snapshot | null) => s?.outbox.map((n) => `${n.kind}:${n.status}:${n.attempts}`).join(',') ?? ''
    if (sig(prev) !== sig(next) && next.outbox.length > 0) out.push(`NOTIFY  ${next.outbox.map((n) => `${n.kind} ${n.status} (attempt ${n.attempts}${n.last_error ? `, ${n.last_error}` : ''})`).join('; ')}`)
  }

  for (const p of next.providers) {
    const before = prev?.providers.find((x) => x.id === p.id)
    if (!before) {
      if (!prev) out.push(`PROVIDER ${p.name}: ${p.health_status}, routing ${p.routing_enabled ? 'on' : 'off'}, balance ${money(p.provider_balance, 2)}${p.currency ? ` ${p.currency}` : ''}`)
      continue
    }
    if (before.health_status !== p.health_status) out.push(`PROVIDER ${p.name}: health ${before.health_status} -> ${p.health_status}`)
    if (before.routing_enabled !== p.routing_enabled) out.push(`PROVIDER ${p.name}: routing ${before.routing_enabled ? 'on' : 'off'} -> ${p.routing_enabled ? 'on' : 'off'}`)
    if (before.provider_balance !== p.provider_balance) out.push(`PROVIDER ${p.name}: balance ${money(before.provider_balance, 4)} -> ${money(p.provider_balance, 4)}`)
    if (before.sync_failure_count !== p.sync_failure_count) out.push(`BREAKER ${p.name}: failed polls in a row ${before.sync_failure_count} -> ${p.sync_failure_count}`)
    if (before.sync_backoff_until !== p.sync_backoff_until) {
      out.push(p.sync_backoff_until && Date.parse(p.sync_backoff_until) > Date.parse(next.now)
        ? `BREAKER ${p.name}: OPEN until ${clock(p.sync_backoff_until)} UTC`
        : `BREAKER ${p.name}: closed`)
    }
  }

  for (const h of next.heartbeats) {
    const before = prev?.heartbeats.find((x) => x.worker === h.worker)
    if (before && h.last_error_at && h.last_error_at !== before.last_error_at) out.push(`WORKER  ${h.worker} reported an error: ${h.last_error ?? '(no message)'}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// What is wrong right now
// ---------------------------------------------------------------------------

export type Severity = 'warn' | 'critical'
export interface Finding { severity: Severity; code: string; message: string }

export function assess(s: Snapshot, opts: { stuckAfterMs?: number } = {}): Finding[] {
  const out: Finding[] = []
  const add = (severity: Severity, code: string, message: string) => out.push({ severity, code, message })
  const now = Date.parse(s.now)
  const o = s.order
  const inFlight = !!o && IN_FLIGHT.has(o.status)
  // a problem with the sync path only matters as much as the order that depends on it
  const loud: Severity = inFlight ? 'critical' : 'warn'

  const sync = s.heartbeats.find((h) => h.worker === 'sync-order-status')
  if (!sync || !sync.last_success_at) add(loud, 'sync_never_ran', 'sync-order-status has never reported a successful run')
  else if (now - Date.parse(sync.last_success_at) > STALE_WORKER_MS) {
    add(loud, 'sync_stale', `sync-order-status last succeeded ${ageSince(sync.last_success_at, now)} ago (it should run every minute)`)
  }
  if (sync?.last_error_at && (!sync.last_success_at || Date.parse(sync.last_error_at) > Date.parse(sync.last_success_at))) {
    add('warn', 'sync_error', `sync-order-status last run failed: ${sync.last_error ?? 'no message'}`)
  }
  const monitor = s.heartbeats.find((h) => h.worker === 'provider-health-monitor')
  if (!monitor?.last_success_at || now - Date.parse(monitor.last_success_at) > STALE_WORKER_MS) {
    add('warn', 'monitor_stale', `provider-health-monitor last succeeded ${ageSince(monitor?.last_success_at ?? null, now)} ago (provider health and balance are not being refreshed)`)
  }
  if (s.lock?.held && s.lock.acquired_at && now - Date.parse(s.lock.acquired_at) > LEASE_MS) {
    add('warn', 'lock_overrun', `the sync lease has been held for ${ageSince(s.lock.acquired_at, now)} (a run that long usually means a provider is hanging)`)
  }

  const p = providerOf(s)
  if (p) {
    if (p.sync_backoff_until && Date.parse(p.sync_backoff_until) > now) {
      add(loud, 'breaker_open', `circuit breaker OPEN for ${p.name} until ${clock(p.sync_backoff_until)} UTC (${p.sync_failure_count} failed polls in a row): the order is NOT being polled meanwhile`)
    } else if (p.sync_failure_count > 0) {
      add('warn', 'breaker_failures', `${p.name}: ${p.sync_failure_count} failed status poll(s) in a row (breaker closed, next failure doubles the pause)`)
    }
    if (p.health_status !== 'healthy') add('warn', 'provider_health', `${p.name} health is ${p.health_status}`)
  } else if (o) {
    add('warn', 'provider_unknown', 'cannot tell which provider serves this order')
  }

  if (o) {
    if (o.error_message?.startsWith('needs_reconciliation')) add('critical', 'held_for_human', `the order is held for a human: ${o.error_message}`)
    else if (o.error_message?.startsWith('needs_refund')) add('warn', 'refund_owed', `a refund is owed and the sync worker will book it: ${o.error_message}`)
    // a refund that is owed opens a case for a few minutes as a matter of course (the detector closes it after the refund); anything else is for a human
    if (s.openCases > 0) add(o.error_message?.startsWith('needs_refund') ? 'warn' : 'critical', 'open_case', `${s.openCases} open reconciliation case(s) for this order (Admin -> Reconciliation)`)
    const since = now - Date.parse(o.updated_at)
    if (inFlight && since > (opts.stuckAfterMs ?? 15 * 60_000)) add('warn', 'no_progress', `the order has not changed for ${age(since)}`)
    if (REFUND_PENDING.has(o.status) && since > 3 * 60_000) add('warn', 'refund_slow', `the order is ${o.status} and the refund is not booked after ${age(since)}`)
  }
  if (s.outbox.some((n) => n.status === 'dead')) add('warn', 'notification_dead', 'a Telegram notification for this order could not be delivered')
  return out
}

// ---------------------------------------------------------------------------
// The one-line status
// ---------------------------------------------------------------------------

export function statusLine(s: Snapshot): string {
  const now = Date.parse(s.now)
  const o = s.order
  const sync = s.heartbeats.find((h) => h.worker === 'sync-order-status')
  const monitor = s.heartbeats.find((h) => h.worker === 'provider-health-monitor')
  const p = providerOf(s)
  const breaker = !p ? 'breaker ?' : p.sync_backoff_until && Date.parse(p.sync_backoff_until) > now ? `BREAKER OPEN until ${clock(p.sync_backoff_until)}` : `breaker closed (fails ${p.sync_failure_count})`
  return [
    clock(s.now),
    o ? `order ${o.status}${o.provider_order_id ? ` #${o.provider_order_id}` : ''}${o.remains !== null ? ` remains ${o.remains}` : ''}` : 'no order yet',
    `sync ${ageSince(sync?.last_success_at ?? null, now)} ago${s.lock?.held ? ' (running)' : ''}`,
    `health ${ageSince(monitor?.last_success_at ?? null, now)} ago`,
    breaker,
    p ? `${p.name}: ${p.health_status}, ${money(p.provider_balance, 2)}` : 'provider ?',
  ].join(' | ')
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const same = (a: number, b: number) => Math.abs(a - b) < 0.00005

export interface Verdict { ok: boolean; lines: string[] }

/** Judges the final snapshot: did the order complete, and does the money add up? `criticals` = codes seen during the whole run. */
export function verdict(s: Snapshot, criticals: string[]): Verdict {
  const lines: string[] = []
  let ok = true
  const check = (pass: boolean, text: string) => {
    lines.push(`${pass ? '[PASS]' : '[FAIL]'} ${text}`)
    if (!pass) ok = false
  }
  const o = s.order
  if (!o) return { ok: false, lines: ['[FAIL] no order was observed'] }

  check(o.status === 'completed', `final status is "${o.status}"${o.status === 'completed' ? '' : ' (expected "completed")'}`)
  if (o.status === 'completed') check(!!o.provider_order_id, `provider order id recorded${o.provider_order_id ? ` (#${o.provider_order_id})` : ''}`)

  const done = s.wallet.filter((w) => w.status === 'completed')
  const purchases = done.filter((w) => w.type === 'purchase')
  const refunds = done.filter((w) => w.type === 'refund')
  const refunded = refunds.reduce((sum, w) => sum + w.amount, 0)
  check(purchases.length === 1 && same(purchases[0].amount, -o.charge_amount), `exactly one purchase entry of -${money(o.charge_amount)} (found ${purchases.length}: ${purchases.map((w) => money(w.amount)).join(', ') || 'none'})`)
  if (o.status === 'completed') check(refunds.length === 0, 'no refund booked on a completed order')
  else if (o.status === 'refunded') check(same(refunded, o.charge_amount), `refunds add up to the charge (${money(refunded)} of ${money(o.charge_amount)})`)
  else if (o.status === 'partial') check(same(refunded, o.partial_refund_amount ?? 0), `refunds equal the partial refund (${money(refunded)} vs ${money(o.partial_refund_amount)})`)

  if (o.cost_amount !== null && o.profit_amount !== null) {
    check(same(o.charge_amount - o.cost_amount, o.profit_amount), `profit = charge - cost (${money(o.charge_amount)} - ${money(o.cost_amount)} = ${money(o.profit_amount)})`)
    if (o.status === 'completed') check(o.profit_amount >= 0, 'the order was not sold at a loss')
  }
  check(s.openCases === 0, s.openCases === 0 ? 'no reconciliation case is open for this order' : `${s.openCases} reconciliation case(s) open`)
  const uniq = [...new Set(criticals)]
  check(uniq.length === 0, uniq.length === 0 ? 'no critical finding during the whole run (the circuit breaker never tripped on this order)' : `critical finding(s) during the run: ${uniq.join(', ')}`)
  return { ok, lines }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface ObserverDeps {
  /** Runs one SELECT and returns its rows. The caller wires it to a read-only transport. */
  query(sql: string): Promise<unknown>
  sleep(ms: number): Promise<void>
  now(): number
  /** A permanent log line. */
  out(line: string): void
  /** The one-line status after every poll (the CLI overwrites it in place on a terminal). */
  tick(line: string): void
}
export interface ObserverOptions {
  orderId?: string
  /** Watch mode: lock on to the first order created at or after this ISO timestamp. */
  since?: string
  intervalMs: number
  timeoutMs: number
  /** Stop after this many polls in a row failed. */
  maxQueryFailures?: number
  /** Print a snapshot and stop (a connectivity check). */
  once?: boolean
  stuckAfterMs?: number
}
export interface ObserverResult {
  /** 0 = the order completed and everything checks out; 1 = it finished (or the run ended) with something to look at; 2 = the observer could not do its job. */
  exitCode: 0 | 1 | 2
  reason: string
  snapshot: Snapshot | null
  verdict: Verdict | null
}

export async function runObserver(deps: ObserverDeps, opts: ObserverOptions): Promise<ObserverResult> {
  const started = deps.now()
  const maxFailures = opts.maxQueryFailures ?? 5
  let orderId = opts.orderId
  let prev: Snapshot | null = null
  let last: Snapshot | null = null
  let failures = 0
  const shown = new Map<string, string>() // finding code -> message currently displayed
  const criticals = new Set<string>()
  const stamp = (line: string) => `${clock(deps.now())}  ${line}`

  if (!orderId && !opts.since) throw new Error('either an order id or a watch start time is required')
  deps.out(stamp(orderId ? `observing order ${orderId} (read-only, every ${Math.round(opts.intervalMs / 1000)} s, times in UTC)` : `waiting for a new order (read-only, every ${Math.round(opts.intervalMs / 1000)} s, times in UTC)`))

  for (;;) {
    let snap: Snapshot | null = null
    try {
      // the guard runs here as well as in the transport: the loop cannot hand anything but a plain SELECT to `query`
      snap = parseSnapshot(await deps.query(assertReadOnly(snapshotQuery(orderId ? { orderId } : { since: opts.since! }))))
      failures = 0
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // the read-only guard refusing a statement is a bug in this tool, not a flaky network: stop at once
      if (message.startsWith('refused:')) {
        deps.out(stamp(`POLL    ${message.slice(0, 80).replace(/\s+/g, ' ')}`))
        return { exitCode: 2, reason: 'the read-only guard refused the statement', snapshot: last, verdict: null }
      }
      failures++
      deps.out(stamp(`POLL    failed (${failures}/${maxFailures}): ${message}`))
      if (failures >= maxFailures) return { exitCode: 2, reason: 'the database could not be read', snapshot: last, verdict: null }
    }

    if (snap) {
      last = snap
      if (!orderId && snap.order) {
        orderId = snap.order.id
        deps.out(stamp(`locked on order ${orderId}`))
      }
      for (const line of diff(prev, snap)) deps.out(`${clock(snap.now)}  ${line}`)

      const findings = assess(snap, { stuckAfterMs: opts.stuckAfterMs })
      const current = new Map(findings.map((f) => [f.code, f.message]))
      for (const f of findings) {
        if (f.severity === 'critical') criticals.add(f.code)
        if (shown.get(f.code) !== f.message) deps.out(`${clock(snap.now)}  ${f.severity === 'critical' ? '[CRIT]' : '[WARN]'} ${f.message}`)
      }
      for (const [code] of shown) if (!current.has(code)) deps.out(`${clock(snap.now)}  [OK]   cleared: ${code}`)
      shown.clear()
      for (const [code, message] of current) shown.set(code, message)

      deps.tick(statusLine(snap))
      prev = snap

      if (opts.once) return { exitCode: 0, reason: 'single snapshot', snapshot: snap, verdict: null }
      if (snap.order && FINAL.has(snap.order.status)) {
        const v = verdict(snap, [...criticals])
        deps.out(stamp(`FINISHED: order ${snap.order.status}`))
        for (const l of v.lines) deps.out(`        ${l}`)
        deps.out(stamp(v.ok ? 'RESULT  CLEAN: the flight test passed' : 'RESULT  ATTENTION: see the failed checks above'))
        return { exitCode: v.ok ? 0 : 1, reason: v.ok ? 'completed' : 'finished with findings', snapshot: snap, verdict: v }
      }
    }

    if (deps.now() - started >= opts.timeoutMs) {
      const v = last?.order ? verdict(last, [...criticals]) : null
      deps.out(stamp(`TIMEOUT after ${age(opts.timeoutMs)}: ${last?.order ? `the order is still "${last.order.status}"` : 'no order appeared'}. Nothing was changed by this tool.`))
      return { exitCode: 2, reason: 'timeout', snapshot: last, verdict: v }
    }
    await deps.sleep(opts.intervalMs)
  }
}
