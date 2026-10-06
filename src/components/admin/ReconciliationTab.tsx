import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, RotateCw, ShieldCheck, TriangleAlert } from 'lucide-react'
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
import { getReconCases, resolveCaseManual, resolveCaseRefund, retryCase } from '@/services/api/admin'
import { caseSeverity, type Severity } from '../../../supabase/functions/_shared/recon-severity.ts'
import type { ReconCase } from '@/types/admin'

interface Props {
  session: AuthSession
  onProblemCount: (n: number) => void
}

const SEVERITY: Record<Severity, { label: string; badge: string; border: string }> = {
  critical: { label: 'Critical', badge: 'bg-rose-600 text-white', border: 'border-rose-300' },
  high: { label: 'High', badge: 'bg-amber-500 text-white', border: 'border-amber-300' },
  normal: { label: 'Normal', badge: 'bg-slate-200 text-slate-700', border: 'border-amber-200' },
}
const RANK: Record<Severity, number> = { critical: 0, high: 1, normal: 2 }

export function ReconciliationTab({ session, onProblemCount }: Props) {
  const { data, error, loading, reload } = useLoader(() => getReconCases(session), [session.token, session.isMock])
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
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load the cases.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  const now = Date.now()
  const sorted = [...data]
    .map((c) => ({ c, severity: caseSeverity({ reason: c.reason, createdAt: c.createdAt, amount: c.order?.chargeAmount ?? null }, now) }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || Date.parse(a.c.createdAt) - Date.parse(b.c.createdAt))

  return (
    <div className="space-y-3">
      {flash && (
        <p role="status" className="rounded-2xl bg-emerald-50 px-3.5 py-2.5 text-[13px] font-medium text-emerald-700">{flash}</p>
      )}

      {sorted.length === 0 ? (
        <Card className="space-y-2 py-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 size={28} strokeWidth={1.75} />
          </span>
          <p className="text-base font-bold text-content-primary">All clear</p>
          <p className="mx-auto max-w-[250px] text-sm text-content-secondary">
            Nothing is waiting on a human. Held orders appear here after 10 minutes.
          </p>
        </Card>
      ) : (
        sorted.map(({ c, severity }) => (
          <CaseCard
            key={c.id}
            kase={c}
            severity={severity}
            session={session}
            onDone={(message) => { setFlash(message); void reload() }}
            onFailed={() => void reload()}
          />
        ))
      )}
    </div>
  )
}

function CaseCard({ kase, severity, session, onDone, onFailed }: { kase: ReconCase; severity: Severity; session: AuthSession; onDone: (message: string) => void; onFailed: () => void }) {
  const order = kase.order
  const note = describeNote(order?.errorMessage ?? kase.reason)
  const isProcessing = order?.status === 'processing'
  const [confirm, setConfirm] = useState<'refund' | 'retry' | null>(null)
  const [resolving, setResolving] = useState(false)
  const [providerId, setProviderId] = useState(recoverProviderOrderId(order?.errorMessage ?? kase.reason) ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function run(action: () => Promise<void>, doneMessage: string) {
    setBusy(true)
    setError(null)
    setConfirm(null)
    try {
      await action()
      haptic.success()
      onDone(doneMessage)
    } catch (e) {
      haptic.error()
      setError(e instanceof Error ? e.message : 'Action failed.')
      setBusy(false)
      onFailed() // the case may have changed (a retry that timed out, a case someone else closed)
    }
  }

  function ask(which: 'refund' | 'retry') {
    haptic.tap()
    setConfirm(which)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setConfirm(null), 6000) // an accidental tap expires on its own
  }

  const style = SEVERITY[severity]
  const needsProviderId = isProcessing === true
  return (
    <article className={cn('rounded-3xl border bg-white p-4 shadow-card', style.border)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', style.badge)}>{style.label}</span>
            <span className="text-[11px] font-semibold text-content-muted">{timeAgo(kase.createdAt)} old</span>
          </div>
          <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-content-primary">{order?.serviceName ?? `${kase.entityType} ${kase.entityId}`}</h3>
          {order && (
            <p className="mt-0.5 text-xs text-content-secondary">
              @{order.username ?? order.telegramId} · {formatOrderDate(order.createdAt)}
            </p>
          )}
        </div>
        {order && <StatusBadge status={order.status} />}
      </div>

      {order && (
        <p className="mt-2 truncate rounded-2xl bg-surface-sub px-3 py-2 text-[13px] font-medium text-content-secondary" title={order.targetUrl}>
          {truncateUrl(order.targetUrl, 40)}
        </p>
      )}

      <div className="mt-3 flex gap-2.5 rounded-2xl bg-amber-50 p-3 text-[13px] text-amber-900">
        <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          <p className="font-bold">{note.title}</p>
          <p className="mt-0.5 font-medium text-amber-800">{note.detail}</p>
        </div>
      </div>

      {order && (
        <div className="mt-3 flex items-end justify-between text-xs font-medium text-content-secondary">
          <span>Qty <b className="text-content-primary">{formatInt(order.quantity)}</b></span>
          <span className="text-lg font-extrabold text-content-primary">{usd(order.chargeAmount)}</span>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>
      )}

      {resolving ? (
        <div className="mt-3 space-y-2 rounded-2xl border border-blue-100/70 bg-surface-sub p-3">
          {needsProviderId && (
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
            Note {needsProviderId ? '(optional)' : '(required)'}
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={needsProviderId ? 'Verified in provider panel' : 'Handled outside the app'}
              className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand"
            />
          </label>
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1 text-sm"
              disabled={busy || (needsProviderId ? providerId.trim() === '' : text.trim() === '')}
              onClick={() =>
                void run(
                  () => resolveCaseManual(session, kase.id, { providerOrderId: providerId || undefined, note: text || undefined }),
                  needsProviderId ? 'Case resolved. The sync worker will track the order.' : 'Case marked as resolved.',
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
        <div className={cn('mt-3 grid gap-2', order?.canRetry ? 'grid-cols-3' : 'grid-cols-2')}>
          {order && (
            <button
              type="button"
              disabled={busy}
              onClick={confirm === 'refund' ? () => void run(() => resolveCaseRefund(session, kase.id, text || undefined), 'Order refunded to the customer.') : () => ask('refund')}
              className={cn(
                'min-h-11 rounded-2xl px-1 text-[13px] font-bold leading-tight transition-all active:scale-95 disabled:opacity-50',
                confirm === 'refund' ? 'bg-rose-600 text-white' : 'border border-rose-200 bg-white text-rose-600',
              )}
            >
              {confirm === 'refund' ? `Confirm ${usd(order.chargeAmount)}` : 'Force Refund'}
            </button>
          )}
          {order?.canRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={confirm === 'retry' ? () => void run(() => retryCase(session, kase.id), 'Order re-submitted to the provider.') : () => ask('retry')}
              className={cn(
                'flex min-h-11 items-center justify-center gap-1 rounded-2xl px-1 text-[13px] font-bold leading-tight transition-all active:scale-95 disabled:opacity-50',
                confirm === 'retry' ? 'bg-amber-500 text-white' : 'border border-amber-300 bg-white text-amber-700',
              )}
            >
              <RotateCw size={14} strokeWidth={2} className={cn(busy && 'animate-spin')} /> {confirm === 'retry' ? 'Confirm' : 'Retry Order'}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => { haptic.tap(); setResolving(true); setConfirm(null) }}
            className="flex min-h-11 items-center justify-center gap-1 rounded-2xl bg-brand-light px-1 text-[13px] font-bold leading-tight text-brand-text transition-all active:scale-95 disabled:opacity-50"
          >
            <ShieldCheck size={15} strokeWidth={1.75} /> Mark Resolved
          </button>
        </div>
      )}
      {confirm === 'refund' && isProcessing && !note.refundOwed && (
        <p className="mt-2 text-[12px] font-medium text-rose-600">
          If the provider did accept this order it will still be delivered, and refunding costs you the provider charge.
        </p>
      )}
      {confirm === 'retry' && (
        <p className="mt-2 text-[12px] font-medium text-amber-700">
          Check the provider panel first. If it already created this order, retrying delivers it twice. The retry goes to the same provider the customer was charged for.
        </p>
      )}
    </article>
  )
}
