// Pure part of the System Health feature: turns the raw snapshot of get_system_health() into what the admin screen
// shows (cron pulse, provider API health, active alerts, overall status). No I/O: the Edge Function fetches the
// snapshot, this module judges it, the UI renders the result. Everything is unit-tested.

import { caseSeverity, type Severity } from './recon-severity.ts'

export type AlertSeverity = 'critical' | 'warning'
export type OverallStatus = 'ok' | 'degraded' | 'critical'
export type CronState = 'ok' | 'late' | 'failing' | 'never_ran' | 'missing' | 'disabled' | 'unknown'

export interface HealthAlert {
  id: string
  severity: AlertSeverity
  title: string
  detail: string
}

/** A scheduled job we expect to exist. `lateAfterMinutes` = how long without a (successful) run before it counts as late. */
export interface ExpectedJob {
  name: string
  label: string
  /** sql: pg_cron runs a database function, its log is the whole truth. http: pg_cron calls an Edge Function, whose own heartbeat is the truth. */
  kind: 'sql' | 'http'
  everyMinutes: number
  lateAfterMinutes: number
  /** A problem here makes the whole system critical (not just degraded). */
  critical: boolean
  /** worker_heartbeats name, for http jobs. */
  worker?: string
}

export const EXPECTED_JOBS: readonly ExpectedJob[] = [
  { name: 'provider-health-monitor', label: 'Provider health monitor', kind: 'http', everyMinutes: 1, lateAfterMinutes: 5, critical: true, worker: 'provider-health-monitor' },
  { name: 'sync-reconciliation-cases', label: 'Reconciliation detector', kind: 'sql', everyMinutes: 5, lateAfterMinutes: 12, critical: true },
  { name: 'sync-order-status', label: 'Order status sync', kind: 'http', everyMinutes: 1, lateAfterMinutes: 5, critical: true, worker: 'sync-order-status' },
  { name: 'sync-catalog', label: 'Catalog sync', kind: 'http', everyMinutes: 360, lateAfterMinutes: 420, critical: false, worker: 'sync-catalog' },
]

// ---------------------------------------------------------------------------
// Raw snapshot (get_system_health), snake_case as the database returns it
// ---------------------------------------------------------------------------

export interface RawCronJob {
  name: string
  schedule: string | null
  active: boolean
  last_run_at: string | null
  last_status: string | null
  last_success_at: string | null
  runs: number
  failed_runs: number
}

export interface RawWorker {
  worker: string
  last_run_at: string | null
  last_success_at: string | null
  last_error_at: string | null
  last_error: string | null
  last_duration_ms: number | null
  runs: number
  failures: number
}

export interface RawProvider {
  id: string
  name: string
  is_active: boolean
  routing_enabled: boolean
  health_status: string
  last_health_check: string | null
  balance: number | string | null
  currency: string
  last_balance_sync: string | null
  low_balance_threshold: number | string | null
  checks: number
  failed_checks: number
  avg_latency_ms: number | null
  max_latency_ms: number | null
  last_error_kind: string | null
  last_error_at: string | null
  errors_by_kind: Record<string, number>
  orders: number
  orders_failed: number
  orders_held: number
}

export interface RawHealth {
  generated_at: string
  window_hours: number
  db: { ok: boolean; now: string }
  orders: { stuck: number; stuck_oldest_minutes: number; held: number; queue: Record<string, number> }
  reconciliation: { total: number; cases: { id: string; entity_type: string; reason: string; created_at: string; amount: number | string | null }[] }
  providers: RawProvider[]
  recent_provider_errors: { provider_id: string; provider_name: string; error_kind: string; status: string; latency_ms: number | null; checked_at: string }[]
  deposits: { pending: number; stale_pending: number }
  proposals: { pending: number }
  payments: { in_progress: number }
  treasury: { balance: number | string; minimum_reserve: number | string }
  workers: RawWorker[]
  cron: RawCronJob[] | null
  cron_error: string | null
}

// ---------------------------------------------------------------------------
// What the screen shows
// ---------------------------------------------------------------------------

export interface CronPulse {
  name: string
  label: string
  kind: 'sql' | 'http'
  schedule: string | null
  everyMinutes: number
  state: CronState
  critical: boolean
  /** Last time the scheduler fired it. */
  lastRunAt: string | null
  /** Last time it provably completed (cron success for sql jobs, worker heartbeat for http jobs). */
  lastSuccessAt: string | null
  ageMinutes: number | null
  failedRuns: number
  detail: string
}

export interface ProviderPulse {
  id: string
  name: string
  isActive: boolean
  routingEnabled: boolean
  health: string
  lastHealthCheck: string | null
  balance: number
  currency: string
  lastBalanceSync: string | null
  lowBalance: boolean
  checks: number
  failedChecks: number
  /** failedChecks / checks, 0..1; null when there were no checks in the window. */
  errorRate: number | null
  avgLatencyMs: number | null
  maxLatencyMs: number | null
  lastErrorKind: string | null
  lastErrorAt: string | null
  errorsByKind: Record<string, number>
  orders: number
  ordersFailed: number
  ordersHeld: number
}

export interface SystemHealth {
  generatedAt: string
  windowHours: number
  status: OverallStatus
  db: { ok: boolean; latencyMs: number | null }
  cron: { state: OverallStatus | 'unknown'; available: boolean; jobs: CronPulse[] }
  orders: { stuck: number; stuckOldestMinutes: number; held: number; queue: Record<string, number> }
  reconciliation: { open: number; critical: number; high: number; normal: number }
  providers: ProviderPulse[]
  recentProviderErrors: { providerName: string; errorKind: string; status: string; latencyMs: number | null; checkedAt: string }[]
  deposits: { pending: number; stalePending: number }
  pendingProposals: number
  paymentsInProgress: number
  treasury: { balance: number; minimumReserve: number }
  alerts: HealthAlert[]
}

const MINUTE = 60_000
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
const ageMin = (iso: string | null, now: number): number | null => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / MINUTE)) : null)
const newer = (a: string | null, b: string | null): string | null => (a && b ? (Date.parse(a) >= Date.parse(b) ? a : b) : a ?? b)

const human = (minutes: number): string => (minutes < 120 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`)

/**
 * Judges one scheduled job.
 *   missing   no such job in cron.job (never created, or removed)
 *   disabled  the job exists but is switched off
 *   never_ran scheduled, nothing recorded yet (only expected right after creation)
 *   failing   the scheduler's last run failed, or (http jobs) the worker's last run ended in an error
 *   late      nothing completed within lateAfterMinutes: the scheduler stopped, or the worker keeps failing before it can report
 *   unknown   pg_cron cannot be read here (sql jobs only; http jobs fall back to their heartbeat)
 *   ok        ran in time
 */
export function classifyJob(def: ExpectedJob, cron: RawCronJob[] | null, workers: RawWorker[], now: number): CronPulse {
  const job = cron?.find((j) => j.name === def.name)
  const worker = def.worker ? workers.find((w) => w.worker === def.worker) : undefined
  const base = { name: def.name, label: def.label, kind: def.kind, schedule: job?.schedule ?? null, everyMinutes: def.everyMinutes, critical: def.critical }
  const pulse = (state: CronState, detail: string, lastRunAt: string | null, lastSuccessAt: string | null): CronPulse => ({
    ...base, state, detail, lastRunAt, lastSuccessAt, ageMinutes: ageMin(lastSuccessAt ?? lastRunAt, now), failedRuns: job?.failed_runs ?? 0,
  })

  if (cron !== null) {
    if (!job) return pulse('missing', 'The scheduled job does not exist.', null, null)
    if (!job.active) return pulse('disabled', 'The scheduled job is switched off.', job.last_run_at, job.last_success_at)
  }

  // the signal of completion: http jobs report themselves, sql jobs are judged by pg_cron alone
  let lastRunAt = job?.last_run_at ?? null
  let lastSuccessAt = job?.last_success_at ?? null
  if (def.kind === 'http' && worker) {
    lastRunAt = newer(lastRunAt, worker.last_run_at)
    lastSuccessAt = worker.last_success_at // a fired request proves nothing: only the worker finishing does
    if (worker.last_error_at && (!worker.last_success_at || Date.parse(worker.last_error_at) > Date.parse(worker.last_success_at))) {
      return pulse('failing', `The last run ended in an error${worker.last_error ? `: ${worker.last_error}` : ''}.`, lastRunAt, lastSuccessAt)
    }
  }

  if (cron === null && def.kind === 'sql') return pulse('unknown', 'The scheduler log cannot be read from here.', null, null)
  if (def.kind === 'sql' && job?.last_status === 'failed') return pulse('failing', 'The last scheduled run failed.', lastRunAt, lastSuccessAt)

  const reference = def.kind === 'http' && worker ? lastSuccessAt : lastRunAt
  if (!reference) {
    if (def.kind === 'http' && lastRunAt) {
      // fired, but this worker version has not reported yet (fresh deploy): trust the scheduler until it is overdue
      const fired = ageMin(lastRunAt, now) ?? 0
      return fired > def.lateAfterMinutes
        ? pulse('late', `Fired ${human(fired)} ago but the worker has never reported completing.`, lastRunAt, null)
        : pulse('ok', 'Fired on schedule; the worker has not reported yet.', lastRunAt, null)
    }
    return pulse(cron === null ? 'unknown' : 'never_ran', cron === null ? 'No run is recorded.' : 'Scheduled, but no run has been recorded yet.', null, null)
  }
  const age = ageMin(reference, now) ?? 0
  if (age > def.lateAfterMinutes) {
    const why = def.kind === 'http' && worker ? `no completed run for ${human(age)}` : `last run ${human(age)} ago`
    return pulse('late', `Expected every ${human(def.everyMinutes)}: ${why}.`, lastRunAt, lastSuccessAt)
  }
  return pulse('ok', `Last ${def.kind === 'http' ? 'completed' : 'ran'} ${age < 1 ? 'just now' : `${human(age)} ago`} (every ${human(def.everyMinutes)}).`, lastRunAt, lastSuccessAt)
}

const errorRate = (checks: number, failed: number): number | null => (checks > 0 ? failed / checks : null)

export const ERROR_RATE_WARN = 0.5
export const ERROR_RATE_MIN_CHECKS = 5
/** Stuck orders older than this make the situation critical (customers are paying and waiting). */
export const STUCK_CRITICAL_MINUTES = 60

/** Turns the database snapshot into the screen model. `dbLatencyMs` = how long the snapshot query took (null: unknown). */
export function buildSystemHealth(raw: RawHealth, now: number = Date.now(), dbLatencyMs: number | null = null): SystemHealth {
  const jobs = EXPECTED_JOBS.map((d) => classifyJob(d, raw.cron, raw.workers, now))

  const providers: ProviderPulse[] = raw.providers.map((p) => {
    const balance = num(p.balance)
    return {
      id: p.id, name: p.name, isActive: p.is_active, routingEnabled: p.routing_enabled, health: p.health_status, lastHealthCheck: p.last_health_check,
      balance, currency: p.currency, lastBalanceSync: p.last_balance_sync,
      lowBalance: p.last_balance_sync !== null && p.low_balance_threshold !== null && balance <= num(p.low_balance_threshold),
      checks: p.checks, failedChecks: p.failed_checks, errorRate: errorRate(p.checks, p.failed_checks), avgLatencyMs: p.avg_latency_ms, maxLatencyMs: p.max_latency_ms,
      lastErrorKind: p.last_error_kind, lastErrorAt: p.last_error_at, errorsByKind: p.errors_by_kind ?? {},
      orders: p.orders, ordersFailed: p.orders_failed, ordersHeld: p.orders_held,
    }
  })

  const counts: Record<Severity, number> = { critical: 0, high: 0, normal: 0 }
  for (const c of raw.reconciliation.cases) counts[caseSeverity({ reason: c.reason, createdAt: c.created_at, amount: c.amount === null ? null : Number(c.amount) }, now)]++
  // the snapshot carries at most 200 cases; the rest are at least counted as open (normal)
  counts.normal += Math.max(0, raw.reconciliation.total - raw.reconciliation.cases.length)

  const treasury = { balance: num(raw.treasury.balance), minimumReserve: num(raw.treasury.minimum_reserve) }
  const alerts = buildAlerts({ jobs, providers, counts, orders: raw.orders, treasury, stalePending: raw.deposits.stale_pending })

  const cronProblems = jobs.filter((j) => j.state !== 'ok')
  const cronCritical = cronProblems.some((j) => j.critical && j.state !== 'never_ran' && j.state !== 'unknown')
  const cron: SystemHealth['cron'] = {
    available: raw.cron !== null,
    jobs,
    state: cronCritical ? 'critical' : cronProblems.length > 0 ? (cronProblems.every((j) => j.state === 'unknown') ? 'unknown' : 'degraded') : 'ok',
  }
  const status: OverallStatus = !raw.db.ok || alerts.some((a) => a.severity === 'critical') ? 'critical' : alerts.length > 0 ? 'degraded' : 'ok'

  return {
    generatedAt: raw.generated_at,
    windowHours: raw.window_hours,
    status,
    db: { ok: raw.db.ok, latencyMs: dbLatencyMs },
    cron,
    orders: { stuck: raw.orders.stuck, stuckOldestMinutes: raw.orders.stuck_oldest_minutes, held: raw.orders.held, queue: raw.orders.queue },
    reconciliation: { open: raw.reconciliation.total, critical: counts.critical, high: counts.high, normal: counts.normal },
    providers,
    recentProviderErrors: raw.recent_provider_errors.map((e) => ({ providerName: e.provider_name, errorKind: e.error_kind, status: e.status, latencyMs: e.latency_ms, checkedAt: e.checked_at })),
    deposits: { pending: raw.deposits.pending, stalePending: raw.deposits.stale_pending },
    pendingProposals: raw.proposals.pending,
    paymentsInProgress: raw.payments.in_progress,
    treasury,
    alerts,
  }
}

function buildAlerts(i: {
  jobs: CronPulse[]
  providers: ProviderPulse[]
  counts: Record<Severity, number>
  orders: RawHealth['orders']
  treasury: { balance: number; minimumReserve: number }
  stalePending: number
}): HealthAlert[] {
  const alerts: HealthAlert[] = []
  const add = (id: string, severity: AlertSeverity, title: string, detail: string) => alerts.push({ id, severity, title, detail })

  if (i.counts.critical > 0) add('recon-critical', 'critical', `${i.counts.critical} critical reconciliation case${i.counts.critical === 1 ? '' : 's'}`, 'Money is owed or a case is over a day old. Open Reconciliation.')
  if (i.counts.high > 0) add('recon-high', 'warning', `${i.counts.high} high-priority reconciliation case${i.counts.high === 1 ? '' : 's'}`, 'Stuck for over 2 hours or holding $50 or more.')

  if (i.orders.stuck > 0) {
    const old = i.orders.stuck_oldest_minutes >= STUCK_CRITICAL_MINUTES
    add('stuck-orders', old ? 'critical' : 'warning', `${i.orders.stuck} stuck order${i.orders.stuck === 1 ? '' : 's'}`, `In processing past the grace period; the oldest for ${human(i.orders.stuck_oldest_minutes)}. Check the provider and Reconciliation.`)
  }

  for (const j of i.jobs) {
    if (j.state === 'ok') continue
    if (j.state === 'unknown') {
      add(`cron-${j.name}`, 'warning', `${j.label}: cannot be checked`, j.detail)
      continue
    }
    const severity: AlertSeverity = j.critical && j.state !== 'never_ran' ? 'critical' : 'warning'
    add(`cron-${j.name}`, severity, `${j.label}: ${j.state.replace('_', ' ')}`, j.detail)
  }

  const routing = i.providers.filter((p) => p.isActive && p.routingEnabled)
  for (const p of routing) {
    if (p.health === 'unavailable') add(`provider-down-${p.id}`, 'critical', `${p.name} is unavailable`, `Its API is failing${p.lastErrorKind ? ` (${p.lastErrorKind})` : ''}; orders route around it while others are healthy.`)
    else if (p.health === 'degraded') add(`provider-degraded-${p.id}`, 'warning', `${p.name} is degraded`, 'Slow or intermittent API responses.')
    else if (p.errorRate !== null && p.errorRate >= ERROR_RATE_WARN && p.checks >= ERROR_RATE_MIN_CHECKS) {
      add(`provider-errors-${p.id}`, 'warning', `${p.name}: ${Math.round(p.errorRate * 100)}% of health checks failed`, `${p.failedChecks} of ${p.checks} checks in the last window.`)
    }
    if (p.lowBalance) add(`provider-balance-${p.id}`, 'warning', `${p.name}: low balance`, `${p.balance.toFixed(2)} ${p.currency} at or below its alert threshold.`)
  }
  if (i.providers.length > 0 && !routing.some((p) => p.health === 'healthy')) {
    add('no-healthy-provider', 'critical', 'No healthy provider is routing', 'New orders cannot be placed until a provider is healthy and has routing enabled.')
  } else if (i.providers.length === 0) {
    add('no-providers', 'warning', 'No provider is configured', 'Orders cannot be placed yet.')
  }

  if (i.treasury.minimumReserve > 0 && i.treasury.balance < i.treasury.minimumReserve) {
    add('treasury-reserve', 'warning', 'Treasury is below its minimum reserve', `${i.treasury.balance.toFixed(2)} held, reserve ${i.treasury.minimumReserve.toFixed(2)}: provider top-ups are refused.`)
  }
  if (i.stalePending > 0) add('stale-deposits', 'warning', `${i.stalePending} deposit${i.stalePending === 1 ? '' : 's'} expired while pending`, 'A customer may have paid after the window; check verify-deposit.')

  const rank = { critical: 0, warning: 1 } as const
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/** The request body of admin-observability. `hours` 1..24, default 24. */
export function parseObservabilityRequest(body: unknown): { hours: number } | { error: string } {
  if (body === null || body === undefined) return { hours: 24 }
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'GET'
  if (action !== 'GET') return { error: 'Unknown action.' }
  if (b.hours === undefined) return { hours: 24 }
  if (typeof b.hours !== 'number' || !Number.isInteger(b.hours) || b.hours < 1 || b.hours > 24) return { error: 'hours must be an integer from 1 to 24.' }
  return { hours: b.hours }
}
