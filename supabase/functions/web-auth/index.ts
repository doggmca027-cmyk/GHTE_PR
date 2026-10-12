// Supabase Edge Function (Deno): POST /web-auth   (no JWT yet: this is where a browser gets one)
//
//   { action: "REGISTER", email, password, referralCode?, lang? }        -> { success, codeSent, email, expiresInSeconds }
//   { action: "VERIFY_CODE", email, code, purpose: "register_verify" | "login_code" }
//                                                                        -> { success, token, expiresAt, user, wallet, created, referralApplied }
//   { action: "LOGIN_PASSWORD", email, password }                        -> { success, token, expiresAt, user, wallet }
//   { action: "REQUEST_CODE", email, purpose: "login_code" | "reset_password", lang? }
//                                                                        -> { success, codeSent, email, expiresInSeconds }
//   { action: "RESET_PASSWORD", email, code, newPassword }               -> { success, token, expiresAt, user, wallet, passwordChanged }
//   { action: "TELEGRAM_WIDGET_LOGIN", widget: { id, first_name?, last_name?, username?, photo_url?, auth_date, hash } }
//                                                                        -> { success, token, expiresAt, user, wallet }
//
// The token is the same HS256 JWT telegram-auth issues (sub = users.id, role/aud = authenticated), so every other function, RLS
// policy and RPC works unchanged for web users. "Code sent" answers are identical whether or not the address has an account.
// Limits: 40 requests / 10 min per client address; codes: 1 a minute and 5 an hour per address, 10 minutes of life, 5 attempts;
// password sign-in: 10 attempts / 15 min per account.
//
// Secrets: JWT_SECRET, TELEGRAM_BOT_TOKEN (widget), RESEND_API_KEY + EMAIL_FROM (e-mail; without them e-mail sign-in answers 503),
// EMAIL_CODE_SECRET (optional, HMAC key of the codes; defaults to JWT_SECRET). Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { parseAdminIds } from '../_shared/admin.ts'
import { emailConfigured, sendCodeEmail } from '../_shared/email-sender.ts'
import { corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { signJwt } from '../_shared/jwt.ts'
import { signupGate } from '../_shared/signup-gate.ts'
import { WEB_TOKEN_TTL_SECONDS, clientKey, handleWebAuth, parseWebAuthRequest, publicUser, type WebAuthPorts, type WebUser } from '../_shared/web-auth.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const USER_COLUMNS = 'id, telegram_id, email, username, first_name, language_code, is_banned, is_admin'

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

Deno.serve(instrument('web-auth', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const parsed = parseWebAuthRequest(await readJson(req, 8192))
  if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? null
  const adminIds = parseAdminIds(Deno.env.get('ADMIN_TELEGRAM_IDS'))

  const ports: WebAuthPorts = {
    async rateHit(bucket, limit, windowSeconds) {
      return must(await db.rpc('auth_rate_hit', { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds }), 'rate limit') === true
    },
    async issueCode(a) {
      return must(await db.rpc('web_auth_issue_code', {
        p_email: a.email, p_purpose: a.purpose, p_code_hash: a.codeHash, p_ttl_seconds: a.ttlSeconds,
        p_pending_password_hash: a.pendingPasswordHash ?? null, p_pending_referral_code: a.pendingReferralCode ?? null,
      }), 'issue code')
    },
    async verifyCode(a) {
      return must(await db.rpc('web_auth_verify_code', { p_email: a.email, p_purpose: a.purpose, p_code_hash: a.codeHash, p_new_password_hash: a.newPasswordHash ?? null }), 'verify code')
    },
    async findByEmail(email) {
      return must(await db.from('users').select(`${USER_COLUMNS}, password_hash`).eq('email', email).maybeSingle(), 'find user')
    },
    async updatePasswordHash(userId, hash) {
      must(await db.from('users').update({ password_hash: hash }).eq('id', userId).select('id'), 'rehash')
    },
    async upsertTelegramUser(w) {
      const known = must(await db.from('users').select('id').eq('telegram_id', w.id).maybeSingle(), 'find telegram user')
      if (!known) {
        const gate = must(await db.from('platform_settings').select('global_signups_enabled').eq('id', 1).maybeSingle(), 'signup gate') as { global_signups_enabled?: boolean } | null
        if (signupGate(false, gate?.global_signups_enabled) === 'paused') return 'signups_paused'
      }
      // is_banned is never part of the payload, so signing in never lifts a suspension (same as telegram-auth)
      return must(await db.from('users').upsert(
        { telegram_id: w.id, username: w.username ?? null, first_name: w.first_name ?? null },
        { onConflict: 'telegram_id' },
      ).select(USER_COLUMNS).single(), 'upsert telegram user')
    },
    async session(user: WebUser, method) {
      let isAdmin = user.is_admin === true
      // the ADMIN_TELEGRAM_IDS bootstrap only for an identity Telegram itself just proved
      if (!isAdmin && method === 'telegram_widget' && user.telegram_id !== null && adminIds.has(Number(user.telegram_id))) {
        const { error } = await db.from('users').update({ is_admin: true }).eq('id', user.id)
        if (!error) isAdmin = true
      }
      const wallet = must(await db.from('wallets').select('balance, currency').eq('user_id', user.id).single(), 'wallet') as { balance: number | string; currency: string }
      const { token, expiresAt } = await signJwt(
        { sub: user.id, role: 'authenticated', aud: 'authenticated', telegram_id: user.telegram_id === null ? null : Number(user.telegram_id), amr: method },
        jwtSecret,
        WEB_TOKEN_TTL_SECONDS,
      )
      log.bind({ userId: user.id })
      log.info('signed in', { method })
      return { token, expiresAt, user: publicUser(user, isAdmin), wallet: { balance: Number(wallet.balance), currency: wallet.currency } }
    },
    sendEmail: (m) => sendCodeEmail(m, { env: Deno.env, log }),
    emailReady: emailConfigured(Deno.env),
    codeSecret: Deno.env.get('EMAIL_CODE_SECRET') ?? jwtSecret,
    botToken,
    ipKey: await clientKey(req.headers, jwtSecret),
  }

  try {
    const r = await handleWebAuth(parsed, ports)
    return json(r.body, r.status)
  } catch (e) {
    const message = e instanceof Error ? e.message : ''
    if (/signups_paused/.test(message)) return fail(403, 'signups_paused', 'New registrations are temporarily closed. Please try again later.')
    log.error('web-auth failed', { err: e, error_code: 'server_error', action: parsed.action })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
