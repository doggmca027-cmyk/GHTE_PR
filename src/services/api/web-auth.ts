// Client of the web-auth Edge Function: e-mail + password + 6-digit code, and the Telegram Login Widget, for the app opened in a
// regular browser. A successful sign-in returns the same session shape as telegram-auth (the same JWT, so every API works).
//
// Where the session is kept: in a regular browser it is remembered in localStorage (a desktop user must not be signed out by a
// refresh; the token expires on its own after 7 days and every server call re-checks bans). Inside Telegram nothing is stored:
// the Mini App signs in again from initData on every launch.

import { WebApp } from '@/lib/webapp'
import type { AuthSession } from './auth'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 20_000
export const WEB_SESSION_KEY = 'web_session_v1'

export type WebAuthErrorCode =
  | 'invalid_input' | 'invalid_credentials' | 'code_invalid' | 'code_expired' | 'code_locked' | 'code_cooldown' | 'already_registered'
  | 'rate_limited' | 'user_banned' | 'signups_paused' | 'email_unavailable' | 'email_failed' | 'telegram_invalid' | 'telegram_unavailable'
  | 'network' | 'server'

export class WebAuthError extends Error {
  readonly code: WebAuthErrorCode
  /** Seconds to wait (code_cooldown) or wrong attempts left (code_invalid), when the server says. */
  readonly retryAfter?: number
  readonly attemptsLeft?: number
  constructor(code: WebAuthErrorCode, message: string, extra: { retryAfter?: number; attemptsLeft?: number } = {}) {
    super(message)
    this.name = 'WebAuthError'
    this.code = code
    this.retryAfter = extra.retryAfter
    this.attemptsLeft = extra.attemptsLeft
  }
}

const KNOWN = new Set<WebAuthErrorCode>([
  'invalid_input', 'invalid_credentials', 'code_invalid', 'code_expired', 'code_locked', 'code_cooldown', 'already_registered', 'rate_limited',
  'user_banned', 'signups_paused', 'email_unavailable', 'email_failed', 'telegram_invalid', 'telegram_unavailable',
])

async function call<T>(body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new WebAuthError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/web-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new WebAuthError('network', 'Could not reach the server. Check your connection and retry.')
  }
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean; error?: string; message?: string; retryAfter?: number; attemptsLeft?: number }) | null
  if (res.ok && data?.success) return data
  const code = data?.error && KNOWN.has(data.error as WebAuthErrorCode) ? (data.error as WebAuthErrorCode) : 'server'
  throw new WebAuthError(code, code === 'server' ? 'Something went wrong on our side. Please try again.' : data?.message ?? 'Request refused.', {
    retryAfter: typeof data?.retryAfter === 'number' ? data.retryAfter : undefined,
    attemptsLeft: typeof data?.attemptsLeft === 'number' ? data.attemptsLeft : undefined,
  })
}

export interface CodeSent {
  codeSent: true
  email: string
  expiresInSeconds: number
}

type SessionBody = Omit<AuthSession, 'isMock'>
const toSession = (b: SessionBody): AuthSession => ({ token: b.token, expiresAt: b.expiresAt, user: b.user, wallet: b.wallet, isMock: false })

/** Step 1 of sign-up: a 6-digit code is e-mailed (the answer is the same if the address is already registered). */
export const registerWithEmail = (email: string, password: string, opts: { referralCode?: string | null; lang?: string } = {}) =>
  call<CodeSent>({ action: 'REGISTER', email, password, referralCode: opts.referralCode ?? null, lang: opts.lang ?? null })

/** Step 2 of sign-up (register_verify) or a passwordless sign-in (login_code): the code -> a session. */
export async function verifyEmailCode(email: string, code: string, purpose: 'register_verify' | 'login_code'): Promise<AuthSession & { created: boolean }> {
  const r = await call<SessionBody & { created: boolean }>({ action: 'VERIFY_CODE', email, code, purpose })
  return { ...toSession(r), created: r.created === true }
}

export async function loginWithPassword(email: string, password: string): Promise<AuthSession> {
  return toSession(await call<SessionBody>({ action: 'LOGIN_PASSWORD', email, password }))
}

/** A code for a passwordless sign-in or for a password reset. */
export const requestEmailCode = (email: string, purpose: 'login_code' | 'reset_password', lang?: string) =>
  call<CodeSent>({ action: 'REQUEST_CODE', email, purpose, lang: lang ?? null })

export async function resetPassword(email: string, code: string, newPassword: string): Promise<AuthSession> {
  return toSession(await call<SessionBody>({ action: 'RESET_PASSWORD', email, code, newPassword }))
}

/** The object the Telegram Login Widget hands to its callback (data-onauth). */
export interface TelegramWidgetUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

export async function loginWithTelegramWidget(widget: TelegramWidgetUser): Promise<AuthSession> {
  return toSession(await call<SessionBody>({ action: 'TELEGRAM_WIDGET_LOGIN', widget }))
}

// ---- remembering the session in a regular browser ---------------------------------------------------------------------------

/** True inside Telegram (a Mini App launch carries initData); then nothing is persisted. */
export const insideTelegram = (): boolean => Boolean(WebApp.initData)

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function saveWebSession(session: AuthSession): void {
  if (insideTelegram() || session.isMock) return
  try {
    storage()?.setItem(WEB_SESSION_KEY, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, user: session.user, wallet: session.wallet }))
  } catch { /* private mode: the session lasts for this tab only */ }
}

/** The remembered session if it is still valid for at least a minute; an expired or malformed one is removed. */
export function loadWebSession(nowSeconds = Date.now() / 1000): AuthSession | null {
  if (insideTelegram()) return null
  const s = storage()
  try {
    const raw = s?.getItem(WEB_SESSION_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SessionBody>
    if (typeof v.token !== 'string' || typeof v.expiresAt !== 'number' || !v.user || typeof v.user.id !== 'string' || !v.wallet || v.expiresAt - nowSeconds < 60) {
      s?.removeItem(WEB_SESSION_KEY)
      return null
    }
    return toSession(v as SessionBody)
  } catch {
    s?.removeItem(WEB_SESSION_KEY)
    return null
  }
}

export function clearWebSession(): void {
  try {
    storage()?.removeItem(WEB_SESSION_KEY)
  } catch { /* ignore */ }
}
