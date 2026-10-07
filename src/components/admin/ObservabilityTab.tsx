import { useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, Database, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getSystemHealth } from '@/services/api/admin'
import type { CronPulse, CronState, OverallStatus, ProviderPulse, SystemHealth } from '@/types/admin'
import { MetricCard } from './MetricCard'

const WINDOWS = [1, 6, 24] as const
/** The screen refreshes itself while it is open; the snapshot is one cheap read. */
const REFRESH_MS = 60_000

const OVERALL: Record<OverallStatus, { label: string; hint: string; box: string; icon: typeof CheckCircle2 }> = {
  ok: { label: 'All systems operational', hint: 'Nothing needs attention.', box: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: CheckCircle2 },
  degraded: { label: 'Degraded', hint: 'Something needs attention soon.', box: 'border-amber-300 bg-amber-50 text-amber-900', icon: TriangleAlert },
  critical: { label: 'Critical', hint: 'Act now: see the active alerts.', box: 'border-rose-300 bg-rose-50 text-rose-800', icon: XCircle },
}

const CRON_BADGE: Record<CronState, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-emerald-50 text-emerald-700' },
  late: { label: 'Late', className: 'bg-amber-100 text-amber-800' },
  failing: { label: 'Failing', className: 'bg-rose-50 text-rose-700' },
  never_ran: { label: 'No run yet', className: 'bg-amber-100 text-amber-800' },
  missing: { label: 'Missing', className: 'bg-rose-50 text-rose-700' },
  disabled: { label: 'Disabled', className: 'bg-rose-50 text-rose-700' },
  unknown: { label: 'Unknown', className: 'bg-slate-100 text-slate-600' },
}

const HEALTH_BADGE: Record<string, { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'bg-emerald-50 text-emerald-700' },
  degraded: { label: 'Degraded', className: 'bg-amber-100 text-amber-700' },
  unavailable: { label: 'Unavailable', className: 'bg-rose-50 text-rose-700' },
  disabled: { label: 'Not checked', className: 'bg-slate-100 text-slate-600' },
}

export function ObservabilityTab({ session }: { session: AuthSession }) {
  const [hours, setHours] = useState<number>(24)
  const { data, error, loading, reload } = useLoader(() => getSystemHealth(session, hours), [session.token, session.isMock, hours])

  useEffect(() => {
    const id = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void reload() }, REFRESH_MS)
    return () => clearInterval(id)
  }, [reload])

  if (!data && loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-[120px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}
      </div>
    )
  }
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load the system health.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }
  return (
    <HealthView
      health={data}
      hours={hours}
      loading={loading}
      error={error}
      onHours={(h) => { haptic.select(); setHours(h) }}
      onRefresh={() => { haptic.tap(); void reload() }}
    />
  )
}

/** Presentational: everything the tab shows, from one snapshot. */
export function HealthView({ health: h, hours, loading = false, error = null, onHours, onRefresh }: {
  health: SystemHealth
  hours: number
  loading?: boolean
  error?: string | null
  onHours: (hours: number) => void
  onRefresh: () => void
}) {
  const overall = OVERALL[h.status]
  const Icon = overall.icon
  const cronTone = h.cron.state === 'ok' ? 'text-emerald-700' : h.cron.state === 'critical' ? 'text-rose-700' : h.cron.state === 'unknown' ? 'text-slate-600' : 'text-amber-700'

  return (
    <div className="space-y-3">
      <section aria-label="Overall status" className={cn('rounded-3xl border p-4 shadow-card', overall.box)}>
        <div className="flex items-start gap-3">
          <Icon size={28} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold leading-tight">{overall.label}</h2>
            <p className="text-xs font-medium opacity-80">{overall.hint}</p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-2xl bg-white/70 px-3 py-2">
            <dt className="flex items-center gap-1 font-semibold text-content-secondary"><Activity size={13} strokeWidth={1.75} /> Cron heartbeat</dt>
            <dd className={cn('mt-0.5 text-sm font-bold', cronTone)}>{h.cron.state === 'ok' ? 'All jobs on time' : h.cron.state === 'unknown' ? 'Cannot be read' : h.cron.state === 'critical' ? 'Job(s) failing or late' : 'Needs attention'}</dd>
          </div>
          <div className="rounded-2xl bg-white/70 px-3 py-2">
            <dt className="flex items-center gap-1 font-semibold text-content-secondary"><Database size={13} strokeWidth={1.75} /> Database</dt>
            <dd className={cn('mt-0.5 text-sm font-bold', h.db.ok ? 'text-emerald-700' : 'text-rose-700')}>{h.db.ok ? 'Reachable' : 'Unreachable'}{h.db.latencyMs !== null && h.db.ok ? ` · ${h.db.latencyMs} ms` : ''}</dd>
          </div>
        </dl>
        <div className="mt-3 flex items-center justify-between gap-2">
          <div role="radiogroup" aria-label="Time window" className="flex gap-1 rounded-2xl bg-white/70 p-1">
            {WINDOWS.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={hours === w} onClick={() => onHours(w)}
                className={cn('h-8 rounded-xl px-3 text-[12px] font-bold', hours === w ? 'bg-white text-content-primary shadow-sm' : 'text-content-secondary')}>
                {w} h
              </button>
            ))}
          </div>
          <button type="button" aria-label="Refresh" disabled={loading} onClick={onRefresh}
            className="flex h-9 items-center gap-1.5 rounded-full bg-white/80 px-3 text-[12px] font-bold text-content-primary active:scale-95 disabled:opacity-60">
            <RefreshCw size={14} strokeWidth={2} className={cn(loading && 'animate-spin')} /> {timeAgo(h.generatedAt)}
          </button>
        </div>
        {error && <p role="alert" className="mt-2 rounded-xl bg-white/70 px-3 py-1.5 text-xs font-semibold text-rose-700">Refresh failed: {error}. Showing the last snapshot.</p>}
      </section>

      <section aria-label="Active alerts" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Active alerts</h2>
        {h.alerts.length === 0 ? (
          <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3.5 py-2.5 text-[13px] font-semibold text-emerald-700"><CheckCircle2 size={16} strokeWidth={1.75} /> No active alerts.</p>
        ) : (
          h.alerts.map((a) => (
            <article key={a.id} role={a.severity === 'critical' ? 'alert' : 'status'}
              className={cn('flex gap-2.5 rounded-2xl border px-3.5 py-3 text-[13px]', a.severity === 'critical' ? 'border-rose-300 bg-rose-50 text-rose-900' : 'border-amber-200 bg-amber-50 text-amber-900')}>
              {a.severity === 'critical' ? <XCircle size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-rose-600" /> : <TriangleAlert size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />}
              <div className="min-w-0">
                <p className="font-bold">{a.title}</p>
                <p className="mt-0.5 font-medium opacity-90">{a.detail}</p>
              </div>
            </article>
          ))
        )}
      </section>

      <section aria-label="Queues" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Queues and backlog</h2>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Stuck orders" value={String(h.orders.stuck)} tone={h.orders.stuck > 0 ? 'danger' : 'success'}
            hint={h.orders.stuck > 0 ? `oldest ${h.orders.stuckOldestMinutes} min` : 'none past the grace period'} />
          <MetricCard label="Open cases" value={String(h.reconciliation.open)} tone={h.reconciliation.critical > 0 ? 'danger' : h.reconciliation.open > 0 ? 'warning' : 'success'}
            hint={`${h.reconciliation.critical} critical · ${h.reconciliation.high} high · ${h.reconciliation.normal} normal`} />
          <MetricCard label="In the pipeline" value={String(Object.values(h.orders.queue).reduce((a, b) => a + b, 0))}
            hint={Object.entries(h.orders.queue).map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(' · ') || 'no active orders'} />
          <MetricCard label="Held orders" value={String(h.orders.held)} tone={h.orders.held > 0 ? 'warning' : 'default'} hint="waiting on a human" />
          <MetricCard label="Pending deposits" value={String(h.deposits.pending)} tone={h.deposits.stalePending > 0 ? 'warning' : 'default'}
            hint={h.deposits.stalePending > 0 ? `${h.deposits.stalePending} expired while pending` : 'waiting for the chain'} />
          <MetricCard label="Provider payments" value={String(h.paymentsInProgress)} hint={`${h.pendingProposals} top-up proposal${h.pendingProposals === 1 ? '' : 's'} pending`} />
        </div>
        <p className="px-1 text-xs text-content-secondary">Treasury {usd(h.treasury.balance)}{h.treasury.minimumReserve > 0 ? ` · reserve ${usd(h.treasury.minimumReserve)}` : ''}</p>
      </section>

      <section aria-label="Scheduled jobs" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Scheduled jobs</h2>
        {h.cron.jobs.map((j) => <JobRow key={j.name} job={j} />)}
        {!h.cron.available && <p className="px-1 text-xs text-content-secondary">The scheduler log cannot be read in this environment; workers are judged by their own heartbeat.</p>}
      </section>

      <section aria-label="Provider API health" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Provider API health · last {hours} h</h2>
        {h.providers.length === 0 && <Card className="p-4 text-sm text-content-secondary">No providers yet.</Card>}
        {h.providers.map((p) => <ProviderRow key={p.id} provider={p} />)}
        {h.recentProviderErrors.length > 0 && (
          <div className="rounded-2xl border border-blue-100/70 bg-white p-3 shadow-card">
            <h3 className="text-xs font-bold text-content-primary">Recent provider API errors</h3>
            <ul className="mt-1.5 space-y-1">
              {h.recentProviderErrors.map((e, i) => (
                <li key={`${e.checkedAt}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate"><b className="text-content-primary">{e.providerName}</b> <span className="text-content-secondary">· {e.errorKind}</span></span>
                  <span className="shrink-0 text-content-secondary">{e.latencyMs !== null ? `${e.latencyMs} ms · ` : ''}{timeAgo(e.checkedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

function JobRow({ job: j }: { job: CronPulse }) {
  const badge = CRON_BADGE[j.state]
  return (
    <article className={cn('rounded-2xl border bg-white px-3.5 py-3 shadow-card', j.state === 'ok' ? 'border-blue-100/70' : 'border-amber-300')} aria-label={`${j.label}: ${badge.label}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-content-primary">{j.label}</p>
          <p className="text-[11px] text-content-secondary">{j.name}{j.schedule ? ` · ${j.schedule}` : ''}</p>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold', badge.className)}>{badge.label}</span>
      </div>
      <p className="mt-1.5 text-xs text-content-secondary">{j.detail}</p>
      {j.failedRuns > 0 && <p className="mt-0.5 text-xs font-semibold text-rose-600">{j.failedRuns} failed run{j.failedRuns === 1 ? '' : 's'} in the window</p>}
    </article>
  )
}

function ProviderRow({ provider: p }: { provider: ProviderPulse }) {
  const badge = HEALTH_BADGE[p.health] ?? HEALTH_BADGE.disabled
  const kinds = Object.entries(p.errorsByKind).sort((a, b) => b[1] - a[1])
  const rate = p.errorRate === null ? '—' : `${Math.round(p.errorRate * 100)}%`
  const bad = p.errorRate !== null && p.errorRate >= 0.5 && p.checks >= 5
  return (
    <article className={cn('rounded-3xl border bg-white p-4 shadow-card', p.health === 'unavailable' || bad ? 'border-rose-300' : p.lowBalance ? 'border-amber-300' : 'border-blue-100/70')} aria-label={`Provider ${p.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-content-primary">{p.name}</h3>
          <span className={cn('mt-1 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold', badge.className)}>{badge.label}</span>
          {!p.routingEnabled && <span className="ml-1.5 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">Routing off</span>}
        </div>
        <p className="shrink-0 text-right text-[11px] text-content-secondary">checked {timeAgo(p.lastHealthCheck)}</p>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-content-secondary">Check errors</dt><dd className={cn('font-bold', bad ? 'text-rose-600' : 'text-content-primary')}>{rate}</dd><dd className="text-[11px] text-content-secondary">{p.failedChecks} of {p.checks}</dd></div>
        <div><dt className="text-xs text-content-secondary">Latency</dt><dd className="font-bold text-content-primary">{p.avgLatencyMs === null ? '—' : `${p.avgLatencyMs} ms`}</dd><dd className="text-[11px] text-content-secondary">{p.maxLatencyMs === null ? '' : `max ${p.maxLatencyMs} ms`}</dd></div>
        <div><dt className="text-xs text-content-secondary">Balance</dt><dd className={cn('font-bold', p.lowBalance ? 'text-amber-600' : 'text-content-primary')}>{p.lastBalanceSync ? usd(p.balance) : '—'}</dd><dd className="text-[11px] text-content-secondary">{p.currency}</dd></div>
      </dl>
      {kinds.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {kinds.map(([k, n]) => <span key={k} className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">{k} × {n}</span>)}
        </p>
      )}
      <p className="mt-2 text-xs text-content-secondary">Orders in window: {p.orders} · failed {p.ordersFailed} · held {p.ordersHeld}</p>
    </article>
  )
}
