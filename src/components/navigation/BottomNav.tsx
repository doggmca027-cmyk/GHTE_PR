import { NAV_ITEMS, type NavItem, type TabId } from '@/constants/navigation'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'

interface Props {
  active: TabId
  onChange: (tab: TabId) => void
  items?: NavItem[]
}

export function BottomNav({ active, onChange, items = NAV_ITEMS }: Props) {
  const t = useT()
  return (
    <nav className="shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <ul className="card m-0 flex list-none items-center justify-between rounded-[28px] p-1.5">
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = id === active
          return (
            <li key={id} className="flex-1">
              <button
                type="button"
                onClick={() => onChange(id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex w-full flex-col items-center gap-0.5 rounded-3xl py-2 text-[11px] font-semibold transition-colors',
                  isActive ? 'bg-brand-light text-brand' : 'text-content-muted hover:text-content-secondary',
                )}
              >
                <Icon size={22} strokeWidth={isActive ? 2 : 1.75} />
                {t(label)}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
