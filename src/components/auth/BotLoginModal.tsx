import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, RefreshCw, Send, ShieldCheck, X } from 'lucide-react'
import { tr, useLanguage, useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import type { AuthSession } from '@/services/api/auth'
import { WebAuthError, pollBotLogin, startBotLogin, type BotLoginStart } from '@/services/api/web-auth'

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; start: BotLoginStart; opened: boolean }
  | { kind: 'done' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

const ERRORS: Record<string, string> = {
  rate_limited: tr('Too many attempts. Please try again later.'),
  telegram_unavailable: tr('Telegram sign-in is not available right now.'),
  user_banned: tr('Your account is suspended.'),
  signups_paused: tr('New sign-ups are paused. Please try again later.'),
  network: tr('Could not reach the server. Check your connection and retry.'),
}

/** "@GHTE_PR_BOT" from https://t.me/GHTE_PR_BOT?start=... */
export const botHandle = (link: string): string => `@${/t\.me\/([A-Za-z0-9_]+)/.exec(link)?.[1] ?? 'Telegram'}`

/**
 * Sign-in for a website guest, confirmed in the Telegram bot: the bot link opens Telegram, the bot asks "is this you?" and the customer
 * presses Confirm; meanwhile this dialog asks the server every 2 s and signs in the moment it is confirmed (no page reload: whatever was
 * open stays open).
 */
export function BotLoginModal({ onSignedIn, onClose }: { onSignedIn: (session: AuthSession) => void; onClose: () => void }) {
  const t = useT()
  const { lang } = useLanguage()
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const attempt = useRef(0)

  const begin = useCallback(async () => {
    const mine = ++attempt.current
    setPhase({ kind: 'starting' })
    try {
      const start = await startBotLogin(lang)
      if (attempt.current !== mine) return
      // the click that opened this dialog still allows opening a window; if the browser says no, the button below does it
      let opened = false
      try { opened = window.open(start.link, '_blank', 'noopener') !== null } catch { /* blocked */ }
      setPhase({ kind: 'waiting', start, opened })
    } catch (e) {
      if (attempt.current !== mine) return
      const code = e instanceof WebAuthError ? e.code : 'server'
      setPhase({ kind: 'error', message: t(ERRORS[code] ?? tr('Something went wrong. Please try again.')) })
    }
  }, [lang, t])

  useEffect(() => { void begin(); return () => { attempt.current++ } }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // the poll: every pollSeconds while waiting, until confirmed / cancelled / expired (a network hiccup just waits for the next round)
  const waiting = phase.kind === 'waiting' ? phase.start : null
  useEffect(() => {
    if (!waiting) return
    let stop = false
    let timer: number | undefined
    const deadline = Date.now() + waiting.expiresInSeconds * 1000 + 30_000
    const tick = async () => {
      if (stop) return
      try {
        const r = await pollBotLogin(waiting.pollToken)
        if (stop) return
        if (r.status === 'confirmed') {
          haptic.success()
          setPhase({ kind: 'done' })
          onSignedIn(r.session)
          return
        }
        if (r.status === 'cancelled') { setPhase({ kind: 'cancelled' }); return }
        if (r.status === 'expired' || r.status === 'consumed' || r.status === 'unknown') { setPhase({ kind: 'expired' }); return }
      } catch (e) {
        if (e instanceof WebAuthError && e.code !== 'network' && e.code !== 'server' && e.code !== 'rate_limited') {
          setPhase({ kind: 'error', message: t(ERRORS[e.code] ?? tr('Something went wrong. Please try again.')) })
          return
        }
      }
      if (Date.now() > deadline) { setPhase({ kind: 'expired' }); return }
      timer = window.setTimeout(() => void tick(), waiting.pollSeconds * 1000)
    }
    timer = window.setTimeout(() => void tick(), waiting.pollSeconds * 1000)
    return () => { stop = true; window.clearTimeout(timer) }
  }, [waiting]) // eslint-disable-line react-hooks/exhaustive-deps

  // signed in: a moment to read "You are signed in.", then the dialog goes away (its own effect: the poll above is torn down by now)
  const done = phase.kind === 'done'
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(onClose, 900)
    return () => window.clearTimeout(timer)
  }, [done, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center animate-fade-in sm:items-center" role="dialog" aria-modal="true" aria-labelledby="bot-login-title">
      <button type="button" aria-label={t('Close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div className="relative z-10 w-full max-w-sm animate-sheet-up rounded-t-[32px] bg-surface px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-[0_-12px_40px_rgb(0,136,204,0.14)] sm:rounded-[28px]">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="bot-login-title" className="flex items-center gap-2 text-lg font-extrabold text-content-primary">
            <Send size={18} strokeWidth={2} className="text-brand" /> {t('Sign in with Telegram')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('Close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sub text-content-secondary active:scale-90">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {phase.kind === 'starting' && (
          <p className="flex items-center gap-2 py-6 text-sm text-content-secondary" role="status"><Loader2 size={18} className="animate-spin text-brand" /> {t('Preparing the sign-in…')}</p>
        )}

        {phase.kind === 'waiting' && (
          <div className="space-y-4" data-testid="bot-login-waiting">
            <ol className="space-y-2 text-[13px] text-content-secondary">
              <li className="flex gap-2"><span className="font-bold text-brand">1.</span> {t('Open {bot} in Telegram (it opens with the button below).', { bot: botHandle(phase.start.link) })}</li>
              <li className="flex gap-2"><span className="font-bold text-brand">2.</span> {t('Press «Confirm» in the bot\'s message.')}</li>
              <li className="flex gap-2"><span className="font-bold text-brand">3.</span> {t('Come back here: you will be signed in by yourself.')}</li>
            </ol>
            <a href={phase.start.link} target="_blank" rel="noopener noreferrer" onClick={() => haptic.tap()}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[15px] font-bold text-white active:scale-[0.98]">
              <Send size={17} strokeWidth={2} /> {t('Open Telegram')}
            </a>
            <p className="flex items-center justify-center gap-2 text-[13px] font-medium text-content-secondary" role="status">
              <Loader2 size={15} className="animate-spin text-brand" /> {t('Waiting for confirmation in Telegram…')}
            </p>
            <p className="flex items-start gap-2 rounded-2xl bg-surface-sub px-3 py-2.5 text-[12px] text-content-secondary">
              <ShieldCheck size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-brand" />
              {t('The bot only asks to confirm. Never press «Confirm» for a sign-in you did not start.')}
            </p>
          </div>
        )}

        {phase.kind === 'done' && (
          <p className="flex items-center gap-2 py-6 text-sm font-semibold text-emerald-700" role="status"><CheckCircle2 size={20} /> {t('You are signed in.')}</p>
        )}

        {(phase.kind === 'expired' || phase.kind === 'cancelled' || phase.kind === 'error') && (
          <div className="space-y-4 py-2">
            <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2.5 text-[13px] font-medium text-rose-700">
              {phase.kind === 'expired' ? t('The sign-in request has expired.') : phase.kind === 'cancelled' ? t('The sign-in was cancelled in Telegram.') : phase.message}
            </p>
            <button type="button" onClick={() => { haptic.tap(); void begin() }} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[15px] font-bold text-white active:scale-[0.98]">
              <RefreshCw size={16} strokeWidth={2} /> {t('Try again')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
