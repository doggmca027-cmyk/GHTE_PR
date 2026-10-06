import type { ReactNode } from 'react'
import { Header } from './Header'
import { BottomNav } from '@/components/navigation/BottomNav'
import { ADMIN_NAV_ITEM, NAV_ITEMS, type TabId } from '@/constants/navigation'

interface Props {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  userName: string
  balance: number
  currency: string
  onTopUp?: () => void
  /** Shows the Admin tab. Cosmetic: the server decides what an admin may actually do. */
  isAdmin?: boolean
  children: ReactNode
}

export function Layout({ activeTab, onTabChange, userName, balance, currency, onTopUp, isAdmin = false, children }: Props) {
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 sm:p-6">
      <div className="relative mx-auto flex h-[100dvh] w-full max-w-[430px] flex-col overflow-hidden bg-gradient-to-b from-[#EBF3FE] to-[#F8FAFC] sm:h-[860px] sm:max-h-[calc(100dvh-3rem)] sm:rounded-[40px] sm:shadow-2xl">
        <Header name={userName} balance={balance} currency={currency} onTopUp={onTopUp} />
        <main className="flex-1 overflow-y-auto px-5 pb-4">{children}</main>
        <BottomNav active={activeTab} onChange={onTabChange} items={isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS} />
      </div>
    </div>
  )
}
