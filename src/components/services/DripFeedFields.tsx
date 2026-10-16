import { Timer } from 'lucide-react'
import { useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { MAX_DRIP_INTERVAL_MINUTES, MAX_DRIP_RUNS, type DripSchedule } from '@/lib/drip-feed'
import { formatInt } from '@/lib/order-calc'
import { cn } from '@/lib/utils'

interface Props {
  enabled: boolean
  onToggle: (on: boolean) => void
  runs: string
  onRuns: (v: string) => void
  interval: string
  onInterval: (v: string) => void
  schedule: DripSchedule
  /** The validated quantity of one delivery, or null. */
  perRun: number | null
  disabled: boolean
}

const fieldClass = (invalid: boolean) =>
  cn(
    'w-full rounded-2xl border bg-surface-sub px-4 py-3 text-[15px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:bg-surface disabled:opacity-60',
    invalid ? 'border-rose-300 focus:border-rose-400' : 'border-blue-100/70 focus:border-brand',
  )

const digits = (v: string) => v.replace(/[^\d]/g, '').slice(0, 7)

/**
 * Drip-feed in the order form: a switch, and when it is on, the number of deliveries, the minutes between two and the resulting total
 * (the quantity field above then holds ONE delivery). Shown only for a service that can be delivered this way.
 */
export function DripFeedFields({ enabled, onToggle, runs, onRuns, interval, onInterval, schedule, perRun, disabled }: Props) {
  const t = useT()
  const runsBad = runs !== '' && !schedule.ok && schedule.field === 'runs'
  const intervalBad = interval !== '' && !schedule.ok && schedule.field === 'interval'
  const total = enabled && perRun !== null && schedule.ok ? perRun * schedule.runs : null

  return (
    <section className="mt-4 rounded-2xl border border-blue-100/70 bg-surface-sub p-3.5" data-testid="drip-feed">
      <div className="flex items-center gap-3">
        <Timer size={18} strokeWidth={1.75} className="shrink-0 text-brand" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-content-primary">{t('Drip-feed (gradual delivery)')}</p>
          <p className="text-xs font-medium text-content-secondary">{t('Deliver the order in parts over time instead of all at once.')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('Drip-feed (gradual delivery)')}
          disabled={disabled}
          onClick={() => { haptic.select(); onToggle(!enabled) }}
          className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', enabled ? 'bg-brand' : 'bg-slate-300')}
        >
          <span className={cn('absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-surface shadow transition-transform', enabled && 'translate-x-5')} />
        </button>
      </div>

      {enabled && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-xs font-bold text-content-primary">{t('Runs')}</span>
              <input
                type="text"
                inputMode="numeric"
                value={runs}
                disabled={disabled}
                onChange={(e) => onRuns(digits(e.target.value))}
                aria-invalid={runsBad}
                className={fieldClass(runsBad)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-bold text-content-primary">{t('Interval (minutes)')}</span>
              <input
                type="text"
                inputMode="numeric"
                value={interval}
                disabled={disabled}
                onChange={(e) => onInterval(digits(e.target.value))}
                aria-invalid={intervalBad}
                className={fieldClass(intervalBad)}
              />
            </label>
          </div>
          {runsBad && <p className="mt-1.5 text-xs font-medium text-rose-500">{t('Enter from 2 to {max} runs', { max: formatInt(MAX_DRIP_RUNS) })}</p>}
          {intervalBad && <p className="mt-1.5 text-xs font-medium text-rose-500">{t('Enter from 1 to {max} minutes', { max: formatInt(MAX_DRIP_INTERVAL_MINUTES) })}</p>}
          <div className="mt-3 flex items-baseline justify-between border-t border-blue-100/70 pt-2.5 text-sm" data-testid="drip-total">
            <span className="font-medium text-content-secondary">{t('Total quantity')}</span>
            <span className="font-extrabold text-content-primary">
              {total !== null ? `${formatInt(perRun!)} × ${formatInt(schedule.ok ? schedule.runs : 0)} = ${formatInt(total)}` : '—'}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
