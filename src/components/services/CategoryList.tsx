import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { ICategory } from '@/types/catalog'

export const ALL_CATEGORIES = 'all'

interface Props {
  categories: ICategory[]
  /** Category id, or ALL_CATEGORIES. */
  value: string
  onChange: (categoryId: string) => void
}

export function CategoryList({ categories, value, onChange }: Props) {
  if (categories.length === 0) return null
  const options = [{ id: ALL_CATEGORIES, name: 'All' }, ...categories]

  return (
    <div role="tablist" aria-label="Category" className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5 py-1">
      {options.map(({ id, name }) => {
        const active = id === value
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => {
              if (!active) haptic.select()
              onChange(id)
            }}
            className={cn(
              'shrink-0 rounded-2xl px-3.5 py-2 text-[13px] font-semibold transition-colors duration-200 active:scale-95',
              active ? 'bg-brand-light text-brand-text' : 'bg-white/70 text-content-secondary hover:bg-white',
            )}
          >
            {name}
          </button>
        )
      })}
    </div>
  )
}
