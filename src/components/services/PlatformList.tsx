import { useMemo, useState } from 'react'
import { ChevronRight, Search, SearchX, X } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { haptic } from '@/lib/haptics'
import { useT } from '@/i18n'
import { searchPlatforms } from '@/lib/platform-search'
import { PlatformBadge } from './PlatformIcon'

export interface PlatformEntry {
  slug: string
  name: string
  /** Active services on this platform. */
  count: number
}

interface Props {
  platforms: PlatformEntry[]
  onSelect: (slug: string) => void
}

/** Every platform as a list (not tabs): the colour tile, the name and how many services it has. Tapping one opens its services. */
export function PlatformList({ platforms, onSelect }: Props) {
  const t = useT()
  const [query, setQuery] = useState('')
  // in memory and instant: the list is already on the device, typing never makes a request
  const shown = useMemo(() => searchPlatforms(platforms, query), [platforms, query])

  return (
    <>
      {/* stays at the top of the scrolling screen while the list moves under it; the background matches the screen's, so it looks seamless */}
      <div data-testid="platform-search" className="sticky top-0 z-10 -mx-5 bg-[#EDF4FD] px-5 pb-2 pt-1">
        <label className="relative block">
          <span className="sr-only">{t('Search platforms')}</span>
          <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-content-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search platforms')}
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-12 w-full rounded-2xl border border-blue-100/70 bg-white pe-11 ps-10 text-[16px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-brand [&::-webkit-search-cancel-button]:hidden"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('Clear search')}
              className="absolute end-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-content-muted active:scale-90"
            >
              <X size={16} strokeWidth={2} />
            </button>
          )}
        </label>
      </div>

      {shown.length === 0 ? (
        <Card className="mt-1 space-y-2 py-10 text-center">
          <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
          <p className="text-sm font-semibold text-content-primary">{t('No platforms found')}</p>
          <p className="text-xs text-content-secondary">{t('Try another name.')}</p>
        </Card>
      ) : (
        <ul className="mt-1 space-y-2" aria-label={t('Platforms')}>
          {shown.map((p) => (
            <li key={p.slug}>
              <button
                type="button"
                onClick={() => { haptic.tap(); onSelect(p.slug) }}
                className="flex w-full items-center gap-3 rounded-3xl border border-blue-100/70 bg-white p-3 text-start shadow-sm transition-all duration-200 hover:border-brand/30 active:scale-[0.985]"
              >
                <PlatformBadge slug={p.slug} name={p.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-content-primary">{p.name}</span>
                  <span className="block text-xs font-medium text-content-muted">{p.count > 0 ? t('Services: {n}', { n: p.count }) : t('No services yet')}</span>
                </span>
                <ChevronRight size={18} strokeWidth={1.75} className="shrink-0 text-content-muted rtl:rotate-180" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
