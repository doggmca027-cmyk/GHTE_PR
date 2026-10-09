import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Landmark, RotateCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { StatusBadge } from '@/components/orders/StatusBadge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { describeNote, recoverProviderOrderId, timeAgoRu, usd, type NoteDescription } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { formatInt } from '@/lib/order-calc'
import { formatOrderDate, truncateUrl } from '@/lib/order-view'
import { PAYMENT_STATUS, describePaymentIssue, shortId } from '@/lib/payment-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getReconCases, resolveCaseManual, resolveCaseRefund, retryCase } from '@/services/api/admin'
import { caseSeverity, type Severity } from '../../../supabase/functions/_shared/recon-severity.ts'
import type { ReconCase } from '@/types/admin'

interface Props {
  session: AuthSession
  onProblemCount: (n: number) => void
  /** Provider payment cases are decided in Admin -> Treasury (complete / mark failed). */
  onOpenPayments?: () => void
}

const SEVERITY: Record<Severity, { label: string; badge: string; border: string }> = {
  critical: { label: 'Критично', badge: 'bg-rose-600 text-white', border: 'border-rose-300' },
  high: { label: 'Важно', badge: 'bg-amber-500 text-white', border: 'border-amber-300' },
  normal: { label: 'Обычно', badge: 'bg-slate-200 text-slate-700', border: 'border-amber-200' },
}
const RANK: Record<Severity, number> = { critical: 0, high: 1, normal: 2 }

export function ReconciliationTab({ session, onProblemCount, onOpenPayments }: Props) {
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
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Не удалось загрузить кейсы.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
      </Card>
    )
  }

  const now = Date.now()
  const sorted = [...data]
    .map((c) => ({ c, severity: caseSeverity({ reason: c.reason, createdAt: c.createdAt, amount: c.order?.chargeAmount ?? c.payment?.amount ?? null }, now) }))
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
          <p className="text-base font-bold text-content-primary">Всё в порядке</p>
          <p className="mx-auto max-w-[250px] text-sm text-content-secondary">
            Ничего не ждёт вашего решения. Зависшие заказы появляются здесь через 10 минут, застрявшие платежи провайдерам — через 5 минут.
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
            onOpenPayments={onOpenPayments}
          />
        ))
      )}
    </div>
  )
}

export function CaseCard({ kase, severity, session, onDone, onFailed, onOpenPayments }: { kase: ReconCase; severity: Severity; session: AuthSession; onDone: (message: string) => void; onFailed: () => void; onOpenPayments?: () => void }) {
  const order = kase.order
  const payment = kase.payment
  const note: NoteDescription = payment ? { ...describePaymentIssue(kase.reason), refundOwed: false } : describeNote(order?.errorMessage ?? kase.reason)
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
      setError(e instanceof Error ? e.message : 'Действие не удалось.')
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
            <span className="text-[11px] font-semibold text-content-muted">возраст: {timeAgoRu(kase.createdAt).replace(/ назад$/, '')}</span>
          </div>
          <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-content-primary">
            {order?.serviceName ?? (payment ? `Пополнение провайдера ${payment.providerName}` : `${kase.entityType} ${kase.entityId}`)}
          </h3>
          {order && (
            <p className="mt-0.5 text-xs text-content-secondary">
              @{order.username ?? order.telegramId} · {formatOrderDate(order.createdAt)}
            </p>
          )}
          {payment && (
            <p className="mt-0.5 text-xs text-content-secondary">
              {payment.asset} · {payment.network} · создан {formatOrderDate(payment.createdAt)}
            </p>
          )}
        </div>
        {order && <StatusBadge status={order.status} />}
        {payment && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-800">
            {PAYMENT_STATUS[payment.status]?.label ?? payment.status}
          </span>
        )}
      </div>

      {payment && (
        <dl className="mt-2 space-y-1 rounded-2xl bg-surface-sub px-3 py-2 text-xs">
          <div className="flex justify-between gap-2"><dt className="text-content-secondary">Кому</dt><dd><code className="font-mono" title={payment.destinationWallet}>{shortId(payment.destinationWallet)}</code></dd></div>
          <div className="flex justify-between gap-2"><dt className="text-content-secondary">Транзакция</dt><dd>{payment.txHash ? <code className="font-mono" title={payment.txHash}>{shortId(payment.txHash)}</code> : 'не записана'}</dd></div>
        </dl>
      )}

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
          <span>Кол-во <b className="text-content-primary">{formatInt(order.quantity)}</b></span>
          <span className="text-lg font-extrabold text-content-primary">{usd(order.chargeAmount)}</span>
        </div>
      )}
      {payment && (
        <div className="mt-3 flex items-end justify-between text-xs font-medium text-content-secondary">
          <span>Оплачено из казны</span>
          <span className="text-lg font-extrabold text-content-primary">{usd(payment.amount)}</span>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>
      )}

      {resolving ? (
        <div className="mt-3 space-y-2 rounded-2xl border border-blue-100/70 bg-surface-sub p-3">
          {needsProviderId && (
            <label className="block text-xs font-bold text-content-primary">
              Номер заказа у провайдера
              <input
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="например 90210"
                className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand"
              />
            </label>
          )}
          <label className="block text-xs font-bold text-content-primary">
            Заметка {needsProviderId ? '(необязательно)' : '(обязательно)'}
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={needsProviderId ? 'Проверено в панели провайдера' : 'Решено вне приложения'}
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
                  needsProviderId ? 'Кейс закрыт. Воркер синхронизации будет отслеживать заказ.' : 'Кейс отмечен как решённый.',
                )
              }
            >
              Подтвердить
            </Button>
            <button type="button" onClick={() => setResolving(false)} className="h-11 flex-1 rounded-2xl bg-white text-sm font-semibold text-content-secondary active:scale-95">
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className={cn('mt-3 grid gap-2', order?.canRetry ? 'grid-cols-3' : 'grid-cols-2')}>
          {order && (
            <button
              type="button"
              disabled={busy}
              onClick={confirm === 'refund' ? () => void run(() => resolveCaseRefund(session, kase.id, text || undefined), 'Деньги за заказ возвращены клиенту.') : () => ask('refund')}
              className={cn(
                'min-h-11 rounded-2xl px-1 text-[13px] font-bold leading-tight transition-all active:scale-95 disabled:opacity-50',
                confirm === 'refund' ? 'bg-rose-600 text-white' : 'border border-rose-200 bg-white text-rose-600',
              )}
            >
              {confirm === 'refund' ? `Подтвердить ${usd(order.chargeAmount)}` : 'Вернуть деньги'}
            </button>
          )}
          {order?.canRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={confirm === 'retry' ? () => void run(() => retryCase(session, kase.id), 'Заказ отправлен провайдеру повторно.') : () => ask('retry')}
              className={cn(
                'flex min-h-11 items-center justify-center gap-1 rounded-2xl px-1 text-[13px] font-bold leading-tight transition-all active:scale-95 disabled:opacity-50',
                confirm === 'retry' ? 'bg-amber-500 text-white' : 'border border-amber-300 bg-white text-amber-700',
              )}
            >
              <RotateCw size={14} strokeWidth={2} className={cn(busy && 'animate-spin')} /> {confirm === 'retry' ? 'Подтвердить' : 'Повторить'}
            </button>
          )}
          {payment && onOpenPayments && (
            <button
              type="button"
              onClick={() => { haptic.tap(); onOpenPayments() }}
              className="flex min-h-11 items-center justify-center gap-1 rounded-2xl bg-brand px-1 text-[13px] font-bold leading-tight text-white transition-all active:scale-95"
            >
              <Landmark size={15} strokeWidth={1.75} /> Открыть платёж
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => { haptic.tap(); setResolving(true); setConfirm(null) }}
            className="flex min-h-11 items-center justify-center gap-1 rounded-2xl bg-brand-light px-1 text-[13px] font-bold leading-tight text-brand-text transition-all active:scale-95 disabled:opacity-50"
          >
            <ShieldCheck size={15} strokeWidth={1.75} /> Решено
          </button>
        </div>
      )}
      {confirm === 'refund' && isProcessing && !note.refundOwed && (
        <p className="mt-2 text-[12px] font-medium text-rose-600">
          Если провайдер всё-таки принял этот заказ, он будет выполнен, а возврат клиенту обойдётся вам в сумму провайдера.
        </p>
      )}
      {confirm === 'retry' && (
        <p className="mt-2 text-[12px] font-medium text-amber-700">
          Сначала проверьте панель провайдера. Если он уже создал этот заказ, повтор выполнит его дважды. Повтор уходит тому же провайдеру, за которого списали деньги с клиента.
        </p>
      )}
      {payment && !resolving && (
        <p className="mt-2 text-[12px] font-medium text-content-secondary">
          Решите судьбу платежа в разделе «Финансы» → «Платежи провайдерам»: продвиньте его, когда сеть и панель провайдера сходятся, или отметьте неудачным, если перевод так и не пришёл. Кейс закроется сам.
        </p>
      )}
    </article>
  )
}
