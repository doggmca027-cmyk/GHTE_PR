import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Layout } from '@/components/layout/Layout'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import type { TabId } from '@/constants/navigation'
import { HomeScreen } from '@/components/home/HomeScreen'
import { WalletScreen, type DepositRequest } from '@/components/wallet/WalletScreen'
import { OrdersScreen } from '@/components/orders/OrdersScreen'
import { ServicesScreen } from '@/components/services/ServicesScreen'
import { SettingsScreen } from '@/components/settings/SettingsScreen'
import { SupportScreen, type SupportRequest } from '@/components/support/SupportScreen'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { tm } from '@/i18n/messages'
import { bindAnalytics, track } from '@/lib/analytics-client'
import { applyStartReferral } from '@/lib/referral-start'
import { WebApp } from '@/lib/webapp'

// Admin code is split into its own chunk: regular users never download it.
const AdminScreen = lazy(() => import('@/components/admin/AdminScreen').then((m) => ({ default: m.AdminScreen })))

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-gradient-to-b from-screen to-screen-end px-5">
      {children}
    </div>
  )
}

export default function App() {
  const t = useT()
  const { state, retry } = useAuth()
  const [tab, setTab] = useState<TabId>('home')
  const [depositRequest, setDepositRequest] = useState<DepositRequest | null>(null)
  const clearDepositRequest = useCallback(() => setDepositRequest(null), [])
  const [supportRequest, setSupportRequest] = useState<SupportRequest | null>(null)
  const clearSupportRequest = useCallback(() => setSupportRequest(null), [])
  // a platform tile of the Home screen: the services tab opens on it
  const [servicesPlatform, setServicesPlatform] = useState<string | null>(null)
  const changeTab = (next: TabId) => { setServicesPlatform(null); setTab(next) }

  // Product analytics (after the first paint, never blocking): bind the signed-in session, report the app opening once and the
  // screen the customer lands on. The services screen reports its own catalog views.
  const session = state.status === 'authenticated' ? state.session : null
  const opened = useRef(false)
  useEffect(() => {
    bindAnalytics(session)
    if (session && !opened.current) {
      opened.current = true
      track('app_opened', { platform: String(WebApp.platform ?? 'unknown').toLowerCase() })
      // opened through a friend's invite link: attach the invite (once; the server decides whether it counts)
      void applyStartReferral(session, WebApp.initDataUnsafe?.start_param)
    }
  }, [session?.token, session?.isMock]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!session) return
    if (tab === 'orders') track('orders_view')
    else if (tab === 'wallet') track('wallet_view')
    else if (tab === 'settings') track('settings_view')
  }, [tab, session?.token]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Jump to the wallet and open the deposit drawer (suggesting at least the missing amount, if known). */
  const topUp = (shortfallUsd?: number) => {
    setDepositRequest({ amount: shortfallUsd ? Math.max(1, Math.ceil(shortfallUsd)) : undefined })
    setTab('wallet')
  }

  if (state.status === 'loading') {
    return (
      <FullScreen>
        <Loader2 size={32} strokeWidth={2} className="animate-spin text-brand" aria-label={t('Loading')} />
      </FullScreen>
    )
  }

  if (state.status === 'error') {
    return (
      <FullScreen>
        <Card className="w-full max-w-sm space-y-3 text-center">
          <AlertCircle size={32} strokeWidth={1.75} className="mx-auto text-brand" />
          <h1 className="text-lg font-bold">{t("Can't sign you in")}</h1>
          <p className="text-sm text-content-secondary">{tm(state.message)}</p>
          <Button className="w-full" onClick={retry}>
            {t('Try again')}
          </Button>
        </Card>
      </FullScreen>
    )
  }

  const { user, wallet } = state.session

  return (
    <Layout
      activeTab={tab}
      onTabChange={changeTab}
      balance={wallet.balance}
      currency={wallet.currency}
      onTopUp={() => topUp()}
      isAdmin={user.isAdmin}
    >
      {tab === 'services' ? (
        <ServicesScreen session={state.session} onTopUp={topUp} onViewOrders={() => changeTab('orders')} initialPlatform={servicesPlatform} />
      ) : tab === 'wallet' ? (
        <WalletScreen session={state.session} depositRequest={depositRequest} onRequestHandled={clearDepositRequest} />
      ) : tab === 'admin' && user.isAdmin ? (
        <Suspense fallback={<Loader2 size={28} strokeWidth={2} className="mx-auto mt-16 animate-spin text-brand" aria-label={t('Loading')} />}>
          <AdminScreen session={state.session} />
        </Suspense>
      ) : tab === 'settings' ? (
        <SettingsScreen session={state.session} />
      ) : tab === 'support' ? (
        <SupportScreen session={state.session} request={supportRequest} onRequestHandled={clearSupportRequest} />
      ) : tab === 'orders' ? (
        <OrdersScreen session={state.session} onBrowse={() => setTab('services')} onReportIssue={(order) => { setSupportRequest({ orderId: order.id }); setTab('support') }} />
      ) : (
        <HomeScreen
          session={state.session}
          onBrowse={(platform) => { setServicesPlatform(platform ?? null); setTab('services') }}
          onTopUp={topUp}
          onViewOrders={() => changeTab('orders')}
        />
      )}
    </Layout>
  )
}
