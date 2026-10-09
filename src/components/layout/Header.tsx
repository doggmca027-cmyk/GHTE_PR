import { LifeBuoy, Plus, Settings, ShieldCheck } from 'lucide-react'
import { useT } from '@/i18n'
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

const iconButton =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-blue-100/70 shadow-sm transition-colors active:scale-95'

export function Header({ balance, currency, onTopUp, onOpenSettings, onOpenSupport, isAdmin = false, onOpenAdmin, active = null }: Props) {
  const t = useT()
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
      <Logo />
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onTopUp}
          aria-label={t('Top up balance')}
          className="flex min-w-0 items-center gap-1.5 rounded-full border border-blue-100/70 bg-white py-1 pl-3 pr-1 shadow-sm"
        >
          <span className="truncate text-[13px] font-bold text-content-primary">{formatMoney(balance, currency)}</span>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white">
            <Plus size={16} strokeWidth={2} />
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenSupport}
          aria-label={t('Support')}
          aria-pressed={active === 'support'}
          className={cn(iconButton, active === 'support' ? 'bg-brand text-white' : 'bg-white text-content-secondary')}
        >
          <LifeBuoy size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t('Settings')}
          aria-pressed={active === 'settings'}
          className={cn(iconButton, active === 'settings' ? 'bg-brand text-white' : 'bg-white text-content-secondary')}
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={onOpenAdmin}
            aria-label={t('Admin')}
            aria-pressed={active === 'admin'}
            className={cn(iconButton, active === 'admin' ? 'bg-brand text-white' : 'bg-white text-brand')}
          >
            <ShieldCheck size={18} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  )
}
