import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine, BadgePercent, Check, ChevronDown, ChevronRight, Clock, Coins, Gem, Layers, LayoutGrid, LifeBuoy, ReceiptText,
  RefreshCw, Route, Send, Sparkles, Users, Zap, type LucideIcon,
} from 'lucide-react'
import { PlatformBadge, PlatformIcon } from '@/components/services/PlatformIcon'
import { OrderModal } from '@/components/services/OrderModal'
import { mergePlatforms, platformEntries } from '@/components/services/ServicesScreen'
import type { PlatformEntry } from '@/components/services/PlatformList'
import { FAQ_ANCHOR } from '@/components/layout/WebLayout'
import { useAuth } from '@/context/AuthContext'
import { useSignIn } from '@/context/SignInContext'
import { currentLocale, tr, useLanguage, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { SERVICES_FALLBACK, featuredCategories, quickPlatforms, totalServices } from '@/lib/home-view'
import { formatMoneyAmount } from '@/lib/order-calc'
import { localizedName } from '@/lib/service-view'
import { telegramBotUsername } from '@/lib/telegram-bot'
import { cn, formatMoney } from '@/lib/utils'
import { fetchCategories, fetchCategoryServices, fetchLowestRate, fetchPlatforms } from '@/services/api/services'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalogService } from '@/types/catalog'

interface Props {
  session: AuthSession
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

const BENEFITS: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: BadgePercent, title: tr('Smart price arbitrage'), text: tr('For every order the system compares trusted providers and picks the best price. Bulk orders get cascading discounts automatically: up to −35% depending on the volume.') },
  { icon: Zap, title: tr('Instant start 24/7'), text: tr('Orders go to work by themselves within seconds, day and night, weekends included. No managers and no waiting.') },
  { icon: Layers, title: tr('Packages and Drip-feed'), text: tr('Choose Economy, Standard or Premium quality, and spread an order over time with Drip-feed for natural growth.') },
  { icon: RefreshCw, title: tr('Refill guarantee'), text: tr('Services with a guarantee are refilled for free if the numbers drop during the refill period: one tap on the order.') },
  { icon: Gem, title: tr('Payment in TON'), text: tr('Top up with TON through TON Connect in a couple of taps. GRAM Hub adds no hidden fees.') },
  { icon: LifeBuoy, title: tr('Support around the clock'), text: tr('Write to support right from an order: we answer and sort out any question.') },
]

const AUDIENCES: Array<{ id: string; icon: LucideIcon; title: string; text: string; points: string[] }> = [
  {
    id: 'creators', icon: Sparkles, title: tr('For creators and brands'),
    text: tr('Grow a channel, a profile or a brand page without contracts or managers. Pick a platform, paste a link, and the order starts by itself within seconds.'),
    points: [tr('Telegram, Instagram, TikTok, YouTube and dozens more platforms'), tr('Quality packages from Economy to Premium'), tr('Drip-feed for natural, gradual growth')],
  },
  {
    id: 'agencies', icon: Users, title: tr('For agencies and resellers'),
    text: tr('Run many orders for many clients from one balance. The bigger the order, the lower the price per 1,000: the bulk steps apply automatically.'),
    points: [tr('Cascading bulk discounts up to −35%'), tr('One TON balance for every order'), tr('The status and progress of every order in one place')],
  },
  {
    id: 'routing', icon: Route, title: tr('Smart routing and guarantees'),
    text: tr('For every order the system checks trusted providers and sends it to the best one available at that moment. A provider that is down is skipped automatically.'),
    points: [tr('The best price among trusted providers for every order'), tr('Providers are checked every minute'), tr('The money returns to your balance if an order is canceled')],
  },
]

const FAQ: Array<{ q: string; a: string }> = [
  { q: tr('How do I sign in with Telegram?'), a: tr('Press «Sign in» at the top right. Telegram opens our bot {bot}: press «Confirm» in its message and come back, you are signed in automatically. No passwords, and the bot never asks for codes.') },
  { q: tr('How does payment in TON work?'), a: tr('Open the Wallet, choose the amount and confirm the transfer in your TON wallet through TON Connect. The balance is credited automatically as soon as the network confirms the payment.') },
  { q: tr('How do bulk discounts work?'), a: tr('The bigger the quantity, the lower the price per 1,000. The steps are shown right in the order form and apply automatically, up to −35% on large volumes.') },
  { q: tr('What are Drip-feed and Refill?'), a: tr('Drip-feed splits an order into several deliveries with a pause between them, so the growth looks natural. Refill is the guarantee: if the numbers drop during the refill period, the service tops them up for free on request.') },
  { q: tr('How do I track my order?'), a: tr('Every order is on the Orders tab with its status and progress, updated automatically. If something goes wrong, report it from the order in one tap.') },
  { q: tr('What if an order cannot be completed?'), a: tr('If an order is canceled or delivered only in part, the unused amount returns to your balance automatically.') },
]

/**
 * The website's home page (the app opened in a browser): what GRAM Hub is, a way in by platform, live numbers, the benefits, who it is for
 * and the answers to the usual questions. The Mini App keeps its own phone Home screen.
 */
export function WebHome({ session, onBrowse, onTopUp, onViewOrders }: Props) {
  const t = useT()
  const { lang } = useLanguage()
  const { refreshWallet } = useAuth()
  const signIn = useSignIn()
  const guest = session.isGuest === true
  const bot = telegramBotUsername()
  const [catalog, setCatalog] = useState<Loaded<{ total: number; platforms: PlatformEntry[] }>>({ status: 'loading' })
  const [featured, setFeatured] = useState<Loaded<Featured[]>>({ status: 'loading' })
  const [lowest, setLowest] = useState<number | null>(null)
  const [selected, setSelected] = useState<Featured | null>(null)
  const [audience, setAudience] = useState(AUDIENCES[0].id)

  useEffect(() => {
    let live = true
    Promise.all([fetchCategories(session), fetchPlatforms(session).catch(() => null)]).then(
      async ([categories, registry]) => {
        const merged = mergePlatforms(registry, categories)
        const names = new Map(merged.map((p) => [p.slug, p.name]))
        if (live) setCatalog({ status: 'ready', data: { total: totalServices(categories), platforms: quickPlatforms(platformEntries(merged, categories)) } })
        const picks = await Promise.all(featuredCategories(categories).map(async (c) => {
          const [service] = await fetchCategoryServices(session, c.id, 0, 1).catch(() => [])
          return service ? { service, platform: c.platform, platformName: names.get(c.platform) ?? c.platform } : null
        }))
        if (live) setFeatured({ status: 'ready', data: picks.filter((p): p is Featured => p !== null) })
      },
      () => { if (live) { setCatalog({ status: 'error' }); setFeatured({ status: 'error' }) } },
    )
    fetchLowestRate(session).then((r) => { if (live) setLowest(r) }, () => {})
    return () => { live = false }
  }, [session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps

  const servicesCount = useMemo(
    () => (catalog.status === 'ready' && catalog.data.total > 0 ? new Intl.NumberFormat(currentLocale()).format(catalog.data.total) : SERVICES_FALLBACK),
    [catalog, lang], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const order = (f: Featured) => {
    haptic.tap()
    setSelected(f)
    if (!guest) void refreshWallet()
  }
  const active = AUDIENCES.find((a) => a.id === audience) ?? AUDIENCES[0]

  return (
    <div className="space-y-14 lg:space-y-20" data-testid="web-home">
      {/* Hero: two columns on a wide screen */}
      <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand-light px-3 py-1 text-xs font-bold text-brand-text">
            <Send size={13} strokeWidth={2.25} /> Telegram · TON · 24/7
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.1] tracking-tight text-content-primary sm:text-5xl xl:text-[56px]">{t('Promote your social networks on autopilot')}</h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-content-secondary sm:text-lg">
            {t('GRAM Hub starts your orders automatically 24/7, picks the best price among trusted providers for every order and takes payment in TON.')}
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => { haptic.tap(); onBrowse() }} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand px-7 py-3.5 text-[15px] font-bold text-white shadow-[0_10px_30px_rgb(0,152,234,0.3)] transition-colors hover:bg-brand-hover active:scale-[0.98]">
              <LayoutGrid size={18} strokeWidth={2} /> {t('Go to catalog')}
            </button>
            <button type="button" onClick={() => { haptic.tap(); onTopUp() }} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-brand/30 bg-surface px-7 py-3.5 text-[15px] font-bold text-brand-text transition-colors hover:border-brand active:scale-[0.98]">
              <ArrowDownToLine size={18} strokeWidth={2} /> {t('Top up balance')}
            </button>
          </div>
          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold text-content-secondary">
            {[tr('Automatic start'), tr('Refund if canceled'), tr('Payment in TON')].map((x) => (
              <li key={x} className="flex items-center gap-1.5"><Check size={16} strokeWidth={2.5} className="text-emerald-600" /> {t(x)}</li>
            ))}
          </ul>
        </div>

        <div className="space-y-4 rounded-[32px] border border-blue-100/70 bg-surface/90 p-5 shadow-card sm:p-6">
          {guest ? (
            <div className="rounded-3xl bg-gradient-to-br from-brand to-brand-hover p-5 text-white">
              <h2 className="flex items-center gap-2 text-lg font-extrabold"><Send size={18} strokeWidth={2.25} /> {t('Sign in with Telegram')}</h2>
              <p className="mt-1.5 text-sm text-white/85">{t('Confirm the sign-in in our bot {bot}: no passwords and nothing to fill in.', { bot: bot ? `@${bot}` : 'Telegram' })}</p>
              <button type="button" onClick={() => { haptic.tap(); signIn() }} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-bold text-brand-dark transition-transform active:scale-[0.98]">
                {t('Sign in with Telegram')}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-surface-sub p-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-content-muted">{t('Your balance')}</p>
                <p className="mt-1 text-3xl font-extrabold tabular-nums text-content-primary">{formatMoney(session.wallet.balance, session.wallet.currency)}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => { haptic.tap(); onTopUp() }} className="rounded-2xl bg-brand px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-hover">{t('Top up')}</button>
                <button type="button" onClick={() => { haptic.tap(); onViewOrders() }} className="flex items-center gap-1.5 rounded-2xl border border-blue-100/70 bg-surface px-4 py-2.5 text-sm font-bold text-content-primary hover:border-brand/40">
                  <ReceiptText size={16} strokeWidth={2} /> {t('My orders')}
                </button>
              </div>
            </div>
          )}

          {catalog.status !== 'error' && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-extrabold text-content-primary">{t('Choose a platform')}</h2>
                <button type="button" onClick={() => { haptic.tap(); onBrowse() }} className="flex items-center gap-0.5 text-sm font-bold text-brand-text hover:underline">
                  {t('All')} <ChevronRight size={15} strokeWidth={2} className="rtl:rotate-180" />
                </button>
              </div>
              <ul className="grid grid-cols-4 gap-2.5">
                {catalog.status === 'loading'
                  ? Array.from({ length: 8 }, (_, i) => <li key={i} className="h-[96px] animate-pulse rounded-2xl bg-surface-sub" />)
                  : catalog.data.platforms.map((p) => (
                    <li key={p.slug}>
                      <button type="button" onClick={() => { haptic.tap(); onBrowse(p.slug) }} className="flex h-full w-full flex-col items-center gap-1.5 rounded-2xl border border-blue-100/70 bg-surface px-1 py-3 text-center transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-card">
                        <PlatformBadge slug={p.slug} name={p.name} size={38} />
                        <span className="w-full truncate text-xs font-bold text-content-primary">{p.name}</span>
                        <span className="text-[11px] font-semibold text-content-muted">{new Intl.NumberFormat(currentLocale()).format(p.count)}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* Live numbers */}
      <section aria-label={t('GRAM Hub in numbers')}>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={Zap} value={t('In seconds')} label={t('Orders start automatically')} />
          <StatCard icon={Sparkles} value={servicesCount} label={t('Active services')} />
          <StatCard icon={Coins} value={lowest !== null ? t('from {price}', { price: formatMoneyAmount(lowest) }) : '—'} label={t('Lowest price per 1,000')} />
          <StatCard icon={Clock} value="24/7" label={t('Around the clock, without days off')} />
        </ul>
      </section>

      {/* Popular services */}
      {featured.status !== 'error' && !(featured.status === 'ready' && featured.data.length === 0) && (
        <section aria-labelledby="web-popular">
          <SectionHead id="web-popular" title={t('Popular services')} action={t('Go to catalog')} onAction={() => { haptic.tap(); onBrowse() }} />
          <ul className={cn('grid gap-4 md:grid-cols-2', featured.status === 'ready' && featured.data.length === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
            {featured.status === 'loading'
              ? [0, 1, 2].map((i) => <li key={i} className="h-[92px] animate-pulse rounded-3xl border border-blue-100/70 bg-surface/80" />)
              : featured.data.map((f) => (
                <li key={f.service.id}>
                  <button type="button" onClick={() => order(f)} className="flex h-full w-full items-center gap-3 rounded-3xl border border-blue-100/70 bg-surface p-4 text-start shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-card">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand">
                      <PlatformIcon platform={f.platform} name={f.platformName} size={24} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-sm font-bold leading-snug text-content-primary">{localizedName(f.service.name, f.service.nameI18n, lang)}</span>
                      <span className="mt-0.5 block text-[15px] font-extrabold text-content-primary">
                        {formatMoneyAmount(f.service.ratePer1000)} <span className="text-xs font-semibold text-content-muted">/ 1,000</span>
                      </span>
                    </span>
                    <span className="flex h-9 shrink-0 items-center rounded-full bg-brand px-4 text-xs font-bold text-white">{t('Order now')}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* Benefits */}
      <section aria-labelledby="web-benefits">
        <SectionHead id="web-benefits" title={t('Why GRAM Hub')} subtitle={t('Everything you need to promote on social networks, on one platform.')} />
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-3xl border border-blue-100/70 bg-surface p-6 shadow-sm">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-light text-brand"><Icon size={22} strokeWidth={2} /></span>
              <h3 className="mt-4 text-lg font-extrabold text-content-primary">{t(title)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-content-secondary">{t(text)}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Who it is for and how it works */}
      <section aria-labelledby="web-audience">
        <SectionHead id="web-audience" title={t('Who the platform is for and how it works')} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
          <div role="tablist" aria-label={t('Who the platform is for and how it works')} aria-orientation="vertical" className="flex flex-col gap-2">
            {AUDIENCES.map(({ id, icon: Icon, title }) => {
              const on = id === audience
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`aud-tab-${id}`}
                  aria-selected={on}
                  aria-controls="aud-panel"
                  onClick={() => { haptic.select(); setAudience(id) }}
                  className={cn('flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-start text-[15px] font-bold transition-colors', on ? 'border-brand bg-brand text-white shadow-card' : 'border-blue-100/70 bg-surface text-content-primary hover:border-brand/40')}
                >
                  <Icon size={20} strokeWidth={2} className={on ? 'text-white' : 'text-brand'} /> {t(title)}
                </button>
              )
            })}
          </div>
          <div role="tabpanel" id="aud-panel" aria-labelledby={`aud-tab-${active.id}`} className="rounded-3xl border border-blue-100/70 bg-surface p-6 shadow-sm sm:p-8">
            <h3 className="text-2xl font-extrabold text-content-primary">{t(active.title)}</h3>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-content-secondary">{t(active.text)}</p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-3">
              {active.points.map((p) => (
                <li key={p} className="flex gap-2 rounded-2xl bg-surface-sub p-4 text-sm font-semibold text-content-primary">
                  <Check size={18} strokeWidth={2.5} className="mt-0.5 shrink-0 text-emerald-600" /> {t(p)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Questions and answers */}
      <section id={FAQ_ANCHOR} aria-labelledby="web-faq" className="scroll-mt-24">
        <SectionHead id="web-faq" title={t('Questions and answers')} />
        <div className="grid items-start gap-3 md:grid-cols-2">
          {FAQ.map(({ q, a }) => (
            <details key={q} className="group rounded-2xl border border-blue-100/70 bg-surface px-5 py-4 shadow-sm open:border-brand/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-bold text-content-primary [&::-webkit-details-marker]:hidden">
                {t(q)}
                <ChevronDown size={18} strokeWidth={2} className="shrink-0 text-content-muted transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-content-secondary">{t(a, { bot: bot ? `@${bot}` : 'Telegram' })}</p>
            </details>
          ))}
        </div>
      </section>

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

function StatCard({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <li className="flex items-center gap-4 rounded-3xl border border-blue-100/70 bg-surface p-5 shadow-sm">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand"><Icon size={22} strokeWidth={2} /></span>
      <span className="min-w-0">
        <span className="block truncate text-2xl font-extrabold tabular-nums text-content-primary">{value}</span>
        <span className="block text-sm font-medium text-content-secondary">{label}</span>
      </span>
    </li>
  )
}

function SectionHead({ id, title, subtitle, action, onAction }: { id: string; title: string; subtitle?: string; action?: string; onAction?: () => void }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id={id} className="text-2xl font-extrabold tracking-tight text-content-primary sm:text-3xl">{title}</h2>
        {subtitle && <p className="mt-1.5 text-base text-content-secondary">{subtitle}</p>}
      </div>
      {action && onAction && (
        <button type="button" onClick={onAction} className="flex items-center gap-1 text-sm font-bold text-brand-text hover:underline">
          {action} <ChevronRight size={16} strokeWidth={2} className="rtl:rotate-180" />
        </button>
      )}
    </div>
  )
}
