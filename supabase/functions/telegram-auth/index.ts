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

const TOKEN_TTL_SECONDS = 60 * 60
const MAX_INIT_DATA_LENGTH = 4096

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!botToken || !jwtSecret || !supabaseUrl || !serviceKey) {
    console.error('telegram-auth: missing required environment configuration')
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
    console.error('telegram-auth: verification crashed', e)
    return json({ error: 'internal_error' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const tg = verified.user

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
    console.error('telegram-auth: user upsert failed', userError)
    return json({ error: 'internal_error' }, 500)
  }
  if (user.is_banned) return json({ error: 'user_banned' }, 403)

  // Bootstrap: a Telegram id listed in ADMIN_TELEGRAM_IDS (and cryptographically proven by initData)
  // is promoted once. The DB flag stays the source of truth; every admin RPC re-checks it, and
  // removing an id from this list does not demote anyone.
  let isAdmin = user.is_admin === true
  if (!isAdmin && parseAdminIds(Deno.env.get('ADMIN_TELEGRAM_IDS')).has(Number(user.telegram_id))) {
    const { error: promoteError } = await supabase.from('users').update({ is_admin: true }).eq('id', user.id)
    if (promoteError) console.error('telegram-auth: admin bootstrap failed', promoteError)
    else isAdmin = true
  }

  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('balance, currency')
    .eq('user_id', user.id)
    .single()
  if (walletError || !wallet) {
    console.error('telegram-auth: wallet lookup failed', walletError)
    return json({ error: 'internal_error' }, 500)
  }

  const { token, expiresAt } = await signJwt(
    { sub: user.id, role: 'authenticated', aud: 'authenticated', telegram_id: user.telegram_id },
    jwtSecret,
    TOKEN_TTL_SECONDS,
  )

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
})
