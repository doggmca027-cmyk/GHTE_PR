import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { StatusBadge } from '@/components/orders/StatusBadge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { describeNote, recoverProviderOrderId, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { formatInt } from '@/lib/order-calc'
import { formatOrderDate, truncateUrl } from '@/lib/order-view'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { forceRefund, getReconciliationQueue, markResolved } from '@/services/api/admin'
import type { ReconciliationOrder } from '@/types/admin'

interface Props {
  session: AuthSession
  onProblemCount: (n: number) => void
}

export function ReconciliationTab({ session, onProblemCount }: Props) {
  const { data, error, loading, reload } = useLoader(() => getReconciliationQueue(session), [session.token, session.isMock])
  const [flash, setFlash] = useState<string | null>(null)

  useEffect(() => {
    if (data) onProblemCount(data.length)
  }, [data, onProblemCount])

  if (!data && loading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="h-[190px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
        ))}
      </div>
    )
  }
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load the queue.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {flash && (
        <p role="status" className="rounded-2xl bg-emerald-50 px-3.5 py-2.5 text-[13px] font-medium text-emerald-700">{flash}</p>
      )}

      {data.length === 0 ? (
        <Card className="space-y-2 py-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 size={28} strokeWidth={1.75} />
          </span>
          <p className="text-base font-bold text-content-primary">All clear</p>
          <p className="mx-auto max-w-[250px] text-sm text-content-secondary">
            No orders are waiting on a human. Held orders appear here after 10 minutes.
          </p>
        </Card>
      ) : (
        data.map((order) => (
          <QueueCard key={order.id} order={order} session={session} onDone={(message) => { setFlash(message); void reload() }} />
        ))
      )}
    </div>
  )
}

function QueueCard({ order, session, onDone }: { order: ReconciliationOrder; session: AuthSession; onDone: (message: string) => void }) {
  const note = describeNote(order.errorMessage)
  const isProcessing = order.status === 'processing'
  const [confirmRefund, setConfirmRefund] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [providerId, setProviderId] = useState(recoverProviderOrderId(order.errorMessage) ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function run(action: () => Promise<void>, doneMessage: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      haptic.success()
      onDone(doneMessage)
    } catch (e) {
      haptic.error()
      setError(e instanceof Error ? e.message : 'Action failed.')
      setBusy(false)
    }
  }

  function askRefund() {
    haptic.tap()
    setConfirmRefund(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setConfirmRefund(false), 5000) // an accidental tap expires on its own
  }

  return (
    <article className="rounded-3xl border border-amber-200 bg-white p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-content-primary">{order.serviceName}</h3>
          <p className="mt-0.5 text-xs text-content-secondary">
            @{order.username ?? order.telegramId} · {timeAgo(order.createdAt)} · {formatOrderDate(order.createdAt)}
          </p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <p className="mt-2 truncate rounded-2xl bg-surface-sub px-3 py-2 text-[13px] font-medium text-content-secondary" title={order.targetUrl}>
        {truncateUrl(order.targetUrl, 40)}
      </p>

      <div className="mt-3 flex gap-2.5 rounded-2xl bg-amber-50 p-3 text-[13px] text-amber-900">
        <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          <p className="font-bold">{note.title}</p>
          <p className="mt-0.5 font-medium text-amber-800">{note.detail}</p>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between text-xs font-medium text-content-secondary">
        <span>Qty <b className="text-content-primary">{formatInt(order.quantity)}</b></span>
        <span className="text-lg font-extrabold text-content-primary">{usd(order.chargeAmount)}</span>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>
      )}

      {resolving ? (
        <div className="mt-3 space-y-2 rounded-2xl border border-blue-100/70 bg-surface-sub p-3">
          {isProcessing && (
            <label className="block text-xs font-bold text-content-primary">
              Provider order id
              <input
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="e.g. 90210"
                className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand"
              />
            </label>
          )}
          <label className="block text-xs font-bold text-content-primary">
            Note {isProcessing ? '(optional)' : '(required)'}
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={isProcessing ? 'Verified in provider panel' : 'Refunded manually via adjustment'}
              className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand"
            />
          </label>
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1 text-sm"
              disabled={busy || (isProcessing ? providerId.trim() === '' : text.trim() === '')}
              onClick={() =>
                void run(
                  () => markResolved(session, order.id, { providerOrderId: providerId, note: text }),
                  isProcessing ? 'Order resolved. The sync worker will track it.' : 'Order marked as resolved.',
                )
              }
            >
              Confirm
            </Button>
            <button type="button" onClick={() => setResolving(false)} className="h-11 flex-1 rounded-2xl bg-white text-sm font-semibold text-content-secondary active:scale-95">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={confirmRefund ? () => void run(() => forceRefund(session, order.id, text || undefined), 'Order refunded to the customer.') : askRefund}
            className={cn(
              'h-11 rounded-2xl text-sm font-bold transition-all active:scale-95 disabled:opacity-50',
              confirmRefund ? 'bg-rose-600 text-white' : 'border border-rose-200 bg-white text-rose-600',
            )}
          >
            {confirmRefund ? `Confirm refund ${usd(order.chargeAmount)}` : 'Force refund'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { haptic.tap(); setResolving(true); setConfirmRefund(false) }}
            className="flex h-11 items-center justify-center gap-1.5 rounded-2xl bg-brand-light text-sm font-bold text-brand-text transition-all active:scale-95 disabled:opacity-50"
          >
            <ShieldCheck size={16} strokeWidth={1.75} /> Mark resolved
          </button>
        </div>
      )}
      {confirmRefund && isProcessing && !note.refundOwed && (
        <p className="mt-2 text-[12px] font-medium text-rose-600">
          If the provider did accept this order it will still be delivered, and refunding costs you the provider charge.
        </p>
      )}
    </article>
  )
}
