// Provider health monitor core: ping every routing-enabled provider, record the result and alert admins on
// state changes. Pure orchestration with injected I/O (ports), so it runs in Deno and in Node tests.
//
// Rules:
//   * One provider throwing can never stop the others (each runs in its own try/catch under allSettled).
//   * A ping is bounded by PING_TIMEOUT_MS here even if the port itself hangs.
//   * Alerts fire only on a real transition and only for the caller that won the compare-and-set on
//     providers.health_status, so a cron tick that finds nothing new (or two overlapping runs) sends nothing.
//   * Routing needs no extra work: selectBestOffer / the pricing view already read providers.health_status.
import { SMMProviderError } from './providers/contract.ts'
import type { HealthStatus } from './types.ts'

export const PING_TIMEOUT_MS = 8_000

export interface MonitoredProvider {
  id: string
  name: string
  healthStatus: HealthStatus
}

export type AlertKind = 'down' | 'recovered'

export interface HealthLogEntry {
  providerId: string
  status: HealthStatus
  previousStatus: HealthStatus
  latencyMs: number | null
  errorKind: string | null
  checkedAt: string
}

export interface BalanceReading {
  balance: number
  currency: string
}

/** What to ask the treasury for: enough to bring the provider back to its target balance (0 = nothing to propose). */
export function topupAmount(target: number, balance: number): number {
  const needed = Math.round((target - balance) * 10_000) / 10_000
  return needed > 0 ? needed : 0
}

export type BalanceAction = 'alert' | 'reset' | 'none'

/**
 * The alert lock. Alert once when the balance is at or below the threshold and no alert is outstanding;
 * release the lock once it is back above the threshold. In between nothing happens, so a balance that stays
 * low (or oscillates around the threshold only upwards of it) never produces repeat alerts.
 */
export function balanceAction(balance: number, threshold: number, alertSent: boolean): BalanceAction {
  if (balance <= threshold) return alertSent ? 'none' : 'alert'
  return alertSent ? 'reset' : 'none'
}

/**
 * A reading we are willing to store: finite, within numeric(14,4), and a sane currency code
 * (otherwise the currency is left as it was). Returns null when the balance itself is unusable.
 */
export function sanitizeBalance(r: { balance: unknown; currency?: unknown }): { balance: number; currency: string | null } | null {
  if (typeof r.balance !== 'number' || !Number.isFinite(r.balance) || Math.abs(r.balance) >= 1e9) return null
  const cur = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : ''
  return { balance: Math.round(r.balance * 10_000) / 10_000, currency: /^[A-Z]{3,10}$/.test(cur) ? cur : null }
}

/**
 * A panel that answers but whose balance field is missing or not a number is still UP: that must not flip
 * the provider to unavailable. (A non-JSON body, a timeout, an HTTP error etc. are real failures.)
 */
export function isBalanceParseError(e: unknown): boolean {
  return (
    e instanceof SMMProviderError &&
    e.kind === 'invalid_response' &&
    /^(balance: |Field "balance")/.test(e.message) &&
    !/not valid JSON/.test(e.message) // an HTML maintenance page etc. is a real failure
  )
}

export interface HealthPorts<P extends MonitoredProvider> {
  /** Providers with is_active and routing_enabled. */
  listProviders(): Promise<P[]>
  /**
   * Cheap authenticated call (balance). Rejects on any failure; resolves with the reading when the panel
   * returned a usable one (void when it answered but the balance could not be read).
   */
  ping(provider: P): Promise<BalanceReading | void>
  /** Stores provider_balance / currency / last_balance_sync; returns the provider's threshold, top-up target, alert lock and stored currency. */
  saveBalance(provider: P, reading: { balance: number; currency: string | null }, at: string): Promise<{ threshold: number; alertSent: boolean; currency: string; target: number }>
  /** Compare-and-set on balance_alert_sent = from. True for the single caller that flipped it. */
  setBalanceAlertSent(provider: P, from: boolean, to: boolean): Promise<boolean>
  /**
   * Files a top-up proposal of `amount` (idempotent: an existing pending proposal for the provider is returned as is).
   * Rejects on a database failure.
   */
  createTopupProposal(provider: P, amount: number): Promise<{ amount: number; created: boolean }>
  /** Alerts the admins. Resolves true only if at least one admin actually received it. */
  notifyLowBalance(provider: P, reading: BalanceReading & { proposalAmount?: number }, at: string): Promise<boolean>
  /**
   * Stores the result. When `from === to` only last_health_check is touched ('unchanged'). Otherwise it is a
   * compare-and-set on health_status = from: 'changed' for the single winner, 'lost_race' for anyone else.
   */
  applyCheck(provider: P, from: HealthStatus, to: HealthStatus, checkedAt: string): Promise<'changed' | 'unchanged' | 'lost_race'>
  appendLog(entry: HealthLogEntry): Promise<void>
  notify(provider: P, kind: AlertKind, checkedAt: string): Promise<void>
  now?: () => Date
  pingTimeoutMs?: number
}

export interface ProviderCheckReport {
  providerId: string
  name: string
  from: HealthStatus
  to: HealthStatus | 'unchanged_inconclusive' | 'error'
  alert: AlertKind | null
  /** True when this check raised a low-balance alert. */
  balanceAlert: boolean
  errorKind: string | null
}

export interface HealthRunReport {
  checked: number
  healthy: number
  unavailable: number
  inconclusive: number
  errors: number
  alerts: number
  balanceAlerts: number
  providers: ProviderCheckReport[]
}

/** Only healthy <-> unavailable is alert-worthy; first promotion from 'disabled' (never checked) is silent. */
export function alertFor(from: HealthStatus, to: HealthStatus): AlertKind | null {
  if (to === 'unavailable' && (from === 'healthy' || from === 'degraded')) return 'down'
  if (to === 'healthy' && from === 'unavailable') return 'recovered'
  return null
}

/**
 * What a failed ping means. Rate limiting says nothing about whether the provider works, so it keeps the
 * current status; every other failure (timeout, network, 5xx, bad key, garbage response) means it cannot take orders.
 * The label is a short machine string, never a message from the provider.
 */
export function classifyPingError(e: unknown): { status: 'unavailable' | 'inconclusive'; label: string } {
  if (e instanceof SMMProviderError) {
    if (e.code === 'rate_limited') return { status: 'inconclusive', label: 'rate_limited' }
    return { status: 'unavailable', label: e.httpStatus ? `${e.kind} ${e.httpStatus}` : e.kind }
  }
  return { status: 'unavailable', label: 'unexpected' }
}

class PingTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PingTimeout()), ms) })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * Stores the balance and runs the alert lock. Entirely best effort: any failure here is swallowed so a balance
 * problem can never turn a successful health check into a failed one. Returns true if an alert was delivered.
 */
async function processBalance<P extends MonitoredProvider>(p: P, reading: BalanceReading, at: string, ports: HealthPorts<P>): Promise<boolean> {
  try {
    const clean = sanitizeBalance(reading)
    if (!clean) return false
    const { threshold, alertSent, currency, target } = await ports.saveBalance(p, clean, at)
    const action = balanceAction(clean.balance, threshold, alertSent)
    if (action === 'reset') {
      await ports.setBalanceAlertSent(p, true, false)
      return false
    }
    if (action !== 'alert') return false
    // Only the caller that flips the lock may alert (overlapping runs: one alert).
    if (!(await ports.setBalanceAlertSent(p, false, true))) return false
    // File the top-up proposal first. A new proposal is filed once per dip (this lock), not on every tick: otherwise approving
    // one while the real balance has not risen yet would immediately spawn the next. If filing fails, release the lock and retry next tick.
    const needed = topupAmount(target, clean.balance)
    let proposalAmount: number | undefined
    if (needed > 0) {
      try {
        proposalAmount = (await ports.createTopupProposal(p, needed)).amount
      } catch {
        await ports.setBalanceAlertSent(p, true, false)
        return false
      }
    }
    const delivered = await ports.notifyLowBalance(p, { balance: clean.balance, currency, proposalAmount }, at).catch(() => false)
    // Nobody was told: release the lock so the next tick tries again instead of staying silent forever.
    if (!delivered) await ports.setBalanceAlertSent(p, true, false)
    return delivered
  } catch {
    return false
  }
}

async function checkOne<P extends MonitoredProvider>(p: P, ports: HealthPorts<P>): Promise<ProviderCheckReport> {
  const clock = ports.now ?? (() => new Date())
  const started = Date.now()
  let to: HealthStatus | null = 'healthy'
  let errorKind: string | null = null
  let reading: BalanceReading | void = undefined
  try {
    reading = await withTimeout(Promise.resolve().then(() => ports.ping(p)), ports.pingTimeoutMs ?? PING_TIMEOUT_MS)
  } catch (e) {
    if (e instanceof PingTimeout) {
      to = 'unavailable'
      errorKind = 'timeout'
    } else {
      const c = classifyPingError(e)
      to = c.status === 'unavailable' ? 'unavailable' : null
      errorKind = c.label
    }
  }
  const latencyMs = Date.now() - started
  const checkedAt = clock().toISOString()
  const base = { providerId: p.id, name: p.name, from: p.healthStatus, errorKind }

  if (to === null) {
    // inconclusive: leave the status alone, keep the trail
    await ports.appendLog({ providerId: p.id, status: p.healthStatus, previousStatus: p.healthStatus, latencyMs, errorKind, checkedAt }).catch(() => {})
    return { ...base, to: 'unchanged_inconclusive', alert: null, balanceAlert: false }
  }

  const outcome = await ports.applyCheck(p, p.healthStatus, to, checkedAt)
  await ports.appendLog({ providerId: p.id, status: to, previousStatus: p.healthStatus, latencyMs, errorKind, checkedAt }).catch(() => {})
  const kind = outcome === 'changed' ? alertFor(p.healthStatus, to) : null
  if (kind) await ports.notify(p, kind, checkedAt).catch(() => {})
  const balanceAlert = to === 'healthy' && reading ? await processBalance(p, reading, checkedAt, ports) : false
  return { ...base, to, alert: kind, balanceAlert }
}

/** Checks every provider. Never throws because of a single provider. */
export async function runHealthChecks<P extends MonitoredProvider>(ports: HealthPorts<P>): Promise<HealthRunReport> {
  const providers = await ports.listProviders()
  const settled = await Promise.allSettled(providers.map((p) => checkOne(p, ports)))

  const report: HealthRunReport = { checked: providers.length, healthy: 0, unavailable: 0, inconclusive: 0, errors: 0, alerts: 0, balanceAlerts: 0, providers: [] }
  settled.forEach((r, i) => {
    const p = providers[i]
    if (r.status === 'rejected') {
      // e.g. the database write failed: report it, leave the provider's status as it was
      report.errors++
      report.providers.push({ providerId: p.id, name: p.name, from: p.healthStatus, to: 'error', alert: null, balanceAlert: false, errorKind: 'check_failed' })
      return
    }
    report.providers.push(r.value)
    if (r.value.to === 'healthy') report.healthy++
    else if (r.value.to === 'unavailable') report.unavailable++
    else report.inconclusive++
    if (r.value.alert) report.alerts++
    if (r.value.balanceAlert) report.balanceAlerts++
  })
  return report
}
