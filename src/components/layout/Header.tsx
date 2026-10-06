import { Plus, User } from 'lucide-react'
import { formatMoney } from '@/lib/utils'

interface Props {
  name: string
  balance: number
  currency: string
  onTopUp?: () => void
}

export function Header({ name, balance, currency, onTopUp }: Props) {
  return (
    <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-light text-brand">
          <User size={20} strokeWidth={1.75} />
        </div>
        <div className="leading-tight">
          <p className="text-xs text-content-secondary">Welcome back</p>
          <p className="text-sm font-bold text-content-primary">{name}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onTopUp}
        aria-label="Top up balance"
        className="flex items-center gap-2 rounded-full border border-blue-100/70 bg-white py-1.5 pl-4 pr-1.5 shadow-sm"
      >
        <span className="text-sm font-bold text-content-primary">{formatMoney(balance, currency)}</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-white">
          <Plus size={16} strokeWidth={2} />
        </span>
      </button>
    </header>
  )
}
