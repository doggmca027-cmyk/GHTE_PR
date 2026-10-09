import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { ANALYTICS_RANGES, usd, type AnalyticsRangeKey } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { formatInt } from '@/lib/order-calc'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getProfitAnalytics } from '@/services/api/admin'
import { MetricCard } from './MetricCard'

/** Revenue, cost, profit, treasury fees and net profit for a chosen period (admin-analytics). `refreshKey` forces a reload. */
export function ProfitPanel({ session, refreshKey }: { session: AuthSession; refreshKey: number }) {
  const [range, setRange] = useState<AnalyticsRangeKey>('30d')
  const { data, error, loading, reload } = useLoader(() => getProfitAnalytics(session, range), [session.token, session.isMock, range, refreshKey])

  return (
    <section aria-label="Прибыль и убытки" className="space-y-3">
      <div role="radiogroup" aria-label="Период" className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5">
        {ANALYTICS_RANGES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={range === key}
            onClick={() => { if (range !== key) { haptic.select(); setRange(key) } }}
            className={cn(
              'shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors active:scale-95',
              range === key ? 'bg-brand text-white' : 'bg-white/70 text-content-secondary',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!data && loading && (
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[92px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}
        </div>
      )}

      {!data && !loading && (
        <Card className="space-y-3 text-center">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{error ?? 'Не удалось загрузить аналитику.'}</p>
          <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
        </Card>
      )}

      {data && (
        <div className={cn('grid grid-cols-2 gap-3 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <MetricCard
            label="Выручка"
            value={usd(data.grossRevenue)}
            hint={`выполнено ${formatInt(data.completedOrders + data.partialOrders)} из ${formatInt(data.totalOrders)} заказов`}
          />
          <MetricCard label="Затраты на провайдеров" value={usd(data.providerCost)} hint="За выполненное" />
          <MetricCard
            label="Валовая прибыль"
            value={usd(data.grossProfit)}
            tone={data.grossProfit < 0 ? 'danger' : 'default'}
            hint={data.marginPct === null ? 'Выручки пока нет' : `маржа ${data.marginPct.toFixed(1)}%`}
          />
          <MetricCard label="Комиссии казны" value={usd(data.treasuryFees)} hint="Операционные расходы" />
          <MetricCard label="Комиссии сети" value={usd(data.networkFees)} hint="Комиссии блокчейна, которые мы заплатили" />
          <MetricCard label="Возвраты" value={usd(data.refundCost)} hint="Вернули клиентам, это не выручка" />
          <div className="col-span-2">
            <MetricCard
              label="Чистая прибыль"
              value={`${data.netProfit < 0 ? '-' : ''}${usd(Math.abs(data.netProfit))}`}
              tone={data.netProfit < 0 ? 'danger' : 'success'}
              hint={data.netProfit < 0 ? 'Убыток за период: расходы больше прибыли' : 'Валовая прибыль минус комиссии казны и сети'}
            />
          </div>
          {data.netProfit < 0 && <p role="alert" className="col-span-2 rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[13px] font-semibold text-rose-700">За этот период чистая прибыль отрицательная.</p>}
        </div>
      )}
    </section>
  )
}
