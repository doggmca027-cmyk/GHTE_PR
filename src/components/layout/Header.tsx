import { LifeBuoy, Moon, Plus, Settings, ShieldCheck, Sun } from 'lucide-react'
import { useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { setThemePreference, useScheme } from '@/lib/theme'
import { cn, formatMoney } from '@/lib/utils'
import { Logo } from './Logo'

interface Props {
  balance: number
  currency: string
  onTopUp?: () => void
  onOpenSettings?: () => void
  onOpenSupport?: () => void
  /** Shows the admin button. Cosmetic only: every admin call is re-checked on the server. */
  isAdmin?: boolean
  onOpenAdmin?: () => void
  /** Which header screen is open, to highlight its button. */
  active?: 'settings' | 'support' | 'admin' | null
}

// a little smaller on narrow phones (360-399 px), so the balance always fits next to the logo
const iconButton =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-blue-100/70 shadow-sm transition-colors active:scale-95 min-[400px]:h-9 min-[400px]:w-9'

export function Header({ balance, currency, onTopUp, onOpenSettings, onOpenSupport, isAdmin = false, onOpenAdmin, active = null }: Props) {
  const t = useT()
  const scheme = useScheme()
  const dark = scheme === 'dark'
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] min-[400px]:px-5">
      {/* the logo gives way first (it may be clipped); the balance never collapses into "$..." */}
      <div className="min-w-0 overflow-hidden">
        <Logo />
      </div>
      <div className="flex shrink-0 items-center gap-1 min-[400px]:gap-1.5">
        <button
          type="button"
          onClick={onTopUp}
          aria-label={t('Top up balance')}
          className="flex shrink-0 items-center gap-1 rounded-full border border-blue-100/70 bg-surface py-1 pl-2.5 pr-1 shadow-sm min-[400px]:gap-1.5 min-[400px]:pl-3"
        >
          <span className="whitespace-nowrap text-[13px] font-bold tabular-nums text-content-primary">{formatMoney(balance, currency)}</span>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-white min-[400px]:h-7 min-[400px]:w-7">
            <Plus size={16} strokeWidth={2} />
          </span>
        </button>
        <button
          type="button"
          onClick={() => { haptic.select(); setThemePreference(dark ? 'light' : 'dark') }}
          aria-label={dark ? t('Switch to light theme') : t('Switch to dark theme')}
          className={cn(iconButton, 'bg-surface text-content-secondary')}
        >
          {dark ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          onClick={onOpenSupport}
          aria-label={t('Support')}
          aria-pressed={active === 'support'}
          className={cn(iconButton, active === 'support' ? 'bg-brand text-white' : 'bg-surface text-content-secondary')}
        >
          <LifeBuoy size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t('Settings')}
          aria-pressed={active === 'settings'}
          className={cn(iconButton, active === 'settings' ? 'bg-brand text-white' : 'bg-surface text-content-secondary')}
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={onOpenAdmin}
            aria-label={t('Admin')}
            aria-pressed={active === 'admin'}
            className={cn(iconButton, active === 'admin' ? 'bg-brand text-white' : 'bg-surface text-brand')}
          >
            <ShieldCheck size={18} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  )
}
