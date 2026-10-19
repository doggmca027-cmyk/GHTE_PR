import { useState, type FormEvent } from 'react'
import { CheckCircle2, Loader2, Mail, Send } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { TelegramLoginWidget } from '@/components/auth/TelegramLoginWidget'
import { ERRORS, PASSWORD_MIN, WidgetHint, emailAuthEnabled } from '@/components/auth/WebSignIn'
import { tr, useLanguage, useT } from '@/i18n'
import { telegramBotUsername } from '@/lib/telegram-bot'
import type { AuthSession } from '@/services/api/auth'
import { WebAuthError, linkTelegram, requestLinkEmail, verifyLinkEmail, type TelegramWidgetUser } from '@/services/api/web-auth'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const inputClass =
  'w-full rounded-2xl border border-blue-100/70 bg-surface-sub px-4 py-3 text-[15px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-brand focus:bg-surface disabled:opacity-60'

function Linked({ text }: { text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-bold text-content-primary">
      <CheckCircle2 size={15} strokeWidth={2} className="shrink-0 text-emerald-600" /> <span className="truncate">{text}</span>
    </span>
  )
}

/**
 * The profile's connected accounts (web-auth LINK_*, migration 20261223000000): a Telegram account (through Telegram's Login Widget, on
 * the website) and an e-mail (a 6-digit code, with an optional password), so the same profile can be signed in either way. An account
 * that already has a profile of its own is refused, never merged. Each successful link hands back the profile's new session.
 */
export function ConnectedAccounts({ session, onSessionChange }: { session: AuthSession; onSessionChange: (s: AuthSession) => void }) {
  const t = useT()
  const { lang } = useLanguage()
  const { user } = session
  const bot = telegramBotUsername()
  const [busy, setBusy] = useState(false)
  const [linkingTelegram, setLinkingTelegram] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [codeFor, setCodeFor] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null); setDone(null)
    try {
      await work()
    } catch (e) {
      const err = e instanceof WebAuthError ? e : new WebAuthError('server', '')
      const left = err.code === 'code_invalid' && err.attemptsLeft !== undefined ? ` ${t('Attempts left: {n}.', { n: err.attemptsLeft })}` : ''
      setError(`${t(ERRORS[err.code])}${left}`)
    } finally {
      setBusy(false)
    }
  }

  const connectTelegram = (widget: TelegramWidgetUser) => {
    setLinkingTelegram(true)
    return run(async () => {
      onSessionChange(await linkTelegram(session, widget))
      setDone(tr('Telegram is connected.'))
    }).finally(() => setLinkingTelegram(false))
  }

  async function submitEmail(e: FormEvent) {
    e.preventDefault()
    if (codeFor === null) {
      if (!EMAIL_RE.test(email.trim())) { setError(t('Enter a valid e-mail address.')); return }
      return run(async () => { await requestLinkEmail(session, email.trim(), lang); setCodeFor(email.trim()) })
    }
    if (!/^\d{6}$/.test(code)) { setError(t('The code is 6 digits.')); return }
    if (password !== '' && password.length < PASSWORD_MIN) { setError(t('Password must be at least 8 characters.')); return }
    return run(async () => {
      onSessionChange(await verifyLinkEmail(session, codeFor, code, password || undefined))
      setCodeFor(null); setCode(''); setPassword('')
      setDone(tr('The e-mail is connected.'))
    })
  }

  return (
    <Card className="space-y-3 p-4 text-sm" data-testid="connected-accounts">
      <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">{t('Connected accounts')}</h2>

      <div className="space-y-2 rounded-2xl bg-surface-sub px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 font-semibold text-content-secondary"><Send size={15} strokeWidth={2} className="text-brand" /> Telegram</span>
          {user.telegramId !== null && <Linked text={user.username ? `@${user.username}` : String(user.telegramId)} />}
        </div>
        {user.telegramId === null && (
          !bot ? (
            <p className="text-[12px] text-content-muted">{t('Telegram sign-in is not available right now.')}</p>
          ) : (
            <>
              <p className="text-[12px] text-content-secondary">{t('Connect Telegram to sign in with one tap.')}</p>
              <TelegramLoginWidget bot={bot} onAuth={(w) => void connectTelegram(w)} />
              <WidgetHint />
            </>
          )
        )}
      </div>

      <div className="space-y-2 rounded-2xl bg-surface-sub px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 font-semibold text-content-secondary"><Mail size={15} strokeWidth={2} className="text-brand" /> {t('E-mail')}</span>
          {user.email && <Linked text={user.email} />}
        </div>
        {!user.email && (
          emailAuthEnabled() ? (
            <form className="space-y-2" onSubmit={(e) => void submitEmail(e)} noValidate>
              {codeFor === null ? (
                <>
                  <p className="text-[12px] text-content-secondary">{t('Connect an e-mail to sign in without Telegram.')}</p>
                  <input className={inputClass} type="email" autoComplete="email" placeholder={t('E-mail')} aria-label={t('E-mail')}
                    value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
                </>
              ) : (
                <>
                  <p className="text-[12px] font-medium text-brand-text">{t('We sent a 6-digit code to {email}.', { email: codeFor })}</p>
                  <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder={t('6-digit code')}
                    aria-label={t('6-digit code')} value={code} disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                  <input className={inputClass} type="password" autoComplete="new-password" placeholder={t('Password (optional, at least 8 characters)')}
                    aria-label={t('Password (optional, at least 8 characters)')} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
                </>
              )}
              <button type="submit" disabled={busy} className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-sm font-bold text-white active:scale-[0.98] disabled:opacity-60">
                {busy && <Loader2 size={16} className="animate-spin" />} {codeFor === null ? t('Send code') : t('Confirm')}
              </button>
            </form>
          ) : (
            <p className="text-[12px] text-content-muted">{t('Connecting an e-mail will be available soon.')}</p>
          )
        )}
      </div>

      {linkingTelegram && <p className="flex items-center gap-2 text-[13px] text-content-secondary"><Loader2 size={15} className="animate-spin" /> {t('Signing you in…')}</p>}
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>}
      {done && <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-[13px] font-semibold text-emerald-700">{t(done)}</p>}
    </Card>
  )
}
