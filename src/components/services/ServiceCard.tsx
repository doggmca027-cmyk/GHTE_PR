import { memo } from 'react'
import { useLanguage, useT } from '@/i18n'
import { localizedName } from '@/lib/service-view'
import { formatCompact, formatMoneyAmount } from '@/lib/order-calc'
import { ServiceBadges } from './ServiceBadges'
import type { ICatalogService, Platform } from '@/types/catalog'
import { PlatformIcon } from './PlatformIcon'

interface Props {
  service: ICatalogService
  platform: Platform
  platformName?: string
  onSelect: (service: ICatalogService) => void
}

/**
 * One service of a list. Memoised: a category can show dozens, and the screen re-renders on every keystroke of the search and every
 * balance refresh; a card only re-renders when its own service (or the language) changes.
 */
export const ServiceCard = memo(function ServiceCard({ service, platform, platformName, onSelect }: Props) {
  const t = useT()
  const { lang } = useLanguage()

  return (
    <button
      type="button"
      onClick={() => onSelect(service)}
      className="w-full rounded-3xl border border-blue-100/70 bg-surface p-4 text-start shadow-card transition-all duration-200 hover:border-brand/30 active:scale-[0.985]"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand">
          <PlatformIcon platform={platform} name={platformName} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-3 text-[15px] font-bold leading-snug text-content-primary">{localizedName(service.name, service.nameI18n, lang)}</h3>
          {/* what the service really offers (guarantee, countries, drip-feed), not a guessed speed grade */}
          <ServiceBadges service={service} />
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between border-t border-blue-100/60 pt-3">
        <div>
          <p className="text-lg font-extrabold leading-none text-content-primary">
            {formatMoneyAmount(service.ratePer1000)}
            <span className="ms-1 text-xs font-semibold text-content-muted">/ 1,000</span>
          </p>
        </div>
        <p className="text-xs font-medium text-content-secondary">
          {t('Min {min} · Max {max}', { min: formatCompact(service.minQuantity), max: formatCompact(service.maxQuantity) })}
        </p>
      </div>
    </button>
  )
})
