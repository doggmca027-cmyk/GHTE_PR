import type { ReactNode } from 'react'
import { Header } from './Header'
import { BottomNav } from '@/components/navigation/BottomNav'
import { NAV_ITEMS, type TabId } from '@/constants/navigation'
import { useWide } from '@/lib/layout-mode'
import { WebLayout } from './WebLayout'

interface Props {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  balance: number
  currency: string
  onTopUp?: () => void
  /** Shows the Admin button in the header. Cosmetic: the server decides what an admin may actually do. */
  isAdmin?: boolean
  /** A website guest: the header offers to sign in instead of the balance. */
  guest?: boolean
  onSignIn?: () => void
  children: ReactNode
}

export function Layout(props: Props) {
  // the website (a browser, not Telegram) has its own full-width frame; the Mini App keeps the phone screen below, untouched
  const wide = useWide()
  return wide ? <WebLayout {...props} /> : <AppLayout {...props} />
}

function AppLayout({ activeTab, onTabChange, balance, currency, onTopUp, isAdmin = false, guest = false, onSignIn, children }: Props) {
  return (
    <div className="flex min-h-full items-center justify-center bg-backdrop sm:p-6">
      <div className="relative mx-auto flex h-[100dvh] w-full max-w-[430px] flex-col overflow-hidden bg-gradient-to-b from-screen to-screen-end sm:h-[860px] sm:max-h-[calc(100dvh-3rem)] sm:rounded-[40px] sm:shadow-2xl">
        <Header
          balance={balance}
          currency={currency}
          onTopUp={onTopUp}
          onOpenSettings={() => onTabChange('settings')}
          onOpenSupport={() => onTabChange('support')}
          isAdmin={isAdmin}
          guest={guest}
          onSignIn={onSignIn}
          onOpenAdmin={() => onTabChange('admin')}
          active={activeTab === 'settings' || activeTab === 'support' || activeTab === 'admin' ? activeTab : null}
        />
        <main className="flex-1 overflow-y-auto px-5 pb-4">{children}</main>
        <BottomNav active={activeTab} onChange={onTabChange} items={NAV_ITEMS} />
      </div>
    </div>
  )
}
