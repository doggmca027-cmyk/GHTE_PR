import { cn } from '@/lib/utils'

export type MetricTone = 'default' | 'success' | 'danger' | 'warning'

const TONES: Record<MetricTone, string> = {
  default: 'text-content-primary',
  success: 'text-emerald-600',
  danger: 'text-rose-600',
  warning: 'text-amber-600',
}

interface Props {
  label: string
  value: string
  hint?: string
  tone?: MetricTone
  onClick?: () => void
}

export function MetricCard({ label, value, hint, tone = 'default', onClick }: Props) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'rounded-3xl border border-blue-100/70 bg-white p-4 text-left shadow-card',
        onClick && 'transition-transform active:scale-[0.98]',
        tone === 'warning' && 'border-amber-200 bg-amber-50/40',
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-content-muted">{label}</p>
      <p className={cn('mt-1 text-2xl font-extrabold leading-tight tracking-tight', TONES[tone])}>{value}</p>
      {hint && <p className="mt-0.5 text-xs font-medium text-content-secondary">{hint}</p>}
    </Tag>
  )
}
