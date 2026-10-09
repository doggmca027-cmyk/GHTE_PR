import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ReceiptText, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { isActiveStatus, matchesFilter, ORDER_FILTERS, type OrderFilter } from '@/lib/order-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getOrders } from '@/services/api/orders'
import type { IOrderView } from '@/types/orders'
import { OrderCard } from './OrderCard'

const POLL_MS = 15_000
const MOCK_POLL_MS = 3_000

interface Props {
  session: AuthSession
  onBrowse: () => void
  /** "Report an issue" on a card: open the support form for this order. */
  onReportIssue?: (order: IOrderView) => void
}

export function OrdersScreen({ session, onBrowse, onReportIssue }: Props) {
  const t = useT()
  const { refreshWallet } = useAuth()
  const lastStatuses = useRef<Map<string, string>>(new Map())
  const [orders, setOrders] = useState<IOrderView[] | null>(null)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<OrderFilter>('all')
  const mounted = useRef(true)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const rows = await getOrders(session)
      if (!mounted.current) return
      // A refund (partial / cancel) lands in the wallet when an order reaches that state: refresh the balance.
      const refunded = rows.some((r) => (r.status === 'partial' || r.status === 'refunded') && lastStatuses.current.has(r.id) && lastStatuses.current.get(r.id) !== r.status)
      lastStatuses.current = new Map(rows.map((r) => [r.id, r.status]))
      setOrders(rows)
      setError(false)
      if (refunded) void refreshWallet()
    } catch {
      if (mounted.current) setError(true)
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [session.token, session.isMock]) // reload on identity change, not on balance refresh

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  // Poll while something is still moving.
  const hasActive = orders?.some((o) => isActiveStatus(o.status)) ?? false
  useEffect(() => {
    if (!hasActive) return
    const t = setInterval(() => void load(), session.isMock ? MOCK_POLL_MS : POLL_MS)
    return () => clearInterval(t)
  }, [hasActive, load, session.isMock])

  const visible = useMemo(() => (orders ?? []).filter((o) => matchesFilter(o.status, filter)), [orders, filter])

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-2xl font-extrabold tracking-tight text-content-primary">{t('Orders')}</h1>
        <button
          type="button"
          onClick={() => { haptic.tap(); void load() }}
          disabled={refreshing}
          aria-label={t('Refresh orders')}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-blue-100/70 bg-white text-content-secondary shadow-sm active:scale-90"
        >
          <RefreshCw size={18} strokeWidth={1.75} className={cn(refreshing && 'animate-spin')} />
        </button>
      </div>

      <div role="tablist" aria-label={t('Order filter')} className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5 py-1">
        {ORDER_FILTERS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={filter === id}
            onClick={() => { if (filter !== id) haptic.select(); setFilter(id) }}
            className={cn(
              'shrink-0 rounded-2xl px-3.5 py-2 text-[13px] font-semibold transition-colors duration-200 active:scale-95',
              filter === id ? 'bg-brand-light text-brand-text' : 'bg-white/70 text-content-secondary hover:bg-white',
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {orders === null && !error && [0, 1].map((i) => <div key={i} className="h-[170px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}

        {error && (
          <Card className="space-y-3 text-center">
            <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
            <p className="text-sm font-medium text-content-secondary">{t("Couldn't load your orders. Check your connection and retry.")}</p>
            <Button className="w-full" onClick={() => void load()}>{t('Retry')}</Button>
          </Card>
        )}

        {orders !== null && visible.length === 0 && (
          <Card className="space-y-3 py-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-light text-brand">
              <ReceiptText size={26} strokeWidth={1.75} />
            </span>
            <p className="text-base font-bold text-content-primary">{orders.length === 0 ? t('No orders yet') : t('Nothing here')}</p>
            <p className="mx-auto max-w-[240px] text-sm text-content-secondary">
              {orders.length === 0 ? t('Your orders will show up here as soon as you place your first one.') : t('No orders match this filter.')}
            </p>
            {orders.length === 0 && <Button className="mx-auto" onClick={onBrowse}>{t('Browse services')}</Button>}
          </Card>
        )}

        {visible.map((order) => <OrderCard key={order.id} order={order} onReportIssue={onReportIssue} />)}
      </div>
    </>
  )
}
