import { useState } from 'react'
import { Check, Copy, LifeBuoy } from 'lucide-react'
import { PlatformIcon } from '@/components/services/PlatformIcon'
import { useT } from '@/i18n'
import { copyText } from '@/lib/clipboard'
import { haptic } from '@/lib/haptics'
import { formatInt, formatUnits, toUnits } from '@/lib/order-calc'
import { deliveredRatio, formatOrderDate, isActiveStatus, truncateUrl } from '@/lib/order-view'
import type { IOrderView } from '@/types/orders'
import { StatusBadge } from './StatusBadge'

export function OrderCard({ order, onReportIssue }: { order: IOrderView; onReportIssue?: (order: IOrderView) => void }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const ratio = deliveredRatio(order.quantity, order.remains)
  const showProgress = ratio !== null && isActiveStatus(order.status)

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
    <article className="rounded-3xl border border-blue-100/70 bg-white p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand">
          <PlatformIcon platform={order.platform} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-content-primary">{order.serviceName}</h3>
            <StatusBadge status={order.status} />
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-content-secondary shadow-sm active:scale-90"
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
