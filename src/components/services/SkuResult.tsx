import { AlertCircle, Hash, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useT } from '@/i18n'
import type { SkuLookup } from '@/hooks/useSkuLookup'
import type { ICatalogService } from '@/types/catalog'
import { ServiceCard } from './ServiceCard'

interface Props {
  sku: string
  lookup: SkuLookup & { retry: () => void }
  /** The card was tapped: the order form opens on it (with the platform it is on, which can be another than the one the screen shows). */
  onSelect: (service: ICatalogService, platform: { slug: string; name: string }) => void
}

/**
 * What an article number typed or pasted into a search box finds: the one card that carries it, from anywhere in the catalogue, or a sentence that
 * there is none. It replaces the list under the box while the box holds an article.
 */
export function SkuResult({ sku, lookup, onSelect }: Props) {
  const t = useT()
  return (
    <div className="mt-1 space-y-3" data-testid="sku-result">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-content-muted">
        <Hash size={13} strokeWidth={2} aria-hidden="true" /> {t('Article number {sku}', { sku })}
      </p>

      {(lookup.status === 'idle' || lookup.status === 'loading') && (
        <div className="h-[132px] animate-pulse rounded-3xl border border-blue-100/70 bg-surface/80" aria-busy="true" />
      )}

      {lookup.status === 'found' && (
        <ServiceCard
          service={lookup.hit.service}
          platform={lookup.hit.platform.slug}
          platformName={lookup.hit.platform.name}
          onSelect={(service) => onSelect(service, lookup.hit.platform)}
        />
      )}

      {lookup.status === 'missing' && (
        <Card className="space-y-2 py-10 text-center">
          <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
          <p className="text-sm font-semibold text-content-primary">{t('No service with this article number')}</p>
          <p className="text-xs text-content-secondary">{t('Check the number or ask the AI assistant.')}</p>
        </Card>
      )}

      {lookup.status === 'error' && (
        <Card className="space-y-3 text-center">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{t("Couldn't load services. Check your connection and retry.")}</p>
          <Button className="w-full" onClick={lookup.retry}>{t('Retry')}</Button>
        </Card>
      )}
    </div>
  )
}
