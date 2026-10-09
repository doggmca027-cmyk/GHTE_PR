import { Check, ExternalLink, FileText, Languages, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { LANGUAGES, useLanguage, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-medium text-content-secondary">{label}</span>
      <span className="min-w-0 truncate font-bold text-content-primary">{value}</span>
    </div>
  )
}

function LinkRow({ href, icon: Icon, label }: { href: string; icon: typeof FileText; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-3 rounded-2xl bg-surface-sub px-3.5 py-3 text-sm font-semibold text-content-primary active:scale-[0.99]"
    >
      <span className="flex items-center gap-2">
        <Icon size={16} strokeWidth={1.75} className="text-brand" />
        {label}
      </span>
      <ExternalLink size={14} strokeWidth={1.75} className="text-content-muted" />
    </a>
  )
}

/** The 15 languages as a list. The customer's choice is remembered on the device; until then the app follows Telegram's language. */
function LanguageCard() {
  const t = useT()
  const { lang, setLanguage } = useLanguage()
  return (
    <Card className="space-y-2 p-4">
      <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-content-muted">
        <Languages size={14} strokeWidth={1.75} /> {t('Language')}
      </h2>
      <ul role="radiogroup" aria-label={t('Language')} className="space-y-1.5">
        {LANGUAGES.map((l) => {
          const selected = l.code === lang
          return (
            <li key={l.code}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                lang={l.code}
                onClick={() => { if (!selected) { haptic.select(); void setLanguage(l.code) } }}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-2xl px-3.5 py-3 text-start text-sm font-semibold transition-colors active:scale-[0.99]',
                  selected ? 'bg-brand-light text-brand-text' : 'bg-surface-sub text-content-primary',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{l.name}</span>
                  {l.name !== l.english && <span className="block truncate text-xs font-medium text-content-muted">{l.english}</span>}
                </span>
                {selected && <Check size={18} strokeWidth={2.25} className="shrink-0 text-brand" />}
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function SettingsScreen({ session }: { session: AuthSession }) {
  const t = useT()
  const { user, isMock } = session
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold tracking-tight text-content-primary">{t('Settings')}</h1>

      <Card className="space-y-2.5 p-4 text-sm">
        <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">{t('Account')}</h2>
        <Row label={t('Name')} value={user.firstName ?? '-'} />
        <Row label={t('Username')} value={user.username ? `@${user.username}` : '-'} />
        <Row label={t('Telegram ID')} value={String(user.telegramId)} />
        {isMock && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">{t('Dev mock account: nothing here is real.')}</p>}
      </Card>

      <LanguageCard />

      <Card className="space-y-2 p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">{t('Legal')}</h2>
        <LinkRow href="/terms.html" icon={FileText} label={t('Terms of Service')} />
        <LinkRow href="/privacy.html" icon={ShieldCheck} label={t('Privacy Policy')} />
      </Card>
    </div>
  )
}
