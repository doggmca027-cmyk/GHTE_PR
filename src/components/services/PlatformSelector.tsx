import { PLATFORM_TABS } from '@/constants/platforms'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { Platform } from '@/types/catalog'
import { PlatformIcon } from './PlatformIcon'

interface Props {
  value: Platform
  onChange: (platform: Platform) => void
}

export function PlatformSelector({ value, onChange }: Props) {
  return (
    <div role="tablist" aria-label="Platform" className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 py-1">
      {PLATFORM_TABS.map(({ id, label }) => {
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
              'flex shrink-0 items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-semibold transition-all duration-200 active:scale-95',
              active
                ? 'border-brand bg-brand text-white shadow-[0_6px_18px_rgb(0,152,234,0.28)]'
                : 'border-blue-100/70 bg-white text-content-secondary shadow-sm hover:text-content-primary',
            )}
          >
            <PlatformIcon platform={id} size={18} strokeWidth={active ? 2 : 1.75} />
            {label}
          </button>
        )
      })}
    </div>
  )
}
