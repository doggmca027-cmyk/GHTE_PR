import { Droplets, ShieldCheck, Star, type LucideIcon } from 'lucide-react'
import { tr, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { SEGMENT_IDS } from '@/lib/segments'
import { cn } from '@/lib/utils'
import type { Segment } from '@/types/catalog'

/** Label and icon of each segment of the storefront. */
export const SEGMENT_VIEW: Record<Segment, { label: string; icon: LucideIcon }> = {
  premium: { label: tr('Premium'), icon: Star },
  guaranteed: { label: tr('With guarantee'), icon: ShieldCheck },
  safe: { label: tr('Stable growth'), icon: Droplets },
}

interface Props {
  value: Segment | null
  onChange: (segment: Segment | null) => void
}

/** Three chips under the search field: tap one to see only the cards of that kind, tap it again to see all. */
export function SegmentChips({ value, onChange }: Props) {
  const t = useT()
  return (
    <div role="group" aria-label={t('Filter by type')} data-testid="segment-chips" className="mt-2 flex flex-wrap gap-2">
      {SEGMENT_IDS.map((id) => {
        const { label, icon: Icon } = SEGMENT_VIEW[id]
        const on = value === id
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => { haptic.select(); onChange(on ? null : id) }}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors active:scale-95',
              on ? 'border-brand bg-brand text-white' : 'border-blue-100/70 bg-surface text-content-secondary hover:border-brand/40',
            )}
          >
            <Icon size={14} strokeWidth={2} aria-hidden="true" /> {t(label)}
          </button>
        )
      })}
    </div>
  )
}
