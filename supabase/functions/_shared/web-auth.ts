// The web sign-in (e-mail + password + 6-digit code, and the Telegram Login Widget for browsers): request parsing, the Telegram
// widget signature, and the whole flow behind ports, so it runs unchanged in the Edge Function and in tests against the real SQL.
// Every rule about codes (lifetime, attempts, one a minute, five an hour, who exists) lives in the SQL functions; this module adds
// the per-IP / per-address limits, password checks and the session.

import { timingSafeEqual } from './telegram.ts'
import {
  burnPasswordCheck, generateOtpCode, hashOtpCode, hashPassword, isOtpCode, isValidEmail, needsRehash, normalizeEmail, passwordProblem,
  verifyPassword, type CodePurpose,
} from './web-auth-crypto.ts'
import { emailLang, type CodeEmail, type SendOutcome } from './email-sender.ts'

export const CODE_TTL_SECONDS = 10 * 60
/** Web sessions last a week (a desktop browser should not sign out on every refresh); every RPC still re-checks bans. */
export const WEB_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
export const LIMITS = {
  /** any web-auth request from one address */
  ip: { limit: 40, windowSeconds: 10 * 60 },
  /** wrong passwords for one account before password sign-in pauses */
  passwordFailures: { limit: 10, windowSeconds: 15 * 60 },
}

export type WebAuthRequest =
  | { action: 'REGISTER'; email: string; password: string; referralCode: string | null; lang: string | null }
  | { action: 'VERIFY_CODE'; email: string; code: string; purpose: 'register_verify' | 'login_code' }
  | { action: 'LOGIN_PASSWORD'; email: string; password: string }
  | { action: 'REQUEST_CODE'; email: string; purpose: 'login_code' | 'reset_password'; lang: string | null }
  | { action: 'RESET_PASSWORD'; email: string; code: string; newPassword: string }
  | { action: 'TELEGRAM_WIDGET_LOGIN'; widget: TelegramWidgetPayload }

export interface TelegramWidgetPayload {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

type Obj = Record<string, unknown>
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)

/** A referral code as typed, from a link ("ref_<code>") or bare; null when absent or malformed (it is optional). */
export function normalizeReferral(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const code = raw.trim().toLowerCase().replace(/^ref_/, '')
  return /^[a-z0-9]{6,32}$/.test(code) ? code : null
}

/** Validates the body. Unknown fields are ignored; nothing is echoed back. */
export function parseWebAuthRequest(body: unknown): WebAuthRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : ''
  const lang = str(b.lang, 10)

  if (action === 'TELEGRAM_WIDGET_LOGIN') {
    const w = (typeof b.widget === 'object' && b.widget !== null ? b.widget : b) as Obj
    const id = Number(w.id)
    const authDate = Number(w.auth_date)
    if (!Number.isSafeInteger(id) || id <= 0) return { error: 'Invalid Telegram data.' }
    if (!Number.isSafeInteger(authDate) || authDate <= 0) return { error: 'Invalid Telegram data.' }
    if (typeof w.hash !== 'string' || !/^[0-9a-f]{64}$/.test(w.hash)) return { error: 'Invalid Telegram data.' }
    const widget: TelegramWidgetPayload = { id, auth_date: authDate, hash: w.hash }
    for (const k of ['first_name', 'last_name', 'username', 'photo_url'] as const) {
      if (w[k] === undefined || w[k] === null) continue
      const v = str(w[k], 512)
      if (v === null) return { error: 'Invalid Telegram data.' }
      widget[k] = v
    }
    return { action, widget }
  }

  if (!isValidEmail(b.email)) return { error: 'Enter a valid e-mail address.' }
  const email = normalizeEmail(b.email as string)

  if (action === 'REGISTER') {
    const problem = passwordProblem(b.password)
    if (problem) return { error: problem }
    return { action, email, password: b.password as string, referralCode: normalizeReferral(b.referralCode), lang }
  }
  if (action === 'LOGIN_PASSWORD') {
    if (typeof b.password !== 'string' || b.password.length === 0 || b.password.length > 128) return { error: 'Enter your password.' }
    return { action, email, password: b.password }
  }
  if (action === 'REQUEST_CODE') {
    if (b.purpose !== 'login_code' && b.purpose !== 'reset_password') return { error: 'purpose must be login_code or reset_password.' }
    return { action, email, purpose: b.purpose, lang }
  }
  if (action === 'VERIFY_CODE') {
    if (!isOtpCode(b.code)) return { error: 'The code is 6 digits.' }
    if (b.purpose !== 'register_verify' && b.purpose !== 'login_code') return { error: 'purpose must be register_verify or login_code.' }
    return { action, email, code: b.code, purpose: b.purpose }
  }
  if (action === 'RESET_PASSWORD') {
    if (!isOtpCode(b.code)) return { error: 'The code is 6 digits.' }
    const problem = passwordProblem(b.newPassword)
    if (problem) return { error: problem }
    return { action, email, code: b.code, newPassword: b.newPassword as string }
  }
  return { error: 'Unknown action.' }
}

const encoder = new TextEncoder()
const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The Telegram Login Widget check (https://core.telegram.org/widgets/login#checking-authorization): HMAC-SHA-256 of the sorted
 * "key=value" lines under SHA-256(bot token), and a recent auth_date (a captured payload cannot be replayed forever).
 */
export async function verifyTelegramWidget(
  w: TelegramWidgetPayload, botToken: string, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = 86_400,
): Promise<boolean> {
  if (w.auth_date > nowSeconds + 60 || nowSeconds - w.auth_date > maxAgeSeconds) return false
  const fields: Record<string, string> = { id: String(w.id), auth_date: String(w.auth_date) }
  for (const k of ['first_name', 'last_name', 'username', 'photo_url'] as const) if (w[k] !== undefined) fields[k] = w[k]!
  const dataCheck = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secret = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(botToken) as BufferSource))
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheck) as BufferSource)))
  return timingSafeEqual(encoder.encode(mac), encoder.encode(w.hash))
}

/** The caller's address as the platform reports it (first X-Forwarded-For hop), hashed so the limiter never stores raw IPs. */
export async function clientKey(headers: Headers, salt: string): Promise<string> {
  const ip = (headers.get('cf-connecting-ip') ?? headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown').trim()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}|${ip}`) as BufferSource))
  return toHex(digest).slice(0, 32)
}

// ---- the flow ------------------------------------------------------------------------------------------------------------------

export interface WebUser {
  id: string
  telegram_id: number | string | null
  email: string | null
  username: string | null
  first_name: string | null
  language_code: string | null
  is_banned: boolean
  is_admin: boolean
}

export interface IssueResult { status: 'issued' | 'suppressed' | 'cooldown' | 'rate_limited'; retry_after?: number }
export interface VerifyResult { status: 'ok' | 'invalid' | 'expired' | 'locked' | 'already_registered'; attempts_left?: number; user?: WebUser; referral_applied?: boolean }

export interface WebAuthPorts {
  /** auth_rate_hit(): true = allowed (and counted). */
  rateHit(bucket: string, limit: number, windowSeconds: number): Promise<boolean>
  issueCode(a: { email: string; purpose: CodePurpose; codeHash: string; ttlSeconds: number; pendingPasswordHash?: string; pendingReferralCode?: string | null }): Promise<IssueResult>
  verifyCode(a: { email: string; purpose: CodePurpose; codeHash: string; newPasswordHash?: string }): Promise<VerifyResult>
  /** The account behind an address, with its password hash (service role only). */
  findByEmail(email: string): Promise<(WebUser & { password_hash: string | null }) | null>
  updatePasswordHash(userId: string, hash: string): Promise<void>
  /** Creates or refreshes the account of a Telegram identity; 'signups_paused' when a NEW account is not allowed now. */
  upsertTelegramUser(w: TelegramWidgetPayload): Promise<WebUser | 'signups_paused'>
  /** Signs the session: the same HS256 JWT as telegram-auth (sub = users.id, role = authenticated), plus the wallet. */
  session(user: WebUser, method: 'email' | 'telegram_widget'): Promise<Record<string, unknown>>
  sendEmail(m: CodeEmail): Promise<SendOutcome>
  /** Can a code reach anyone here? (RESEND_API_KEY, or the local mock.) */
  emailReady: boolean
  codeSecret: string
  botToken: string | null
  ipKey: string
  now?: () => number
}

export interface WebAuthResponse { status: number; body: Record<string, unknown> }

const ok = (body: Record<string, unknown>): WebAuthResponse => ({ status: 200, body: { success: true, ...body } })
const no = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): WebAuthResponse =>
  ({ status, body: { success: false, error, message, ...extra } })

/** The same answer whether or not an account exists, so the endpoint cannot be used to discover addresses. */
const CODE_SENT = (email: string) => ok({ codeSent: true, email, expiresInSeconds: CODE_TTL_SECONDS })

async function sendCode(p: WebAuthPorts, email: string, purpose: 'register_verify' | 'login_code' | 'reset_password', lang: string | null, extra: { pendingPasswordHash?: string; pendingReferralCode?: string | null } = {}): Promise<WebAuthResponse> {
  if (!p.emailReady) return no(503, 'email_unavailable', 'E-mail sign-in is not available yet. Please sign in with Telegram.')
  const code = generateOtpCode()
  const issued = await p.issueCode({ email, purpose, codeHash: await hashOtpCode(email, purpose, code, p.codeSecret), ttlSeconds: CODE_TTL_SECONDS, ...extra })
  if (issued.status === 'cooldown') return no(429, 'code_cooldown', 'A code was sent a moment ago. Please wait before asking again.', { retryAfter: issued.retry_after ?? 60 })
  if (issued.status === 'rate_limited') return no(429, 'rate_limited', 'Too many codes for this address. Try again later.')
  if (issued.status === 'issued') {
    const sent = await p.sendEmail({ to: email, code, purpose, lang: emailLang(lang), minutes: CODE_TTL_SECONDS / 60 })
    if (sent === 'failed' || sent === 'unconfigured') return no(502, 'email_failed', 'We could not send the e-mail. Please try again in a minute.')
  }
  return CODE_SENT(email)
}

const codeFailure = (v: VerifyResult): WebAuthResponse => {
  if (v.status === 'expired') return no(400, 'code_expired', 'This code has expired. Ask for a new one.')
  if (v.status === 'locked') return no(400, 'code_locked', 'Too many wrong attempts. Ask for a new code.')
  if (v.status === 'already_registered') return no(409, 'already_registered', 'This address is already registered. Sign in instead.')
  return no(400, 'code_invalid', 'The code is not correct.', v.attempts_left !== undefined ? { attemptsLeft: v.attempts_left } : {})
}

export async function handleWebAuth(req: WebAuthRequest, p: WebAuthPorts): Promise<WebAuthResponse> {
  // one limit for every action from the same address (sign-in flooding, address probing)
  if (!(await p.rateHit(`ip:${p.ipKey}`, LIMITS.ip.limit, LIMITS.ip.windowSeconds))) {
    return no(429, 'rate_limited', 'Too many attempts. Please wait a few minutes.')
  }

  switch (req.action) {
    case 'REGISTER': {
      const pending = await hashPassword(req.password)
      return sendCode(p, req.email, 'register_verify', req.lang, { pendingPasswordHash: pending, pendingReferralCode: req.referralCode })
    }

    case 'REQUEST_CODE':
      return sendCode(p, req.email, req.purpose, req.lang)

    case 'VERIFY_CODE': {
      const v = await p.verifyCode({ email: req.email, purpose: req.purpose, codeHash: await hashOtpCode(req.email, req.purpose, req.code, p.codeSecret) })
      if (v.status !== 'ok' || !v.user) return codeFailure(v)
      if (v.user.is_banned) return no(403, 'user_banned', 'Your account is suspended.')
      return ok({ ...(await p.session(v.user, 'email')), created: req.purpose === 'register_verify', referralApplied: v.referral_applied === true })
    }

    case 'RESET_PASSWORD': {
      const v = await p.verifyCode({
        email: req.email, purpose: 'reset_password',
        codeHash: await hashOtpCode(req.email, 'reset_password', req.code, p.codeSecret), newPasswordHash: await hashPassword(req.newPassword),
      })
      if (v.status !== 'ok' || !v.user) return codeFailure(v)
      if (v.user.is_banned) return no(403, 'user_banned', 'Your account is suspended.')
      return ok({ ...(await p.session(v.user, 'email')), passwordChanged: true })
    }

    case 'LOGIN_PASSWORD': {
      if (!(await p.rateHit(`pwfail:${req.email}`, LIMITS.passwordFailures.limit, LIMITS.passwordFailures.windowSeconds))) {
        return no(429, 'rate_limited', 'Too many sign-in attempts for this account. Wait 15 minutes or sign in with an e-mail code.')
      }
      const user = await p.findByEmail(req.email)
      if (!user || !user.password_hash) {
        await burnPasswordCheck(req.password) // the same time as a real check: no hint that the address is unknown
        return no(401, 'invalid_credentials', 'Wrong e-mail or password.')
      }
      if (!(await verifyPassword(req.password, user.password_hash))) return no(401, 'invalid_credentials', 'Wrong e-mail or password.')
      if (user.is_banned) return no(403, 'user_banned', 'Your account is suspended.')
      if (needsRehash(user.password_hash)) await p.updatePasswordHash(user.id, await hashPassword(req.password)).catch(() => {})
      const { password_hash: _hash, ...safe } = user
      void _hash
      return ok({ ...(await p.session(safe, 'email')) })
    }

    case 'TELEGRAM_WIDGET_LOGIN': {
      if (!p.botToken) return no(503, 'telegram_unavailable', 'Telegram sign-in is not configured.')
      if (!(await verifyTelegramWidget(req.widget, p.botToken, Math.floor((p.now?.() ?? Date.now()) / 1000)))) {
        return no(401, 'telegram_invalid', 'The Telegram sign-in is invalid or expired. Try again.')
      }
      const user = await p.upsertTelegramUser(req.widget)
      if (user === 'signups_paused') return no(403, 'signups_paused', 'New registrations are temporarily closed. Please try again later.')
      if (user.is_banned) return no(403, 'user_banned', 'Your account is suspended.')
      return ok({ ...(await p.session(user, 'telegram_widget')) })
    }
  }
}

/** The public shape of the signed-in user (what the app's AuthSession.user holds). */
export const publicUser = (u: WebUser, isAdmin: boolean) => ({
  id: u.id,
  telegramId: u.telegram_id === null || u.telegram_id === undefined ? null : Number(u.telegram_id),
  email: u.email ?? null,
  username: u.username,
  firstName: u.first_name,
  languageCode: u.language_code,
  isAdmin,
})
