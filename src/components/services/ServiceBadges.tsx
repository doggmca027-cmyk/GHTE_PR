import { Globe, Layers, RefreshCw, ShieldOff } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { currentLocale, useT } from '@/i18n'
import { serviceCountries } from '@/lib/service-view'
import { shortDays } from '@/lib/variants'
import type { ICatalogService } from '@/types/catalog'

/**
 * What a service really offers, as small badges: its guarantee ("Recovery: 30 days" / "No refill"), its countries and gradual delivery
 * (Drip-feed). Only what the service states is shown; nothing at all when it states none of it.
 */
export function ServiceBadges({ service }: { service: ICatalogService }) {
  const t = useT()
  const locale = currentLocale()
  const refill = service.attributes?.refill
  const country = serviceCountries(service.attributes, locale)
  const badges: React.ReactNode[] = []
  if (typeof refill === 'number') badges.push(<Badge key="refill"><RefreshCw size={12} strokeWidth={2} /> {t('Recovery: {time}', { time: shortDays(refill, locale) })}</Badge>)
  else if (refill === 'lifetime') badges.push(<Badge key="refill"><RefreshCw size={12} strokeWidth={2} /> {t('Recovery: {time}', { time: t('lifetime') })}</Badge>)
  else if (refill === 'none') badges.push(<Badge key="refill"><ShieldOff size={12} strokeWidth={2} /> {t('No refill')}</Badge>)
  else if (service.refillSupported) badges.push(<Badge key="refill"><RefreshCw size={12} strokeWidth={2} /> {t('Refill')}</Badge>)
  if (country !== '') badges.push(<Badge key="geo"><Globe size={12} strokeWidth={2} /> {country}</Badge>)
  if (service.dripfeedAvailable) badges.push(<Badge key="drip"><Layers size={12} strokeWidth={2} /> Drip-feed</Badge>)
  if (badges.length === 0) return null
  return <div className="mt-2 flex flex-wrap gap-1.5" data-testid="service-badges">{badges}</div>
}
