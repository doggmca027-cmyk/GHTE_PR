import { useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ChevronRight, Clock, Copy, Gift, LayoutGrid, ReceiptText, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PlatformBadge, PlatformIcon } from '@/components/services/PlatformIcon'
import { OrderModal } from '@/components/services/OrderModal'
import { mergePlatforms, platformEntries } from '@/components/services/ServicesScreen'
import type { PlatformEntry } from '@/components/services/PlatformList'
import { useAuth } from '@/context/AuthContext'
import { currentLocale, useLanguage, useT } from '@/i18n'
import { copyText } from '@/lib/clipboard'
import { haptic } from '@/lib/haptics'
import { SERVICES_FALLBACK, featuredCategories, ordersSummary, quickPlatforms, referralLink, totalServices, type OrdersSummary } from '@/lib/home-view'
import { formatMoneyAmount } from '@/lib/order-calc'
import { localizedName } from '@/lib/service-view'
import { cn } from '@/lib/utils'
import { getOrders } from '@/services/api/orders'
import { getReferralSummary, type ReferralSummary } from '@/services/api/referrals'
import { fetchCategories, fetchCategoryServices, fetchPlatforms } from '@/services/api/services'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalogService } from '@/types/catalog'

interface Props {
  session: AuthSession
  /** Open the services tab, on this platform when one is given. */
  onBrowse: (platform?: string) => void
  onTopUp: (shortfallUsd?: number) => void
  onViewOrders: () => void
}

interface Featured {
  service: ICatalogService
  platform: string
  platformName: string
}

type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T }

const INVITE_APP_URL = import.meta.env.VITE_TWA_RETURN_URL as string | undefined

/** The Home screen: what the store offers, a way in by platform, a few everyday services, your orders and the invite programme. */
export function HomeScreen({ session, onBrowse, onTopUp, onViewOrders }: Props) {
  const t = useT()
  const { lang } = useLanguage()
  const { refreshWallet } = useAuth()
  const [catalog, setCatalog] = useState<Loaded<{ total: number; platforms: PlatformEntry[]; names: Map<string, string> }>>({ status: 'loading' })
  const [featured, setFeatured] = useState<Loaded<Featured[]>>({ status: 'loading' })
  const [orders, setOrders] = useState<Loaded<OrdersSummary>>({ status: 'loading' })
  const [referral, setReferral] = useState<Loaded<ReferralSummary>>({ status: 'loading' })
  const [selected, setSelected] = useState<Featured | null>(null)
  const [copied, setCopied] = useState(false)

  // Everything is loaded side by side; each block shows its own skeleton and simply stays out of the way if its request fails.
  useEffect(() => {
    let live = true
    Promise.all([fetchCategories(session), fetchPlatforms(session).catch(() => null)]).then(
      async ([categories, registry]) => {
        const merged = mergePlatforms(registry, categories)
        const names = new Map(merged.map((p) => [p.slug, p.name]))
        if (live) setCatalog({ status: 'ready', data: { total: totalServices(categories), platforms: quickPlatforms(platformEntries(merged, categories)), names } })
        // the first (cheapest) service of each featured category
        const picks = await Promise.all(featuredCategories(categories).map(async (c) => {
          const [service] = await fetchCategoryServices(session, c.id, 0, 1).catch(() => [])
          return service ? { service, platform: c.platform, platformName: names.get(c.platform) ?? c.platform } : null
        }))
        if (live) setFeatured({ status: 'ready', data: picks.filter((p): p is Featured => p !== null) })
      },
      () => { if (live) { setCatalog({ status: 'error' }); setFeatured({ status: 'error' }) } },
    )
    // a website guest has no orders or invite link yet: those blocks simply stay out of the way
    if (session.isGuest) { setOrders({ status: 'error' }); setReferral({ status: 'error' }); return () => { live = false } }
    getOrders(session).then(
      (list) => { if (live) setOrders({ status: 'ready', data: ordersSummary(list) }) },
      () => { if (live) setOrders({ status: 'error' }) },
    )
    getReferralSummary(session).then(
      (r) => { if (live) setReferral({ status: 'ready', data: r }) },
      () => { if (live) setReferral({ status: 'error' }) },
    )
    return () => { live = false }
  }, [session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps

  const servicesCount = useMemo(
    () => (catalog.status === 'ready' && catalog.data.total > 0 ? new Intl.NumberFormat(currentLocale()).format(catalog.data.total) : SERVICES_FALLBACK),
    [catalog, lang], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const order = (f: Featured) => {
    haptic.tap()
    setSelected(f)
    void refreshWallet() // the balance check needs a fresh value
  }

  const invite = referral.status === 'ready' ? referralLink(INVITE_APP_URL, referral.data.startParam) : null
  const copyInvite = async () => {
    if (referral.status !== 'ready') return
    const ok = await copyText(invite ?? referral.data.code)
    if (ok) { haptic.success(); setCopied(true); setTimeout(() => setCopied(false), 2000) } else haptic.error()
  }

  return (
    <div className="space-y-5">
      {/* Hero: what the store is, three reasons to trust it, and the two ways in */}
      <section className="relative overflow-hidden rounded-[28px] border border-blue-100/70 bg-gradient-to-br from-surface via-card-mid to-card-end p-5 shadow-card">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-brand/10 blur-2xl" />
        {session.isMock && <Badge className="mb-2">{t('Dev mock user')}</Badge>}
        <h1 className="text-2xl font-extrabold leading-tight tracking-tight text-content-primary">{t('Boost your socials')}</h1>
        <p className="mt-1.5 text-sm font-medium leading-relaxed text-content-secondary">
          {t('Instant promotion for your social networks 24/7: orders start automatically, you pay with TON.')}
        </p>

        <ul className="mt-4 grid grid-cols-3 gap-2" aria-label={t('Why us')}>
          <TrustBadge icon={<Sparkles size={16} strokeWidth={2} />} value={servicesCount} caption={t('services')} />
          <TrustBadge icon={<Zap size={16} strokeWidth={2} />} value="24/7" caption={t('Auto start')} />
          <TrustBadge icon={<ShieldCheck size={16} strokeWidth={2} />} value={t('Safe')} caption={t('Refund if canceled')} />
        </ul>

        {/* stacked: both labels stay whole in every language on a 360 px phone */}
        <div className="mt-4 flex flex-col gap-2">
          <Button className="h-12 w-full px-3" onClick={() => { haptic.tap(); onBrowse() }}>
            <LayoutGrid size={16} strokeWidth={2} className="shrink-0" /> <span className="truncate">{t('Browse services')}</span>
          </Button>
          <button
            type="button"
            onClick={() => { haptic.tap(); onTopUp() }}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-brand/30 bg-surface px-3 text-sm font-bold text-brand-text transition-colors active:scale-[0.98]"
          >
            <ArrowDownToLine size={16} strokeWidth={2} className="shrink-0" /> <span className="truncate">{t('Top up')}</span>
          </button>
        </div>
      </section>

      {/* Quick platform selector */}
      {catalog.status !== 'error' && (
        <section aria-labelledby="home-platforms">
          <SectionTitle id="home-platforms" title={t('Choose a platform')} action={t('All')} onAction={() => { haptic.tap(); onBrowse() }} />
          <ul className="grid grid-cols-4 gap-2">
            {catalog.status === 'loading'
              ? Array.from({ length: 8 }, (_, i) => <li key={i} className="h-[92px] animate-pulse rounded-2xl border border-blue-100/70 bg-surface/80" />)
              : catalog.data.platforms.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    onClick={() => { haptic.tap(); onBrowse(p.slug) }}
                    className="flex h-full w-full flex-col items-center gap-1.5 rounded-2xl border border-blue-100/70 bg-surface px-1 py-2.5 text-center shadow-sm transition-all active:scale-95"
                  >
                    <PlatformBadge slug={p.slug} name={p.name} size={36} />
                    <span className="w-full truncate text-[11px] font-bold leading-tight text-content-primary">{p.name}</span>
                    <span className="text-[10px] font-semibold leading-none text-content-muted">{new Intl.NumberFormat(currentLocale()).format(p.count)}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* Popular services: the cheapest everyday service of a few core categories */}
      {featured.status !== 'error' && !(featured.status === 'ready' && featured.data.length === 0) && (
        <section aria-labelledby="home-popular">
          <SectionTitle id="home-popular" title={t('Popular services')} />
          <ul className="space-y-2">
            {featured.status === 'loading'
              ? [0, 1, 2].map((i) => <li key={i} className="h-[76px] animate-pulse rounded-3xl border border-blue-100/70 bg-surface/80" />)
              : featured.data.map((f) => (
                <li key={f.service.id}>
                  <button
                    type="button"
                    onClick={() => order(f)}
                    className="flex w-full items-center gap-3 rounded-3xl border border-blue-100/70 bg-surface p-3 text-start shadow-sm transition-all active:scale-[0.985]"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand">
                      <PlatformIcon platform={f.platform} name={f.platformName} size={22} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] font-bold leading-snug text-content-primary">{localizedName(f.service.name, f.service.nameI18n, lang)}</span>
                      <span className="mt-0.5 block text-sm font-extrabold text-content-primary">
                        {formatMoneyAmount(f.service.ratePer1000)}
                        <span className="ms-1 text-[11px] font-semibold text-content-muted">/ 1,000</span>
                      </span>
                    </span>
                    <span className="flex h-9 shrink-0 items-center rounded-full bg-brand px-3.5 text-xs font-bold text-white">{t('Order now')}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* My orders */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-light text-brand"><ReceiptText size={18} strokeWidth={1.75} /></span>
          <h2 className="text-[15px] font-bold text-content-primary">{t('My orders')}</h2>
        </div>
        {orders.status === 'loading' && <div className="h-14 animate-pulse rounded-2xl bg-surface-sub" />}
        {orders.status === 'ready' && orders.data.total > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <Stat icon={<Clock size={14} strokeWidth={2} />} value={orders.data.active} label={t('Active')} />
            <Stat icon={<ShieldCheck size={14} strokeWidth={2} />} value={orders.data.completed} label={t('Completed')} />
          </div>
        )}
        {orders.status === 'ready' && orders.data.total === 0 && (
          <p className="text-sm text-content-secondary">{t('No orders yet. Pick a service and place your first one.')}</p>
        )}
        {orders.status === 'ready' && orders.data.total === 0 ? (
          <Button className="h-11 w-full" onClick={() => { haptic.tap(); onBrowse() }}>{t('Browse services')}</Button>
        ) : (
          <button type="button" onClick={() => { haptic.tap(); onViewOrders() }} className="flex h-11 w-full items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-bold text-content-primary active:scale-[0.98]">
            {t('View orders')} <ChevronRight size={16} strokeWidth={2} className="rtl:rotate-180" />
          </button>
        )}
      </Card>

      {/* Invite programme */}
      {referral.status !== 'error' && (
        <section aria-label={t('Invite friends')} className="relative overflow-hidden rounded-[28px] border border-emerald-200 bg-gradient-to-br from-surface to-emerald-50 p-4 shadow-card">
          {referral.status === 'loading' ? (
            <div className="h-24 animate-pulse rounded-2xl bg-surface-sub" />
          ) : (
            <>
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white"><Gift size={20} strokeWidth={2} /></span>
                <div className="min-w-0">
                  <h2 className="text-[15px] font-bold text-content-primary">{t('Invite friends')}</h2>
                  <p className="mt-0.5 text-[13px] leading-snug text-content-secondary">
                    {t('Earn {percent}% of every order your friends place.', { percent: referral.data.percentage })}
                  </p>
                  {referral.data.invitees > 0 && <p className="mt-1 text-xs font-semibold text-emerald-700">{t('Friends invited: {n}', { n: referral.data.invitees })}</p>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void copyInvite()}
                className={cn('mt-3 flex h-11 w-full items-center justify-center gap-1.5 rounded-2xl text-sm font-bold transition-colors active:scale-[0.98]', copied ? 'bg-emerald-50 text-emerald-700' : 'bg-emerald-600 text-white')}
              >
                <Copy size={16} strokeWidth={2} />
                {copied ? (invite ? t('Link copied') : t('Code copied')) : invite ? t('Copy invite link') : t('Copy invite code: {code}', { code: referral.data.code })}
              </button>
            </>
          )}
        </section>
      )}

      {selected && (
        <OrderModal
          service={selected.service}
          platform={selected.platform}
          platformName={selected.platformName}
          session={session}
          onClose={() => setSelected(null)}
          onTopUp={(shortfall) => { setSelected(null); onTopUp(shortfall) }}
          onViewOrders={() => { setSelected(null); onViewOrders() }}
        />
      )}
    </div>
  )
}

function TrustBadge({ icon, value, caption }: { icon: React.ReactNode; value: string; caption: string }) {
  return (
    <li className="flex min-w-0 flex-col items-center rounded-2xl bg-surface/80 px-1.5 py-2.5 text-center shadow-sm">
      <span className="text-brand">{icon}</span>
      <span className="mt-1 max-w-full truncate text-[15px] font-extrabold leading-tight text-content-primary">{value}</span>
      <span className="mt-0.5 line-clamp-2 text-[10px] font-semibold leading-tight text-content-muted">{caption}</span>
    </li>
  )
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="rounded-2xl bg-surface-sub px-3 py-2.5">
      <p className="flex items-center gap-1 text-xs font-semibold text-content-secondary">{icon} {label}</p>
      <p className="mt-0.5 text-xl font-extrabold text-content-primary">{value}</p>
    </div>
  )
}

function SectionTitle({ id, title, action, onAction }: { id: string; title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 px-1">
      <h2 id={id} className="text-[17px] font-extrabold tracking-tight text-content-primary">{title}</h2>
      {action && onAction && (
        <button type="button" onClick={onAction} className="flex items-center gap-0.5 text-[13px] font-bold text-brand-text active:opacity-70">
          {action} <ChevronRight size={14} strokeWidth={2} className="rtl:rotate-180" />
        </button>
      )}
    </div>
  )
}
