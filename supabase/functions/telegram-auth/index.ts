// Supabase Edge Function (Deno): POST { initData } -> { token, expiresAt, user, wallet }
//
// Secrets (supabase secrets set ...):
//   TELEGRAM_BOT_TOKEN   bot token used to verify initData
//   JWT_SECRET           project JWT secret (falls back to SUPABASE_JWT_SECRET)
//   ALLOWED_ORIGIN       optional CORS origin (default "*"; auth is by signed initData, not cookies)
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy with verify_jwt = false (see supabase/config.toml): callers have no JWT yet.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { TelegramAuthError, verifyInitData } from '../_shared/telegram.ts'
import { signJwt } from '../_shared/jwt.ts'
import { parseAdminIds } from '../_shared/admin.ts'
import { corsHeaders, instrument } from '../_shared/http.ts'
import { signupGate } from '../_shared/signup-gate.ts'

const TOKEN_TTL_SECONDS = 60 * 60
const MAX_INIT_DATA_LENGTH = 4096

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

Deno.serve(instrument('telegram-auth', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!botToken || !jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing required environment configuration', { error_code: 'server_misconfigured' })
    return json({ error: 'server_misconfigured' }, 500)
  }

  let initData: unknown
  try {
    ;({ initData } = await req.json())
  } catch {
    return json({ error: 'invalid_body' }, 400)
  }
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH) {
    return json({ error: 'invalid_body' }, 400)
  }

  let verified
  try {
    verified = await verifyInitData(initData, botToken)
  } catch (e) {
    if (e instanceof TelegramAuthError) return json({ error: e.code }, 401)
    log.error('initData verification crashed', { err: e, error_code: 'verification_crashed' })
    return json({ error: 'internal_error' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const tg = verified.user

  // Sign-up kill switch: while it is off only people who already have an account get in (see _shared/signup-gate.ts).
  const { data: known } = await supabase.from('users').select('id').eq('telegram_id', tg.id).maybeSingle()
  if (!known) {
    const { data: gate } = await supabase.from('platform_settings').select('global_signups_enabled').eq('id', 1).maybeSingle()
    if (signupGate(false, gate?.global_signups_enabled) === 'paused') {
      log.warn('sign-up refused: new registrations are switched off', { error_code: 'signups_paused' })
      return json({ error: 'signups_paused' }, 403)
    }
  }

  // is_banned is deliberately not part of the payload, so an upsert never un-bans anyone.
  const { data: user, error: userError } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: tg.id,
        username: tg.username ?? null,
        first_name: tg.first_name ?? null,
        language_code: tg.language_code ?? null,
      },
      { onConflict: 'telegram_id' },
    )
    .select('id, telegram_id, username, first_name, language_code, is_banned, is_admin')
    .single()
  if (userError || !user) {
    log.error('user upsert failed', { err: userError, error_code: 'user_upsert_failed' })
    return json({ error: 'internal_error' }, 500)
  }
  log.bind({ userId: user.id })
  if (user.is_banned) {
    log.warn('banned user refused', { error_code: 'user_banned' })
    return json({ error: 'user_banned' }, 403)
  }

  // Bootstrap: a Telegram id listed in ADMIN_TELEGRAM_IDS (and cryptographically proven by initData)
  // is promoted once. The DB flag stays the source of truth; every admin RPC re-checks it, and
  // removing an id from this list does not demote anyone.
  let isAdmin = user.is_admin === true
  if (!isAdmin && parseAdminIds(Deno.env.get('ADMIN_TELEGRAM_IDS')).has(Number(user.telegram_id))) {
    const { error: promoteError } = await supabase.from('users').update({ is_admin: true }).eq('id', user.id)
    if (promoteError) log.error('admin bootstrap failed', { err: promoteError, error_code: 'admin_bootstrap_failed' })
    else {
      isAdmin = true
      log.info('admin promoted from ADMIN_TELEGRAM_IDS')
    }
  }

  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('balance, currency')
    .eq('user_id', user.id)
    .single()
  if (walletError || !wallet) {
    log.error('wallet lookup failed', { err: walletError, error_code: 'wallet_lookup_failed' })
    return json({ error: 'internal_error' }, 500)
  }

  const { token, expiresAt } = await signJwt(
    { sub: user.id, role: 'authenticated', aud: 'authenticated', telegram_id: user.telegram_id },
    jwtSecret,
    TOKEN_TTL_SECONDS,
  )

  log.info('signed in')
  return json({
    token,
    expiresAt,
    user: {
      id: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      languageCode: user.language_code,
      isAdmin,
    },
    wallet: { balance: Number(wallet.balance), currency: wallet.currency },
  })
}))
