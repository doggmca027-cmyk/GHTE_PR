import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
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
import { SupportScreen, type SupportRequest } from '@/components/support/SupportScreen'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { tm } from '@/i18n/messages'
import { bindAnalytics, track } from '@/lib/analytics-client'
import { WebApp } from '@/lib/webapp'

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
  const t = useT()
  const { state, retry } = useAuth()
  const [tab, setTab] = useState<TabId>('home')
  const [depositRequest, setDepositRequest] = useState<DepositRequest | null>(null)
  const clearDepositRequest = useCallback(() => setDepositRequest(null), [])
  const [supportRequest, setSupportRequest] = useState<SupportRequest | null>(null)
  const clearSupportRequest = useCallback(() => setSupportRequest(null), [])

  // Product analytics (after the first paint, never blocking): bind the signed-in session, report the app opening once and the
  // screen the customer lands on. The services screen reports its own catalog views.
  const session = state.status === 'authenticated' ? state.session : null
  const opened = useRef(false)
  useEffect(() => {
    bindAnalytics(session)
    if (session && !opened.current) {
      opened.current = true
      track('app_opened', { platform: String(WebApp.platform ?? 'unknown').toLowerCase() })
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

  const { user, wallet, isMock } = state.session
  const navLabel = NAV_ITEMS.find((i) => i.id === tab)?.label
  const title = navLabel ? t(navLabel) : undefined

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
        <>
          <h1 className="mb-4 text-2xl font-extrabold tracking-tight text-content-primary">{title}</h1>
          <Card className="space-y-3">
            <div className="flex gap-2">
              <Badge>
                <Sparkles size={12} strokeWidth={2} /> {t('New')}
              </Badge>
              {isMock && <Badge>{t('Dev mock user')}</Badge>}
            </div>
            <h2 className="text-lg font-bold">{t('Boost your socials')}</h2>
            <p className="text-sm text-content-secondary">
              {t('Placeholder content for the {title} screen.', { title: title?.toLowerCase() ?? '' })}
            </p>
            <Button className="w-full" onClick={() => setTab('services')}>
              {t('Browse services')}
            </Button>
          </Card>
        </>
      )}
    </Layout>
  )
}
