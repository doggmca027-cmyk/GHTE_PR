import { ChevronRight } from 'lucide-react'
import { useLanguage, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { localizedName } from '@/lib/service-view'
import type { ICategory } from '@/types/catalog'

interface Props {
  categories: ICategory[]
  onSelect: (categoryId: string) => void
}

/** The categories of a platform as a list (a platform can have dozens): name in the customer's language and how many services it holds. */
export function CategoryRows({ categories, onSelect }: Props) {
  const t = useT()
  const { lang } = useLanguage()
  return (
    <ul className="space-y-2" aria-label={t('Categories')}>
      {categories.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => { haptic.tap(); onSelect(c.id) }}
            className="flex w-full items-center gap-3 rounded-3xl border border-blue-100/70 bg-white px-4 py-3.5 text-start shadow-sm transition-all duration-200 hover:border-brand/30 active:scale-[0.985]"
          >
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 block text-[15px] font-bold leading-snug text-content-primary">{localizedName(c.name, c.nameI18n, lang)}</span>
              {c.count !== undefined && <span className="block text-xs font-medium text-content-muted">{t('Services: {n}', { n: c.count })}</span>}
            </span>
            <ChevronRight size={18} strokeWidth={1.75} className="shrink-0 text-content-muted rtl:rotate-180" />
          </button>
        </li>
      ))}
    </ul>
  )
}
