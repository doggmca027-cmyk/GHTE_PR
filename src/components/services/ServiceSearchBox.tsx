import { Search, X } from 'lucide-react'
import { useT } from '@/i18n'

interface Props {
  value: string
  onChange: (value: string) => void
}

/** The search field of a platform's or a category's services. It stays at the top while the list scrolls under it. */
export function ServiceSearchBox({ value, onChange }: Props) {
  const t = useT()
  return (
    <div data-testid="service-search" className="sticky top-0 z-10 -mx-5 bg-screen px-5 pb-2 pt-1">
      <label className="relative block">
        <span className="sr-only">{t('Search services')}</span>
        <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-content-muted" />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('Search services')}
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={80}
          className="h-12 w-full rounded-2xl border border-blue-100/70 bg-surface pe-11 ps-10 text-[16px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-brand [&::-webkit-search-cancel-button]:hidden"
        />
        {value !== '' && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={t('Clear search')}
            className="absolute end-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-content-muted active:scale-90"
          >
            <X size={16} strokeWidth={2} />
          </button>
        )}
      </label>
    </div>
  )
}
