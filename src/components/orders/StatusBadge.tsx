import { statusMeta, type StatusTone } from '@/lib/order-view'
import { cn } from '@/lib/utils'
import type { OrderStatus } from '@/types'

const TONES: Record<StatusTone, { pill: string; dot: string }> = {
  success: { pill: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  brand: { pill: 'bg-brand-light text-brand-text', dot: 'bg-brand' },
  warning: { pill: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  neutral: { pill: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  danger: { pill: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = statusMeta(status)
  const tone = TONES[meta.tone]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', tone.pill)}>
      <span className="relative flex h-2 w-2">
        {meta.pulse && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', tone.dot)} />}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', tone.dot)} />
      </span>
      {meta.label}
    </span>
  )
}
