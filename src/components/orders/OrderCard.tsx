import { useState } from 'react'
import { Check, Copy, LifeBuoy, Loader2, RefreshCcw } from 'lucide-react'
import { PlatformIcon } from '@/components/services/PlatformIcon'
import { tr, useT } from '@/i18n'
import { copyText } from '@/lib/clipboard'
import { haptic } from '@/lib/haptics'
import { formatInt, formatUnits, toUnits } from '@/lib/order-calc'
import { deliveredRatio, formatOrderDate, isActiveStatus, refillView, truncateUrl } from '@/lib/order-view'
import type { IOrderView } from '@/types/orders'
import { StatusBadge } from './StatusBadge'

/** The customer's words for each refusal of request-refill. */
const REFILL_ERROR: Record<string, string> = {
  refill_too_early: tr('A refill can be requested 24 hours after the order.'),
  refill_cooldown: tr('A refill was requested recently. Try again tomorrow.'),
  refill_expired: tr('The refill guarantee of this order is over.'),
  refill_refused: tr('The provider could not start a refill now. Try again later.'),
  other: tr('Could not request a refill. Try again later.'),
}

export function OrderCard({ order, onReportIssue, onRefill }: {
  order: IOrderView
  onReportIssue?: (order: IOrderView) => void
  /** Asks the provider to refill this order; rejects with { code } on a refusal. */
  onRefill?: (order: IOrderView) => Promise<void>
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const ratio = deliveredRatio(order.quantity, order.remains)
  const showProgress = ratio !== null && isActiveStatus(order.status)
  const refill = onRefill ? refillView(order) : null
  const [refillBusy, setRefillBusy] = useState(false)
  const [refillError, setRefillError] = useState<string | null>(null)

  async function handleRefill() {
    if (!onRefill) return
    haptic.tap()
    setRefillBusy(true)
    setRefillError(null)
    try {
      await onRefill(order)
      haptic.success()
    } catch (e) {
      haptic.error()
      const code = (e as { code?: string } | null)?.code
      setRefillError(t(REFILL_ERROR[code && REFILL_ERROR[code] ? code : 'other']))
    } finally {
      setRefillBusy(false)
    }
  }

  async function handleCopy() {
    if (await copyText(order.targetUrl)) {
      haptic.success()
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      haptic.error()
    }
  }

  return (
    <article className="rounded-3xl border border-blue-100/70 bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand">
          <PlatformIcon platform={order.platform} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-content-primary">{order.serviceName}</h3>
            <StatusBadge status={order.status} waiting={order.awaitingFunds} />
          </div>
          <p className="mt-0.5 text-xs text-content-muted">{formatOrderDate(order.createdAt)}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-surface-sub px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-content-secondary" title={order.targetUrl}>
          {truncateUrl(order.targetUrl)}
        </p>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? t('Link copied') : t('Copy link')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary shadow-sm active:scale-90"
        >
          {copied ? <Check size={14} strokeWidth={2} className="text-emerald-500" /> : <Copy size={14} strokeWidth={1.75} />}
        </button>
      </div>

      {showProgress && order.remains !== null && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs font-medium text-content-secondary">
            <span>{t('Remaining')}</span>
            <span>{formatInt(order.remains)} / {formatInt(order.quantity)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-blue-100/70" role="progressbar" aria-valuenow={Math.round((ratio ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${(ratio ?? 0) * 100}%` }} />
          </div>
        </div>
      )}

      {order.refundedAmount > 0 && (
        <p className="mt-3 rounded-2xl bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">
          {order.status === 'partial' && order.remains !== null
            ? t('Partially completed: {n} undelivered. {amount} refunded to your balance.', { n: formatInt(order.remains), amount: formatUnits(toUnits(order.refundedAmount)) })
            : t('{amount} refunded to your balance.', { amount: formatUnits(toUnits(order.refundedAmount)) })}
        </p>
      )}

      {refill && (
        <div className="mt-3">
          {refill.kind === 'pending' ? (
            <p className="flex items-center gap-1.5 rounded-2xl bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">
              <RefreshCcw size={14} strokeWidth={1.75} /> {refill.status === 'in_progress' ? t('Refill is in progress') : t('Refill requested')}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void handleRefill()}
              disabled={refill.kind === 'wait' || refillBusy}
              className="flex h-9 items-center gap-1.5 rounded-full bg-brand-light px-3.5 text-[13px] font-semibold text-brand-text active:scale-95 disabled:opacity-50"
            >
              {refillBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} strokeWidth={1.75} />} {t('Request refill')}
            </button>
          )}
          {refill.kind === 'wait' && <p className="mt-1 text-xs text-content-muted">{t('Available from {date}', { date: formatOrderDate(refill.until) })}</p>}
          {refillError && <p role="alert" className="mt-1 text-xs font-medium text-amber-700">{refillError}</p>}
        </div>
      )}

      {onReportIssue && (
        <button
          type="button"
          onClick={() => onReportIssue(order)}
          className="mt-3 flex h-9 items-center gap-1.5 rounded-full bg-surface-sub px-3.5 text-[13px] font-semibold text-content-secondary active:scale-95"
        >
          <LifeBuoy size={14} strokeWidth={1.75} /> {t('Report an issue')}
        </button>
      )}

      <div className="mt-3 flex items-end justify-between border-t border-blue-100/60 pt-3">
        <p className="text-xs font-medium text-content-secondary">{t('Qty')} <span className="font-bold text-content-primary">{formatInt(order.quantity)}</span></p>
        <p className="text-lg font-extrabold leading-none text-content-primary">{formatUnits(toUnits(order.chargeAmount))}</p>
      </div>
    </article>
  )
}
