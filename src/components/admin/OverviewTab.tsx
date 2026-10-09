import { useEffect, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { haptic } from '@/lib/haptics'
import { formatInt } from '@/lib/order-calc'
import { plural, timeAgoRu, usd } from '@/lib/admin-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getAdminMetrics, getPlatformSettings, getProviderStatus } from '@/services/api/admin'
import { MetricCard } from './MetricCard'
import { ProfitPanel } from './ProfitPanel'
import { UnfundedCard } from './UnfundedCard'

interface Props {
  session: AuthSession
  onOpenQueue: () => void
  onProblemCount: (n: number) => void
}

export function OverviewTab({ session, onOpenQueue, onProblemCount }: Props) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, error, loading, reload } = useLoader(
    async () => {
      // the waiting-for-funds card is extra: if its request fails the rest of the screen still shows
      const [metrics, providers, settings] = await Promise.all([getAdminMetrics(session), getProviderStatus(session), getPlatformSettings(session).catch(() => null)])
      return { metrics, providers, settings }
    },
    [session.token, session.isMock],
  )

  useEffect(() => {
    if (data) onProblemCount(data.metrics.problematicOrders)
  }, [data, onProblemCount])

  if (!data && loading) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
        ))}
      </div>
    )
  }
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Не удалось загрузить показатели.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
      </Card>
    )
  }

  const { metrics: m, providers, settings } = data
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-content-secondary">Только выполненные заказы, возвраты не учитываются.</p>
        <button
          type="button"
          aria-label="Обновить показатели"
          onClick={() => { haptic.tap(); setRefreshKey((k) => k + 1); void reload() }}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-blue-100/70 bg-white text-content-secondary shadow-sm active:scale-90"
        >
          <RefreshCw size={16} strokeWidth={1.75} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {settings && <UnfundedCard unfunded={settings.unfunded} ttlHours={settings.deferredOrdersTtlHours} />}

      <ProfitPanel session={session} refreshKey={refreshKey} />

      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="Активные заказы" value={formatInt(m.activeOrders)} hint={`всего ${formatInt(m.totalOrders)}`} />
        <MetricCard label="Пользователи" value={formatInt(m.totalUsers)} />
        <MetricCard
          label="Требуют внимания"
          value={formatInt(m.problematicOrders)}
          tone={m.problematicOrders > 0 ? 'warning' : 'default'}
          hint={m.problematicOrders > 0 ? 'Открыть сверку' : 'Всё в порядке'}
          onClick={m.problematicOrders > 0 ? onOpenQueue : undefined}
        />
      </div>

      <Card className="space-y-2.5 p-4 text-sm">
        <Row label="В работе (ещё не заработано)" value={usd(m.pendingRevenue)} />
        <Row label="Балансы пользователей (наш долг)" value={usd(m.userBalances)} />
        <Row label="Всего пополнено" value={usd(m.depositsTotal)} />
      </Card>

      <div>
        <h2 className="mb-2 text-base font-extrabold text-content-primary">Провайдеры</h2>
        <div className="space-y-2.5">
          {providers.length === 0 && <Card className="p-4 text-sm text-content-secondary">Провайдеры не настроены.</Card>}
          {providers.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-[15px] font-bold text-content-primary">
                  <span className={cn('h-2 w-2 rounded-full', p.isActive ? 'bg-emerald-500' : 'bg-slate-300')} />
                  {p.name}
                </p>
                <p className="text-lg font-extrabold text-content-primary">{usd(p.balance)}</p>
              </div>
              <p className="mt-1 text-xs text-content-secondary">
                {p.isActive ? `${formatInt(p.activeServices)} ${plural(p.activeServices, ['активная услуга', 'активные услуги', 'активных услуг'])}` : 'Выключен'} · баланс проверен {timeAgoRu(p.balanceUpdatedAt)} · каталог обновлён {timeAgoRu(p.lastSyncedAt)}
              </p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-medium text-content-secondary">{label}</span>
      <span className="font-bold text-content-primary">{value}</span>
    </div>
  )
}
