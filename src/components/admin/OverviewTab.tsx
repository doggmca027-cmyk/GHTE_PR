import { useEffect, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { haptic } from '@/lib/haptics'
import { formatInt } from '@/lib/order-calc'
import { timeAgo } from '@/lib/time'
import { usd } from '@/lib/admin-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getAdminMetrics, getProviderStatus } from '@/services/api/admin'
import { MetricCard } from './MetricCard'
import { ProfitPanel } from './ProfitPanel'

interface Props {
  session: AuthSession
  onOpenQueue: () => void
  onProblemCount: (n: number) => void
}

export function OverviewTab({ session, onOpenQueue, onProblemCount }: Props) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, error, loading, reload } = useLoader(
    async () => {
      const [metrics, providers] = await Promise.all([getAdminMetrics(session), getProviderStatus(session)])
      return { metrics, providers }
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
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load metrics.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  const { metrics: m, providers } = data
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-content-secondary">Delivered orders only; refunds excluded.</p>
        <button
          type="button"
          aria-label="Refresh metrics"
          onClick={() => { haptic.tap(); setRefreshKey((k) => k + 1); void reload() }}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-blue-100/70 bg-white text-content-secondary shadow-sm active:scale-90"
        >
          <RefreshCw size={16} strokeWidth={1.75} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      <ProfitPanel session={session} refreshKey={refreshKey} />

      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="Active orders" value={formatInt(m.activeOrders)} hint={`${formatInt(m.totalOrders)} total`} />
        <MetricCard label="Users" value={formatInt(m.totalUsers)} />
        <MetricCard
          label="Needs attention"
          value={formatInt(m.problematicOrders)}
          tone={m.problematicOrders > 0 ? 'warning' : 'default'}
          hint={m.problematicOrders > 0 ? 'Open reconciliation' : 'All clear'}
          onClick={m.problematicOrders > 0 ? onOpenQueue : undefined}
        />
      </div>

      <Card className="space-y-2.5 p-4 text-sm">
        <Row label="In progress (not yet earned)" value={usd(m.pendingRevenue)} />
        <Row label="User balances (owed to users)" value={usd(m.userBalances)} />
        <Row label="Total deposited" value={usd(m.depositsTotal)} />
      </Card>

      <div>
        <h2 className="mb-2 text-base font-extrabold text-content-primary">Providers</h2>
        <div className="space-y-2.5">
          {providers.length === 0 && <Card className="p-4 text-sm text-content-secondary">No providers configured.</Card>}
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
                {p.isActive ? `${formatInt(p.activeServices)} active services` : 'Inactive'} · balance checked {timeAgo(p.balanceUpdatedAt)} · catalog synced {timeAgo(p.lastSyncedAt)}
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
