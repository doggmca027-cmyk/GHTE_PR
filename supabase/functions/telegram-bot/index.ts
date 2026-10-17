// Supabase Edge Function (Deno): POST /telegram-bot   the bot's webhook (Telegram calls it; nobody else can: see the secret below)
//
//   /start auth_<token>  -> the website sign-in question with [Confirm] / [Cancel]; the button decides it (logic: _shared/telegram-bot.ts)
//   /start               -> a welcome with the button that opens the Mini App (WEB_APP_URL)
//
// Telegram adds X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET to every call (set with setWebhook): anything else is refused.
// The answer is always 200 for Telegram's calls, so a failure is never retried in a loop; failures are logged.
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WEB_APP_URL (optional). Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { instrument, json, readJson } from '../_shared/http.ts'
import { handleBotUpdate, webhookSecretOk, type BotPorts } from '../_shared/telegram-bot.ts'

Deno.serve(instrument('telegram-bot', async (req: Request, { log }): Promise<Response> => {
  if (req.method !== 'POST') return json({ ok: false }, 405)
  if (!webhookSecretOk(req.headers.get('x-telegram-bot-api-secret-token'), Deno.env.get('TELEGRAM_WEBHOOK_SECRET'))) {
    return json({ ok: false }, 401)
  }
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!token || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return json({ ok: true })
  }
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args)
    if (error) throw new Error(`${fn}: ${error.message}`)
    return data as T
  }
  const ports: BotPorts = {
    openLogin: (startHash, user) => rpc('bot_login_open', { p_start_hash: startHash, p_telegram_id: user.id, p_user: user }),
    decideLogin: (startHash, telegramId, approve) => rpc('bot_login_decide', { p_start_hash: startHash, p_telegram_id: telegramId, p_approve: approve }),
    async telegram(method, body) {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) log.warn('telegram call refused', { method, status: res.status, error_code: 'telegram_api' })
    },
    webAppUrl: Deno.env.get('WEB_APP_URL') ?? null,
  }

  try {
    const outcome = await handleBotUpdate((await readJson(req, 65_536) ?? {}) as Parameters<typeof handleBotUpdate>[0], ports)
    if (outcome !== 'ignored') log.info('bot update', { outcome })
  } catch (e) {
    log.error('bot update failed', { err: e, error_code: 'bot_update_failed' })
  }
  return json({ ok: true })
}))
