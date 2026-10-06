import { Suspense, lazy, useCallback, useState } from 'react'
import { AlertCircle, Loader2, Sparkles } from 'lucide-react'
import { Layout } from '@/components/layout/Layout'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { NAV_ITEMS, type TabId } from '@/constants/navigation'
import { WalletScreen, type DepositRequest } from '@/components/wallet/WalletScreen'
import { OrdersScreen } from '@/components/orders/OrdersScreen'
import { ServicesScreen } from '@/components/services/ServicesScreen'
import { SettingsScreen } from '@/components/settings/SettingsScreen'
import { useAuth } from '@/context/AuthContext'

// Admin code is split into its own chunk: regular users never download it.
const AdminScreen = lazy(() => import('@/components/admin/AdminScreen').then((m) => ({ default: m.AdminScreen })))

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-gradient-to-b from-[#EBF3FE] to-[#F8FAFC] px-5">
      {children}
    </div>
  )
}

export default function App() {
  const { state, retry } = useAuth()
  const [tab, setTab] = useState<TabId>('home')
  const [depositRequest, setDepositRequest] = useState<DepositRequest | null>(null)
  const clearDepositRequest = useCallback(() => setDepositRequest(null), [])

  /** Jump to the wallet and open the deposit drawer (suggesting at least the missing amount, if known). */
  const topUp = (shortfallUsd?: number) => {
    setDepositRequest({ amount: shortfallUsd ? Math.max(1, Math.ceil(shortfallUsd)) : undefined })
    setTab('wallet')
  }

  if (state.status === 'loading') {
    return (
      <FullScreen>
        <Loader2 size={32} strokeWidth={2} className="animate-spin text-brand" aria-label="Loading" />
      </FullScreen>
    )
  }

  if (state.status === 'error') {
    return (
      <FullScreen>
        <Card className="w-full max-w-sm space-y-3 text-center">
          <AlertCircle size={32} strokeWidth={1.75} className="mx-auto text-brand" />
          <h1 className="text-lg font-bold">Can't sign you in</h1>
          <p className="text-sm text-content-secondary">{state.message}</p>
          <Button className="w-full" onClick={retry}>
            Try again
          </Button>
        </Card>
      </FullScreen>
    )
  }

  const { user, wallet, isMock } = state.session
  const title = NAV_ITEMS.find((i) => i.id === tab)?.label

  return (
    <Layout
      activeTab={tab}
      onTabChange={setTab}
      balance={wallet.balance}
      currency={wallet.currency}
      onTopUp={() => topUp()}
      isAdmin={user.isAdmin}
    >
      {tab === 'services' ? (
        <ServicesScreen session={state.session} onTopUp={topUp} onViewOrders={() => setTab('orders')} />
      ) : tab === 'wallet' ? (
        <WalletScreen session={state.session} depositRequest={depositRequest} onRequestHandled={clearDepositRequest} />
      ) : tab === 'admin' && user.isAdmin ? (
        <Suspense fallback={<Loader2 size={28} strokeWidth={2} className="mx-auto mt-16 animate-spin text-brand" aria-label="Loading" />}>
          <AdminScreen session={state.session} />
        </Suspense>
      ) : tab === 'settings' ? (
        <SettingsScreen session={state.session} />
      ) : tab === 'orders' ? (
        <OrdersScreen session={state.session} onBrowse={() => setTab('services')} />
      ) : (
        <>
          <h1 className="mb-4 text-2xl font-extrabold tracking-tight text-content-primary">{title}</h1>
          <Card className="space-y-3">
            <div className="flex gap-2">
              <Badge>
                <Sparkles size={12} strokeWidth={2} /> New
              </Badge>
              {isMock && <Badge>Dev mock user</Badge>}
            </div>
            <h2 className="text-lg font-bold">Boost your socials</h2>
            <p className="text-sm text-content-secondary">
              Placeholder content for the {title?.toLowerCase()} screen.
            </p>
            <Button className="w-full" onClick={() => setTab('services')}>
              Browse services
            </Button>
          </Card>
        </>
      )}
    </Layout>
  )
}
