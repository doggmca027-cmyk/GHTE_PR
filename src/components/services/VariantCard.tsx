import { memo, useMemo, useState } from 'react'
import { useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { formatMoneyAmount } from '@/lib/order-calc'
import { cn } from '@/lib/utils'
import { collapseTechnicalDuplicates, variantLabels } from '@/lib/variants'
import type { ICatalogService, Platform } from '@/types/catalog'
import { ServiceCard } from './ServiceCard'

export { variantLabels }

interface Props {
  service: ICatalogService
  platform: Platform
  platformName?: string
  onSelect: (service: ICatalogService) => void
}

/** One card for a group of variants: the chosen variant's card, and a switch per variant with its price. Memoised like ServiceCard. */
export const VariantCard = memo(function VariantCard({ service, platform, platformName, onSelect }: Props) {
  const t = useT()
  // variants that differ only by the panel's server and cost the same are one choice
  const all = useMemo(() => collapseTechnicalDuplicates([service, ...(service.variants ?? [])]), [service])
  const [index, setIndex] = useState(0)
  const labels = variantLabels(all.length)
  const shown = all[Math.min(index, all.length - 1)]

  // every variant was a technical duplicate of one: a plain card, no switch
  if (all.length === 1) return <ServiceCard service={shown} platform={platform} platformName={platformName} onSelect={onSelect} />

  return (
    <div data-testid="variant-card" className="space-y-1.5">
      <ServiceCard service={shown} platform={platform} platformName={platformName} onSelect={onSelect} />
      <div role="radiogroup" aria-label={t('Options')} className="flex gap-1.5 overflow-x-auto px-1 pb-1">
        {all.map((v, i) => (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={i === index}
            onClick={() => { if (i !== index) haptic.select(); setIndex(i) }}
            className={cn(
              'flex shrink-0 flex-col items-start rounded-2xl border px-3 py-1.5 text-start transition-colors active:scale-95',
              i === index ? 'border-brand bg-brand text-white' : 'border-blue-100/70 bg-surface text-content-secondary',
            )}
          >
            <span className="text-[12px] font-bold leading-tight">{t(labels[i])}</span>
            <span className={cn('text-[11px] font-semibold leading-tight', i === index ? 'text-white/85' : 'text-content-muted')}>
              {formatMoneyAmount(v.ratePer1000)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
})
