import { Component, useState, type ReactNode } from 'react'
import { AlertCircle, BarChart3, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { FUNNEL_LABELS, barPercents, formatRate, noSales, overallRetention, revenueTotals, shortDay } from '@/lib/bi-view'
import { haptic } from '@/lib/haptics'
import { formatInt, formatMoneyAmount } from '@/lib/order-calc'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getBiDashboard } from '@/services/api/admin-bi'
import { BI_RANGES, type BiRange, type FunnelStep, type RetentionCohort, type RevenueDay, type Section, type TopService } from '@/types/admin-bi'

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------
export function AnalyticsTab({ session }: { session: AuthSession }) {
  const [days, setDays] = useState<BiRange>(30)
  const { data, error, loading, reload } = useLoader(() => getBiDashboard(session, days), [days, session.token, session.isMock])

  return (
    <div className="space-y-3">
      <RangePicker value={days} onChange={(d) => { haptic.select(); setDays(d) }} onRefresh={() => void reload()} refreshing={loading} />

      {!data && error ? (
        <Card className="space-y-3 text-center" role="alert">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{error}</p>
          <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
        </Card>
      ) : (
        <>
          <Boundary name="Выручка"><RevenueSection section={data?.revenue ?? null} /></Boundary>
          <Boundary name="Воронка"><FunnelSection section={data?.funnel ?? null} /></Boundary>
          <Boundary name="Лучшие услуги"><TopServicesSection section={data?.topServices ?? null} /></Boundary>
          <Boundary name="Возвращаемость"><RetentionSection section={data?.retention ?? null} /></Boundary>
        </>
      )}
    </div>
  )
}

export function RangePicker({ value, onChange, onRefresh, refreshing }: { value: BiRange; onChange: (d: BiRange) => void; onRefresh: () => void; refreshing: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div role="radiogroup" aria-label="Период" className="flex gap-1 rounded-2xl bg-white/70 p-1">
        {BI_RANGES.map((d) => (
          <button key={d} type="button" role="radio" aria-checked={value === d} onClick={() => onChange(d)}
            className={cn('h-8 rounded-xl px-3 text-[13px] font-semibold', value === d ? 'bg-brand text-white shadow-sm' : 'text-content-secondary')}>
            {d} дн.
          </button>
        ))}
      </div>
      <button type="button" onClick={onRefresh} aria-label="Обновить" disabled={refreshing} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-content-secondary active:scale-90 disabled:opacity-50">
        <RefreshCw size={16} strokeWidth={1.75} className={cn(refreshing && 'animate-spin')} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// A render error in one card must not blank the whole admin screen
// ---------------------------------------------------------------------------
export class Boundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Card role="alert" className="p-4 text-sm text-content-secondary">
        <span className="font-semibold text-content-primary">{this.props.name}</span>: не удалось показать.
      </Card>
    )
  }
}

// ---------------------------------------------------------------------------
// A card with the three states every section shares: loading, failed, empty
// ---------------------------------------------------------------------------
function Shell({ title, hint, section, empty, children }: {
  title: string
  hint?: string
  section: Section<unknown[]> | null
  empty: (data: never) => boolean
  children: (data: never) => ReactNode
}) {
  return (
    <Card className="space-y-3 p-4" aria-busy={section === null}>
      <div>
        <h2 className="text-[15px] font-bold text-content-primary">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-content-secondary">{hint}</p>}
      </div>
      {section === null ? (
        <div className="space-y-2" role="status" aria-label={`Загрузка: ${title.toLowerCase()}`}>
          {[0, 1, 2].map((i) => <div key={i} className="h-6 animate-pulse rounded-lg bg-blue-100/70" />)}
        </div>
      ) : 'error' in section ? (
        <p role="alert" className="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[13px] font-medium text-rose-700">{section.error}</p>
      ) : empty(section.data as never) ? (
        <div className="flex flex-col items-center gap-1.5 py-6 text-center text-content-muted">
          <BarChart3 size={24} strokeWidth={1.5} />
          <p className="text-sm font-medium">За этот период данных пока нет.</p>
        </div>
      ) : (
        children(section.data as never)
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Revenue, margin, AOV
// ---------------------------------------------------------------------------
export function RevenueSection({ section }: { section: Section<RevenueDay[]> | null }) {
  return (
    <Shell title="Выручка и маржа" hint="За вычетом возвратов, по дням (UTC)" section={section} empty={(d: RevenueDay[]) => noSales(d)}>
      {(days: RevenueDay[]) => {
        const t = revenueTotals(days)
        const bars = barPercents(days.map((d) => d.revenue))
        return (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Kpi label="Выручка" value={formatMoneyAmount(t.revenue)} />
              <Kpi label="Маржа" value={formatMoneyAmount(t.margin)} sub={t.marginPercent === null ? undefined : `${formatRate(t.marginPercent)} от выручки`} />
              <Kpi label="Заказы" value={formatInt(t.orders)} />
              <Kpi label="Средний чек" value={t.aov === null ? '–' : formatMoneyAmount(t.aov)} />
            </dl>
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1" aria-label="Выручка по дням">
              {[...days].reverse().map((d, i) => {
                const width = bars[days.length - 1 - i]
                return (
                  <li key={d.day} className="grid grid-cols-[3rem_1fr_auto] items-center gap-2 text-xs">
                    <span className="font-medium text-content-secondary">{shortDay(d.day)}</span>
                    <span className="h-3 overflow-hidden rounded-full bg-blue-100/60" aria-hidden="true">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${width}%` }} />
                    </span>
                    <span className="text-right font-semibold text-content-primary">
                      {formatMoneyAmount(d.revenue)}
                      <span className="ml-1.5 font-normal text-content-muted">{d.orders} · чек {d.aov === null ? '–' : formatMoneyAmount(d.aov)}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )
      }}
    </Shell>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-surface-sub px-3 py-2.5">
      <dt className="text-xs text-content-secondary">{label}</dt>
      <dd className="text-lg font-extrabold text-content-primary">{value}</dd>
      {sub && <p className="text-[11px] text-content-muted">{sub}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------
export function FunnelSection({ section }: { section: Section<FunnelStep[]> | null }) {
  return (
    <Shell title="Воронка конверсии" hint="Пользователи, дошедшие до каждого шага по порядку" section={section} empty={(d: FunnelStep[]) => d.length === 0 || d[0].users === 0}>
      {(steps: FunnelStep[]) => {
        const first = Math.max(1, steps[0]?.users ?? 1)
        return (
          <ol className="space-y-2.5">
            {steps.map((s) => (
              <li key={s.step}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-semibold text-content-primary">{FUNNEL_LABELS[s.step] ?? s.step}</span>
                  <span className="font-bold text-content-primary">{formatInt(s.users)}</span>
                </div>
                <div className="mt-1 h-3 overflow-hidden rounded-full bg-blue-100/60" aria-hidden="true">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(s.users > 0 ? 2 : 0, Math.round((s.users / first) * 1000) / 10)}%` }} />
                </div>
                <p className="mt-0.5 text-[11px] text-content-muted">
                  {s.rateFromPrevious === null ? 'Начало воронки' : `${formatRate(s.rateFromPrevious)} от прошлого шага · ${formatRate(s.rateFromFirst)} от всех`}
                </p>
              </li>
            ))}
          </ol>
        )
      }}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// Top services
// ---------------------------------------------------------------------------
export function TopServicesSection({ section }: { section: Section<TopService[]> | null }) {
  return (
    <Shell title="Лучшие услуги" hint="По чистой выручке" section={section} empty={(d: TopService[]) => d.length === 0}>
      {(services: TopService[]) => (
        <ol className="space-y-2">
          {services.map((s, i) => (
            <li key={s.serviceId} className="flex items-start gap-3 rounded-2xl bg-surface-sub px-3 py-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand-text">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-content-primary">{s.name}</p>
                <p className="text-xs text-content-secondary">{formatInt(s.orders)} заказов · {formatInt(s.units)} шт. · чек {formatMoneyAmount(s.aov)}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-extrabold text-content-primary">{formatMoneyAmount(s.revenue)}</p>
                <p className="text-xs font-medium text-emerald-600">маржа {formatMoneyAmount(s.margin)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
export function RetentionSection({ section }: { section: Section<RetentionCohort[]> | null }) {
  return (
    <Shell title="Возвращаемость" hint="Какая доля пользователей каждого дня регистрации вернулась на 1-й и 7-й день" section={section} empty={(d: RetentionCohort[]) => d.length === 0}>
      {(cohorts: RetentionCohort[]) => {
        const overall = overallRetention(cohorts)
        const shown = [...cohorts].reverse().slice(0, 14)
        return (
          <>
            <dl className="grid grid-cols-2 gap-2">
              {overall.length === 0 ? (
                <p className="col-span-2 text-xs text-content-muted">Эти регистрации слишком свежие, чтобы измерить.</p>
              ) : overall.map((o) => <Kpi key={o.day} label={`Возвращаемость, день ${o.day}`} value={formatRate(o.rate)} sub={`${formatInt(o.users)} из ${formatInt(o.size)} пользователей`} />)}
            </dl>
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Возвращаемость по дням регистрации</caption>
              <thead>
                <tr className="text-content-muted">
                  <th scope="col" className="py-1 font-medium">День регистрации</th>
                  <th scope="col" className="py-1 text-right font-medium">Пользователи</th>
                  <th scope="col" className="py-1 text-right font-medium">День 1</th>
                  <th scope="col" className="py-1 text-right font-medium">День 7</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.cohort} className="border-t border-blue-100/60">
                    <td className="py-1.5 font-medium text-content-primary">{shortDay(c.cohort)}</td>
                    <td className="py-1.5 text-right text-content-secondary">{formatInt(c.size)}</td>
                    {[1, 7].map((day) => <td key={day} className="py-1.5 text-right font-semibold text-content-primary">{formatRate(c.retention.find((r) => r.day === day)?.rate ?? null)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      }}
    </Shell>
  )
}
