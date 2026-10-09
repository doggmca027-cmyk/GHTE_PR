import { ArrowDownLeft, ArrowUpRight, Clock, RotateCcw, Sparkles } from 'lucide-react'
import { useT } from '@/i18n'
import { formatUnits, toUnits } from '@/lib/order-calc'
import { formatOrderDate } from '@/lib/order-view'
import { LEDGER_LABELS } from '@/lib/ledger-view'
import { cn } from '@/lib/utils'
import type { LedgerEntry, LedgerType } from '@/types/wallet'

const ICONS: Record<LedgerType, typeof ArrowDownLeft> = {
  deposit: ArrowDownLeft,
  purchase: ArrowUpRight,
  refund: RotateCcw,
  bonus: Sparkles,
  manual_adjustment: Sparkles,
  ad_reward: Sparkles,
}

export function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const t = useT()
  const pending = entry.status === 'pending'
  const credit = entry.amount > 0
  const Icon = pending ? Clock : ICONS[entry.type]
  return (
    <li className="flex items-center gap-3 rounded-3xl border border-blue-100/70 bg-white p-3.5 shadow-sm">
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl',
          pending ? 'bg-amber-50 text-amber-600' : credit ? 'bg-emerald-50 text-emerald-600' : 'bg-brand-light text-brand',
        )}
      >
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold text-content-primary">{t(LEDGER_LABELS[entry.type])}</p>
        <p className="truncate text-xs text-content-secondary">{entry.description ?? ''}</p>
        <p className="text-[11px] text-content-muted">{formatOrderDate(entry.createdAt)}</p>
      </div>
      <div className="text-right">
        <p className={cn('text-[15px] font-extrabold', pending ? 'text-amber-600' : credit ? 'text-emerald-600' : 'text-content-primary')}>
          {credit ? '+' : '−'}{formatUnits(Math.abs(toUnits(entry.amount)))}
        </p>
        <p className="text-[11px] font-medium text-content-muted">
          {pending ? t('Pending') : entry.balanceAfter !== null ? t('Bal {amount}', { amount: formatUnits(toUnits(entry.balanceAfter)) }) : ''}
        </p>
      </div>
    </li>
  )
}
