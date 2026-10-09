import { useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, Database, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { plural, timeAgoRu, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getSystemHealth } from '@/services/api/admin'
import type { CronPulse, CronState, OverallStatus, ProviderPulse, SystemHealth } from '@/types/admin'
import { MetricCard } from './MetricCard'

const WINDOWS = [1, 6, 24] as const
/** The screen refreshes itself while it is open; the snapshot is one cheap read. */
const REFRESH_MS = 60_000

const OVERALL: Record<OverallStatus, { label: string; hint: string; box: string; icon: typeof CheckCircle2 }> = {
  ok: { label: 'Все системы работают', hint: 'Ничего не требует внимания.', box: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: CheckCircle2 },
  degraded: { label: 'Есть проблемы', hint: 'Скоро нужно будет вмешаться.', box: 'border-amber-300 bg-amber-50 text-amber-900', icon: TriangleAlert },
  critical: { label: 'Критично', hint: 'Действуйте сейчас: смотрите активные тревоги.', box: 'border-rose-300 bg-rose-50 text-rose-800', icon: XCircle },
}

const CRON_BADGE: Record<CronState, { label: string; className: string }> = {
  ok: { label: 'В норме', className: 'bg-emerald-50 text-emerald-700' },
  late: { label: 'Опаздывает', className: 'bg-amber-100 text-amber-800' },
  failing: { label: 'Падает', className: 'bg-rose-50 text-rose-700' },
  never_ran: { label: 'Ещё не запускалась', className: 'bg-amber-100 text-amber-800' },
  missing: { label: 'Не создана', className: 'bg-rose-50 text-rose-700' },
  disabled: { label: 'Выключена', className: 'bg-rose-50 text-rose-700' },
  unknown: { label: 'Неизвестно', className: 'bg-slate-100 text-slate-600' },
}

const HEALTH_BADGE: Record<string, { label: string; className: string }> = {
  healthy: { label: 'Работает', className: 'bg-emerald-50 text-emerald-700' },
  degraded: { label: 'Сбои', className: 'bg-amber-100 text-amber-700' },
  unavailable: { label: 'Недоступен', className: 'bg-rose-50 text-rose-700' },
  disabled: { label: 'Не проверяется', className: 'bg-slate-100 text-slate-600' },
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
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Не удалось загрузить состояние системы.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
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
      <section aria-label="Общее состояние" className={cn('rounded-3xl border p-4 shadow-card', overall.box)}>
        <div className="flex items-start gap-3">
          <Icon size={28} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold leading-tight">{overall.label}</h2>
            <p className="text-xs font-medium opacity-80">{overall.hint}</p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-2xl bg-white/70 px-3 py-2">
            <dt className="flex items-center gap-1 font-semibold text-content-secondary"><Activity size={13} strokeWidth={1.75} /> Фоновые задачи</dt>
            <dd className={cn('mt-0.5 text-sm font-bold', cronTone)}>{h.cron.state === 'ok' ? 'Все вовремя' : h.cron.state === 'unknown' ? 'Не удаётся прочитать' : h.cron.state === 'critical' ? 'Задачи падают или опаздывают' : 'Требует внимания'}</dd>
          </div>
          <div className="rounded-2xl bg-white/70 px-3 py-2">
            <dt className="flex items-center gap-1 font-semibold text-content-secondary"><Database size={13} strokeWidth={1.75} /> База данных</dt>
            <dd className={cn('mt-0.5 text-sm font-bold', h.db.ok ? 'text-emerald-700' : 'text-rose-700')}>{h.db.ok ? 'Доступна' : 'Недоступна'}{h.db.latencyMs !== null && h.db.ok ? ` · ${h.db.latencyMs} мс` : ''}</dd>
          </div>
        </dl>
        <div className="mt-3 flex items-center justify-between gap-2">
          <div role="radiogroup" aria-label="Период" className="flex gap-1 rounded-2xl bg-white/70 p-1">
            {WINDOWS.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={hours === w} onClick={() => onHours(w)}
                className={cn('h-8 rounded-xl px-3 text-[12px] font-bold', hours === w ? 'bg-white text-content-primary shadow-sm' : 'text-content-secondary')}>
                {w} ч
              </button>
            ))}
          </div>
          <button type="button" aria-label="Обновить" disabled={loading} onClick={onRefresh}
            className="flex h-9 items-center gap-1.5 rounded-full bg-white/80 px-3 text-[12px] font-bold text-content-primary active:scale-95 disabled:opacity-60">
            <RefreshCw size={14} strokeWidth={2} className={cn(loading && 'animate-spin')} /> {timeAgoRu(h.generatedAt)}
          </button>
        </div>
        {error && <p role="alert" className="mt-2 rounded-xl bg-white/70 px-3 py-1.5 text-xs font-semibold text-rose-700">Не удалось обновить: {error}. Показано последнее состояние.</p>}
      </section>

      <section aria-label="Активные тревоги" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Активные тревоги</h2>
        {h.alerts.length === 0 ? (
          <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3.5 py-2.5 text-[13px] font-semibold text-emerald-700"><CheckCircle2 size={16} strokeWidth={1.75} /> Активных тревог нет.</p>
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

      <section aria-label="Очереди" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Очереди и накопления</h2>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Зависшие заказы" value={String(h.orders.stuck)} tone={h.orders.stuck > 0 ? 'danger' : 'success'}
            hint={h.orders.stuck > 0 ? `самый старый ${h.orders.stuckOldestMinutes} мин` : 'нет, все в пределах нормы'} />
          <MetricCard label="Открытые кейсы" value={String(h.reconciliation.open)} tone={h.reconciliation.critical > 0 ? 'danger' : h.reconciliation.open > 0 ? 'warning' : 'success'}
            hint={`${h.reconciliation.critical} критичных · ${h.reconciliation.high} важных · ${h.reconciliation.normal} обычных`} />
          <MetricCard label="В обработке" value={String(Object.values(h.orders.queue).reduce((a, b) => a + b, 0))}
            hint={Object.entries(h.orders.queue).map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(' · ') || 'активных заказов нет'} />
          <MetricCard label="Заказы на удержании" value={String(h.orders.held)} tone={h.orders.held > 0 ? 'warning' : 'default'} hint="ждут решения человека" />
          <MetricCard label="Ожидающие пополнения" value={String(h.deposits.pending)} tone={h.deposits.stalePending > 0 ? 'warning' : 'default'}
            hint={h.deposits.stalePending > 0 ? `${h.deposits.stalePending} истекло в ожидании` : 'ждут сеть'} />
          <MetricCard label="Платежи провайдерам" value={String(h.paymentsInProgress)} hint={`ожидает ${h.pendingProposals} ${plural(h.pendingProposals, ['предложение', 'предложения', 'предложений'])} о пополнении`} />
        </div>
        <p className="px-1 text-xs text-content-secondary">Казна {usd(h.treasury.balance)}{h.treasury.minimumReserve > 0 ? ` · резерв ${usd(h.treasury.minimumReserve)}` : ''}</p>
      </section>

      <section aria-label="Фоновые задачи" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Фоновые задачи</h2>
        {h.cron.jobs.map((j) => <JobRow key={j.name} job={j} />)}
        {!h.cron.available && <p className="px-1 text-xs text-content-secondary">Журнал планировщика здесь прочитать нельзя; о работе задач судим по их собственным отметкам.</p>}
      </section>

      <section aria-label="Состояние API провайдеров" className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-content-primary">Состояние API провайдеров · последние {hours} ч</h2>
        {h.providers.length === 0 && <Card className="p-4 text-sm text-content-secondary">Провайдеров пока нет.</Card>}
        {h.providers.map((p) => <ProviderRow key={p.id} provider={p} />)}
        {h.recentProviderErrors.length > 0 && (
          <div className="rounded-2xl border border-blue-100/70 bg-white p-3 shadow-card">
            <h3 className="text-xs font-bold text-content-primary">Последние ошибки API провайдеров</h3>
            <ul className="mt-1.5 space-y-1">
              {h.recentProviderErrors.map((e, i) => (
                <li key={`${e.checkedAt}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate"><b className="text-content-primary">{e.providerName}</b> <span className="text-content-secondary">· {e.errorKind}</span></span>
                  <span className="shrink-0 text-content-secondary">{e.latencyMs !== null ? `${e.latencyMs} мс · ` : ''}{timeAgoRu(e.checkedAt)}</span>
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
      {j.failedRuns > 0 && <p className="mt-0.5 text-xs font-semibold text-rose-600">{j.failedRuns} {plural(j.failedRuns, ['неудачный запуск', 'неудачных запуска', 'неудачных запусков'])} за период</p>}
    </article>
  )
}

function ProviderRow({ provider: p }: { provider: ProviderPulse }) {
  const badge = HEALTH_BADGE[p.health] ?? HEALTH_BADGE.disabled
  const kinds = Object.entries(p.errorsByKind).sort((a, b) => b[1] - a[1])
  const rate = p.errorRate === null ? '—' : `${Math.round(p.errorRate * 100)}%`
  const bad = p.errorRate !== null && p.errorRate >= 0.5 && p.checks >= 5
  return (
    <article className={cn('rounded-3xl border bg-white p-4 shadow-card', p.health === 'unavailable' || bad ? 'border-rose-300' : p.lowBalance ? 'border-amber-300' : 'border-blue-100/70')} aria-label={`Провайдер ${p.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-content-primary">{p.name}</h3>
          <span className={cn('mt-1 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold', badge.className)}>{badge.label}</span>
          {!p.routingEnabled && <span className="ml-1.5 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">Маршрутизация выключена</span>}
        </div>
        <p className="shrink-0 text-right text-[11px] text-content-secondary">проверен {timeAgoRu(p.lastHealthCheck)}</p>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-content-secondary">Ошибки проверок</dt><dd className={cn('font-bold', bad ? 'text-rose-600' : 'text-content-primary')}>{rate}</dd><dd className="text-[11px] text-content-secondary">{p.failedChecks} из {p.checks}</dd></div>
        <div><dt className="text-xs text-content-secondary">Задержка</dt><dd className="font-bold text-content-primary">{p.avgLatencyMs === null ? '—' : `${p.avgLatencyMs} мс`}</dd><dd className="text-[11px] text-content-secondary">{p.maxLatencyMs === null ? '' : `макс. ${p.maxLatencyMs} мс`}</dd></div>
        <div><dt className="text-xs text-content-secondary">Баланс</dt><dd className={cn('font-bold', p.lowBalance ? 'text-amber-600' : 'text-content-primary')}>{p.lastBalanceSync ? usd(p.balance) : '—'}</dd><dd className="text-[11px] text-content-secondary">{p.currency}</dd></div>
      </dl>
      {kinds.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {kinds.map(([k, n]) => <span key={k} className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">{k} × {n}</span>)}
        </p>
      )}
      <p className="mt-2 text-xs text-content-secondary">Заказов за период: {p.orders} · неудачных {p.ordersFailed} · на удержании {p.ordersHeld}</p>
    </article>
  )
}
