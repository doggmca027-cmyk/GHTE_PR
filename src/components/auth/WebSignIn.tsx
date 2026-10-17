import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Loader2, Mail } from 'lucide-react'
import { tr, useLanguage, useT } from '@/i18n'
import { legalDocPath } from '@/lib/legal'
import { telegramBotUsername } from '@/lib/telegram-bot'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import {
  WebAuthError,
  loginWithPassword,
  loginWithTelegramWidget,
  registerWithEmail,
  requestEmailCode,
  resetPassword,
  verifyEmailCode,
  type TelegramWidgetUser,
  type WebAuthErrorCode,
} from '@/services/api/web-auth'
import { TelegramLoginWidget } from './TelegramLoginWidget'

export const PASSWORD_MIN = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const CODE_RE = /^\d{6}$/

/** What the customer reads for each refusal of the server (in their language). */
const ERRORS: Record<WebAuthErrorCode, string> = {
  invalid_input: tr('Please check what you entered.'),
  invalid_credentials: tr('Wrong e-mail or password.'),
  code_invalid: tr('Wrong code.'),
  code_expired: tr('The code has expired. Request a new one.'),
  code_locked: tr('Too many wrong codes. Request a new one.'),
  code_cooldown: tr('Please wait before requesting another code.'),
  already_registered: tr('This e-mail is already registered. Sign in instead.'),
  rate_limited: tr('Too many attempts. Please try again later.'),
  user_banned: tr('Your account is suspended.'),
  signups_paused: tr('New sign-ups are paused. Please try again later.'),
  email_unavailable: tr('Sign-in by e-mail is not available yet. Please use Telegram.'),
  email_failed: tr('We could not send the e-mail. Please try again.'),
  telegram_invalid: tr('Telegram sign-in failed. Please try again.'),
  telegram_unavailable: tr('Telegram sign-in is not available right now.'),
  network: tr('Could not reach the server. Check your connection and retry.'),
  server: tr('Something went wrong. Please try again.'),
}

type Mode =
  | { kind: 'signin' }
  | { kind: 'signup' }
  | { kind: 'code' }
  | { kind: 'reset' }
  /** A code was e-mailed: confirm it (sign-up / code sign-in) or set a new password with it (reset). */
  | { kind: 'verify'; purpose: 'register_verify' | 'login_code' | 'reset_password'; email: string }

const inputClass =
  'w-full rounded-2xl border border-blue-100/70 bg-surface-sub px-4 py-3 text-[15px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-brand focus:bg-surface disabled:opacity-60'

/**
 * Sign-in for the website (the app opened in a regular browser, outside Telegram): e-mail + password, a 6-digit code instead of the
 * password, sign-up with a confirmed e-mail, a password reset, and the Telegram Login Widget. Every way ends with the same session.
 */
export function WebSignIn({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  return emailAuthEnabled() ? <EmailSignIn onSignedIn={onSignedIn} /> : <TelegramSignIn onSignedIn={onSignedIn} />
}

/**
 * E-mail sign-in is off until the e-mails can be sent (Resend secrets on the server): VITE_ENABLE_EMAIL_AUTH=true turns the forms on.
 * Until then the website signs in with Telegram only, so no field is shown that cannot work.
 */
export const emailAuthEnabled = (env: Record<string, unknown> = import.meta.env): boolean => env.VITE_ENABLE_EMAIL_AUTH === 'true'

function Brand() {
  const t = useT()
  return (
    <header className="text-center">
      <p className="text-2xl font-extrabold tracking-tight text-content-primary">GRAM Hub</p>
      <p className="mt-1 text-sm text-content-secondary">{t('Promotion for Telegram, Instagram, YouTube, TikTok and more, paid with TON.')}</p>
    </header>
  )
}

function LegalFooter() {
  const t = useT()
  const { lang } = useLanguage()
  return (
    <footer className="space-y-1 text-center text-[12px] text-content-secondary">
      <p>{t('By continuing you accept our terms.')}</p>
      <p className="space-x-3 font-semibold">
        <a className="text-brand" href={legalDocPath('terms', lang)}>{t('Terms of Service')}</a>
        <a className="text-brand" href={legalDocPath('privacy', lang)}>{t('Privacy Policy')}</a>
        <a className="text-brand" href={`${legalDocPath('terms', lang)}#orders`}>{t('Refunds')}</a>
      </p>
    </footer>
  )
}

/** The website's sign-in while e-mail is off: one Telegram button, nothing else to fill in. Signing in the first time creates the account. */
function TelegramSignIn({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  const t = useT()
  const bot = telegramBotUsername()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn(user: TelegramWidgetUser) {
    setBusy(true); setError(null)
    try {
      onSignedIn(await loginWithTelegramWidget(user))
    } catch (e) {
      setError(t(ERRORS[e instanceof WebAuthError ? e.code : 'server']))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-screen to-screen-end px-4 py-8">
      <main className="w-full max-w-sm space-y-5">
        <Brand />
        <section className="space-y-4 rounded-3xl bg-surface p-6 text-center shadow-card" aria-labelledby="signin-title">
          <div className="space-y-1.5">
            <h1 id="signin-title" className="text-lg font-extrabold text-content-primary">{t('Sign in with Telegram')}</h1>
            <p className="text-[13px] text-content-secondary">{t('One tap with your Telegram account: no password. The first sign-in creates your account.')}</p>
          </div>
          {bot ? (
            <TelegramLoginWidget bot={bot} onAuth={(user) => void signIn(user)} />
          ) : (
            <p role="status" className="rounded-xl bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-800">{t('Telegram sign-in is not available right now.')}</p>
          )}
          {busy && <p className="flex items-center justify-center gap-2 text-[13px] text-content-secondary"><Loader2 size={16} className="animate-spin" /> {t('Signing you in…')}</p>}
          {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>}
          {bot && (
            <p className="text-[12px] text-content-muted">
              {t('Prefer the app?')} <a className="font-semibold text-brand" href={`https://t.me/${bot}`}>{t('Open in Telegram')}</a>
            </p>
          )}
        </section>
        <LegalFooter />
      </main>
    </div>
  )
}

/** E-mail + password / code / reset, plus the Telegram widget (shown when VITE_ENABLE_EMAIL_AUTH=true). */
function EmailSignIn({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  const t = useT()
  const { lang } = useLanguage()
  const bot = telegramBotUsername()
  const [mode, setMode] = useState<Mode>({ kind: 'signin' })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const id = window.setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => window.clearTimeout(id)
  }, [cooldown])

  const go = (next: Mode) => { setMode(next); setError(null); setCode(''); if (next.kind !== 'verify') setPassword('') }
  const fail = (e: unknown) => {
    const err = e instanceof WebAuthError ? e : new WebAuthError('server', '')
    if (err.code === 'code_cooldown' && err.retryAfter) setCooldown(err.retryAfter)
    const left = err.code === 'code_invalid' && err.attemptsLeft !== undefined ? ` ${t('Attempts left: {n}.', { n: err.attemptsLeft })}` : ''
    setError(`${t(ERRORS[err.code])}${left}`)
  }
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null)
    try { await work() } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const emailOk = EMAIL_RE.test(email.trim())
  const check = (ok: boolean, message: string) => { if (!ok) setError(t(message)); return ok }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const address = email.trim()
    if (mode.kind !== 'verify' && !check(emailOk, tr('Enter a valid e-mail address.'))) return
    if (mode.kind === 'signin') {
      if (!check(password.length > 0, tr('Enter your password.'))) return
      return run(async () => onSignedIn(await loginWithPassword(address, password)))
    }
    if (mode.kind === 'signup') {
      if (!check(password.length >= PASSWORD_MIN, tr('Password must be at least 8 characters.'))) return
      return run(async () => {
        await registerWithEmail(address, password, { lang })
        setCooldown(60)
        go({ kind: 'verify', purpose: 'register_verify', email: address })
      })
    }
    if (mode.kind === 'code' || mode.kind === 'reset') {
      const purpose = mode.kind === 'code' ? 'login_code' : 'reset_password'
      return run(async () => {
        await requestEmailCode(address, purpose, lang)
        setCooldown(60)
        go({ kind: 'verify', purpose, email: address })
      })
    }
    // verify
    if (!check(CODE_RE.test(code.trim()), tr('The code is 6 digits.'))) return
    if (mode.purpose === 'reset_password') {
      if (!check(password.length >= PASSWORD_MIN, tr('Password must be at least 8 characters.'))) return
      return run(async () => onSignedIn(await resetPassword(mode.email, code.trim(), password)))
    }
    return run(async () => onSignedIn(await verifyEmailCode(mode.email, code.trim(), mode.purpose as 'register_verify' | 'login_code')))
  }

  async function resend() {
    if (mode.kind !== 'verify' || cooldown > 0 || busy) return
    if (mode.purpose === 'register_verify') return go({ kind: 'signup' }) // a new sign-up request sends a new code
    await run(async () => { await requestEmailCode(mode.email, mode.purpose as 'login_code' | 'reset_password', lang); setCooldown(60) })
  }

  const title =
    mode.kind === 'signup' ? t('Create account')
      : mode.kind === 'code' ? t('Sign in with a code')
        : mode.kind === 'reset' ? t('Reset password')
          : mode.kind === 'verify' ? t('Check your e-mail')
            : t('Sign in')
  const cta =
    mode.kind === 'signup' ? t('Create account')
      : mode.kind === 'code' || mode.kind === 'reset' ? t('Send code')
        : mode.kind === 'verify' ? (mode.purpose === 'reset_password' ? t('Save and sign in') : t('Confirm'))
          : t('Sign in')

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-screen to-screen-end px-4 py-8">
      <main className="w-full max-w-sm space-y-5">
        <Brand />

        <section className="space-y-4 rounded-3xl bg-surface p-5 shadow-card" aria-labelledby="signin-title">
          <div className="flex items-center gap-2">
            {mode.kind !== 'signin' && (
              <button type="button" onClick={() => go({ kind: 'signin' })} aria-label={t('Back')} className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-sub text-content-secondary">
                <ArrowLeft size={16} strokeWidth={2} />
              </button>
            )}
            <h1 id="signin-title" className="text-lg font-extrabold text-content-primary">{title}</h1>
          </div>

          <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
            {mode.kind === 'verify' ? (
              <>
                <p className="flex items-start gap-2 rounded-2xl bg-brand-light/60 px-3 py-2.5 text-[13px] font-medium text-brand-text">
                  <Mail size={16} strokeWidth={2} className="mt-0.5 shrink-0" /> {t('We sent a 6-digit code to {email}.', { email: mode.email })}
                </p>
                <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder={t('6-digit code')}
                  aria-label={t('6-digit code')} value={code} disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                {mode.purpose === 'reset_password' && (
                  <input className={inputClass} type="password" autoComplete="new-password" placeholder={t('New password (at least 8 characters)')}
                    aria-label={t('New password (at least 8 characters)')} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
                )}
              </>
            ) : (
              <>
                <input className={inputClass} type="email" autoComplete="email" placeholder={t('E-mail')} aria-label={t('E-mail')}
                  value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
                {(mode.kind === 'signin' || mode.kind === 'signup') && (
                  <input className={inputClass} type="password" autoComplete={mode.kind === 'signup' ? 'new-password' : 'current-password'}
                    placeholder={mode.kind === 'signup' ? t('Password (at least 8 characters)') : t('Password')}
                    aria-label={mode.kind === 'signup' ? t('Password (at least 8 characters)') : t('Password')}
                    value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
                )}
              </>
            )}

            {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>}

            <button type="submit" disabled={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[15px] font-bold text-white active:scale-[0.98] disabled:opacity-60">
              {busy && <Loader2 size={18} className="animate-spin" />} {cta}
            </button>
          </form>

          <div className="space-y-1.5 text-center text-[13px] font-semibold">
            {mode.kind === 'signin' && (
              <>
                <button type="button" className="block w-full text-brand" onClick={() => go({ kind: 'code' })}>{t('Sign in with a code instead')}</button>
                <button type="button" className="block w-full text-content-secondary" onClick={() => go({ kind: 'reset' })}>{t('Forgot password?')}</button>
                <button type="button" className="block w-full text-content-secondary" onClick={() => go({ kind: 'signup' })}>{t('No account yet? Create one')}</button>
              </>
            )}
            {mode.kind === 'signup' && <button type="button" className="block w-full text-content-secondary" onClick={() => go({ kind: 'signin' })}>{t('Already have an account? Sign in')}</button>}
            {mode.kind === 'verify' && (
              <button type="button" className={cn('block w-full', cooldown > 0 ? 'text-content-muted' : 'text-brand')} disabled={cooldown > 0 || busy} onClick={() => void resend()}>
                {cooldown > 0 ? t('Send the code again in {s} s', { s: cooldown }) : t('Send the code again')}
              </button>
            )}
          </div>

          {bot && mode.kind !== 'verify' && (
            <>
              <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-wide text-content-muted">
                <span className="h-px flex-1 bg-blue-100" /> {t('or')} <span className="h-px flex-1 bg-blue-100" />
              </div>
              <TelegramLoginWidget bot={bot} onAuth={(user) => void run(async () => onSignedIn(await loginWithTelegramWidget(user)))} />
            </>
          )}
        </section>

        <LegalFooter />
      </main>
    </div>
  )
}
