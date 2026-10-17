import type { ReactNode } from 'react'
import { ChevronDown, CircleHelp, Home, Languages, LayoutGrid, LifeBuoy, Moon, Plus, ReceiptText, Send, Settings, ShieldCheck, Sun, Wallet, type LucideIcon } from 'lucide-react'
import { BottomNav } from '@/components/navigation/BottomNav'
import { NAV_ITEMS, type TabId } from '@/constants/navigation'
import { LANGUAGES, tr, useLanguage, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { legalDocPath } from '@/lib/legal'
import { telegramBotUsername } from '@/lib/telegram-bot'
import { setThemePreference, useScheme } from '@/lib/theme'
import { cn, formatMoney } from '@/lib/utils'

interface Props {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  balance: number
  currency: string
  onTopUp?: () => void
  isAdmin?: boolean
  guest?: boolean
  onSignIn?: () => void
  children: ReactNode
}

type WebNavId = TabId | 'faq'

const WEB_NAV: Array<{ id: WebNavId; label: string; icon: LucideIcon }> = [
  { id: 'home', label: tr('Home'), icon: Home },
  { id: 'services', label: tr('Service catalog'), icon: LayoutGrid },
  { id: 'orders', label: tr('Orders'), icon: ReceiptText },
  { id: 'wallet', label: tr('Wallet'), icon: Wallet },
  { id: 'support', label: tr('Support'), icon: LifeBuoy },
  { id: 'faq', label: tr('FAQ'), icon: CircleHelp },
]

/** Where the FAQ of the website's home page starts (the navigation bar's "FAQ" scrolls there). */
export const FAQ_ANCHOR = 'faq'

const iconButton = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-blue-100/70 bg-surface text-content-secondary shadow-sm transition-colors hover:text-brand active:scale-95'

/** The brand: the app icon and the GRAM Hub wordmark of the Mini App. */
export function BrandMark({ onClick }: { onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex shrink-0 items-center gap-2.5 text-start" aria-label="GRAM Hub, TON Ecosystem">
      <img src="/tonconnect-icon.png" alt="" width={38} height={38} className="h-[38px] w-[38px] rounded-xl shadow-sm" />
      <span className="leading-none">
        <span className="block whitespace-nowrap text-[19px] font-extrabold tracking-tight text-content-primary">GRAM Hub</span>
        <span className="mt-1 block whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.14em] text-content-muted">TON Ecosystem</span>
      </span>
    </button>
  )
}

function LanguagePicker() {
  const t = useT()
  const { lang, setLanguage } = useLanguage()
  return (
    // the native list (keyboard, screen readers, phones) under a compact pill that shows the current language
    <label className="relative flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-blue-100/70 bg-surface pe-2.5 ps-3 text-[13px] font-bold uppercase text-content-secondary shadow-sm hover:text-brand">
      <Languages size={16} strokeWidth={1.75} />
      {lang}
      <ChevronDown size={14} strokeWidth={2} />
      <select
        value={lang}
        aria-label={t('Language')}
        onChange={(e) => { haptic.select(); void setLanguage(e.target.value as typeof lang) }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
    </label>
  )
}

/**
 * The website's frame (the app opened in a browser, not in Telegram): a sticky navigation bar across the whole width, the page in a wide
 * container, a footer. On a phone-sized browser the sections move to the familiar tab bar at the bottom. The Mini App never renders this.
 */
export function WebLayout({ activeTab, onTabChange, balance, currency, onTopUp, isAdmin = false, guest = false, onSignIn, children }: Props) {
  const t = useT()
  const { lang } = useLanguage()
  const dark = useScheme() === 'dark'
  const bot = telegramBotUsername()

  const go = (id: WebNavId) => {
    haptic.select()
    if (id === 'faq') {
      const wasHome = activeTab === 'home'
      if (!wasHome) onTabChange('home')
      window.setTimeout(() => document.getElementById(FAQ_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), wasHome ? 0 : 80)
      return
    }
    onTabChange(id)
    window.scrollTo({ top: 0 })
  }
  const tab = (id: TabId) => () => go(id)

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-b from-screen to-screen-end" data-layout="web">
      <header className="sticky top-0 z-40 border-b border-blue-100/70 bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-4 px-4 sm:px-6">
          <BrandMark onClick={tab('home')} />

          <nav aria-label={t('Sections')} className="mx-auto hidden lg:block">
            <ul className="flex items-center gap-1">
              {WEB_NAV.map(({ id, label, icon: Icon }) => {
                const active = id === activeTab
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => go(id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-semibold transition-colors xl:px-4',
                        active ? 'bg-brand-light text-brand-text' : 'text-content-secondary hover:bg-surface-sub hover:text-content-primary',
                      )}
                    >
                      <Icon size={16} strokeWidth={active ? 2.25 : 1.75} /> {t(label)}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          <div className="ms-auto flex shrink-0 items-center gap-2 lg:ms-0">
            <button
              type="button"
              onClick={() => { haptic.select(); setThemePreference(dark ? 'light' : 'dark') }}
              aria-label={dark ? t('Switch to light theme') : t('Switch to dark theme')}
              className={cn(iconButton, 'hidden sm:flex')}
            >
              {dark ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
            </button>
            <div className="hidden md:block"><LanguagePicker /></div>
            {guest ? (
              <button
                type="button"
                onClick={() => { haptic.tap(); onSignIn?.() }}
                className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-brand px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-brand-hover active:scale-95"
                data-testid="header-sign-in"
              >
                <Send size={16} strokeWidth={2.25} />
                <span className="sm:hidden">{t('Sign in')}</span>
                <span className="hidden sm:inline">{t('Sign in with Telegram')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onTopUp}
                aria-label={t('Top up balance')}
                className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-blue-100/70 bg-surface pe-1.5 ps-4 shadow-sm hover:border-brand/40"
              >
                <span className="whitespace-nowrap text-sm font-bold tabular-nums text-content-primary">{formatMoney(balance, currency)}</span>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-white"><Plus size={16} strokeWidth={2} /></span>
              </button>
            )}
            <button type="button" onClick={tab('settings')} aria-label={t('Settings')} aria-pressed={activeTab === 'settings'} className={cn(iconButton, activeTab === 'settings' && 'bg-brand text-white hover:text-white')}>
              <Settings size={18} strokeWidth={1.75} />
            </button>
            {isAdmin && (
              <button type="button" onClick={tab('admin')} aria-label={t('Admin')} aria-pressed={activeTab === 'admin'} className={cn(iconButton, 'hidden sm:flex', activeTab === 'admin' ? 'bg-brand text-white hover:text-white' : 'text-brand')}>
                <ShieldCheck size={18} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-28 pt-6 sm:px-6 lg:pb-14 lg:pt-8">{children}</main>

      <footer className="border-t border-blue-100/70 bg-surface/70 pb-24 lg:pb-0">
        <div className="mx-auto grid max-w-[1320px] gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
          <div className="space-y-3">
            <BrandMark onClick={tab('home')} />
            <p className="max-w-sm text-sm text-content-secondary">{t('Social media promotion with automatic start, the best price for every order and payment in TON.')}</p>
          </div>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">{t('Documents')}</h2>
            <ul className="mt-3 space-y-2 text-sm font-semibold">
              <li><a className="text-content-secondary hover:text-brand" href={legalDocPath('terms', lang)}>{t('Terms of Service')}</a></li>
              <li><a className="text-content-secondary hover:text-brand" href={legalDocPath('privacy', lang)}>{t('Privacy Policy')}</a></li>
              <li><a className="text-content-secondary hover:text-brand" href={`${legalDocPath('terms', lang)}#orders`}>{t('Refund rules')}</a></li>
            </ul>
          </div>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">{t('Contact')}</h2>
            <ul className="mt-3 space-y-2 text-sm font-semibold">
              {bot && (
                <li>
                  <a className="inline-flex items-center gap-1.5 text-content-secondary hover:text-brand" href={`https://t.me/${bot}`} target="_blank" rel="noopener noreferrer">
                    <Send size={14} strokeWidth={2} /> @{bot}
                  </a>
                </li>
              )}
              <li><button type="button" className="text-content-secondary hover:text-brand" onClick={tab('support')}>{t('Support')}</button></li>
              <li><button type="button" className="text-content-secondary hover:text-brand" onClick={() => go('faq')}>{t('FAQ')}</button></li>
            </ul>
          </div>
        </div>
        <p className="mx-auto max-w-[1320px] border-t border-blue-100/70 px-4 py-5 text-xs text-content-muted sm:px-6">{t('© {year} GRAM Hub. All rights reserved.', { year: new Date().getFullYear() })}</p>
      </footer>

      {/* a phone-sized browser: the sections as the app's tab bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 lg:hidden">
        <div className="mx-auto max-w-md">
          <BottomNav active={activeTab} onChange={(id) => go(id)} items={NAV_ITEMS} />
        </div>
      </div>
    </div>
  )
}
