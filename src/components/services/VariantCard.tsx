import { useState } from 'react'
import { tr, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { formatMoneyAmount } from '@/lib/order-calc'
import { cn } from '@/lib/utils'
import type { ICatalogService, Platform } from '@/types/catalog'
import { ServiceCard } from './ServiceCard'

const ECONOMY = tr('Economy')
const STANDARD = tr('Standard')
const PREMIUM = tr('Premium')

/** Switch labels, cheapest first: Economy, Standard (numbered when there are several), Premium. [key, number or null]. */
export function variantLabels(total: number): [string, number | null][] {
  if (total <= 1) return [[ECONOMY, null]]
  if (total === 2) return [[ECONOMY, null], [PREMIUM, null]]
  const middle = total - 2
  return [[ECONOMY, null], ...Array.from({ length: middle }, (_, i): [string, number | null] => [STANDARD, middle === 1 ? null : i + 1]), [PREMIUM, null]]
}

interface Props {
  service: ICatalogService
  platform: Platform
  platformName?: string
  onSelect: (service: ICatalogService) => void
}

/** One card for a group of variants: the chosen variant's card, and a switch per variant with its price. */
export function VariantCard({ service, platform, platformName, onSelect }: Props) {
  const t = useT()
  const all = [service, ...(service.variants ?? [])]
  const [index, setIndex] = useState(0)
  const labels = variantLabels(all.length)
  const shown = all[Math.min(index, all.length - 1)]

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
            <span className="text-[12px] font-bold leading-tight">{t(labels[i][0])}{labels[i][1] !== null ? ` ${labels[i][1]}` : ''}</span>
            <span className={cn('text-[11px] font-semibold leading-tight', i === index ? 'text-white/85' : 'text-content-muted')}>
              {formatMoneyAmount(v.ratePer1000)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
