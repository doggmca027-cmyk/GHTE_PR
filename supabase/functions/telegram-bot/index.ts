// Supabase Edge Function (Deno): POST /telegram-bot   the bot's webhook (Telegram calls it; nobody else can: see the secret below)
//
//   /start               -> a welcome with the button that opens the Mini App (WEB_APP_URL)
//   hub_retry:<provider> / hub_fallback:<order>  -> the order hub buttons of the admins' messages (admins only): the provider's queue is run
//                           through sync-order-status { hubProviderId }, or the order moves to another provider of its card first
//
// Telegram adds X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET to every call (set with setWebhook): anything else is refused.
// The answer is always 200 for Telegram's calls, so a failure is never retried in a loop; failures are logged.
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WEB_APP_URL (optional). Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { instrument, json, readJson } from '../_shared/http.ts'
import { handleBotUpdate, webhookSecretOk, type BotPorts } from '../_shared/telegram-bot.ts'
import { hubRunReply, usd, type HubRunResult } from '../_shared/order-hub.ts'

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
  // the queue of one provider, run by the order worker (it holds the provider adapters and the money rules)
  const runHub = async (providerId: string): Promise<string> => {
    const res = await fetch(`${supabaseUrl}/functions/v1/sync-order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ hubProviderId: providerId }),
      signal: AbortSignal.timeout(120_000),
    })
    const body = (await res.json().catch(() => null)) as (HubRunResult & { skipped?: string; error?: string }) | null
    if (body?.skipped) return '⏳ Очередь этого провайдера уже запускается, результат придёт отдельными сообщениями.'
    if (!res.ok || !body || body.error) return `⚠️ Не удалось запустить очередь${body?.error === 'provider_key_missing' ? ': у провайдера нет API-ключа' : ''}.`
    return hubRunReply(body)
  }
  const ports: BotPorts = {
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
    async isAdmin(telegramId) {
      const { data } = await db.from('users').select('id').eq('telegram_id', telegramId).eq('is_admin', true).eq('is_banned', false).maybeSingle()
      return Boolean(data)
    },
    hubRetry: runHub,
    async hubFallback(orderId) {
      const r = await rpc<{ ok: boolean; reason?: string; provider_id?: string; provider?: string; cost?: number }>('hub_reroute_order', { p_order_id: orderId })
      if (!r.ok) {
        return r.reason === 'not_waiting'
          ? 'ℹ️ Этот заказ уже не в Хабе (отправлен или возвращён).'
          : '🔀 У этой карточки нет другого провайдера, у которого сейчас хватает баланса. Пополните провайдера и нажмите 🚀.'
      }
      return `🔀 Заказ #${orderId.slice(0, 8)} переведён на <b>${r.provider}</b> (закуп ${usd(r.cost)}).\n${await runHub(String(r.provider_id))}`
    },
    later(work) {
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      const safe = work.catch((e) => log.error('order hub button failed', { err: e, error_code: 'hub_button_failed' }))
      try { runtime?.waitUntil?.(safe) } catch { /* the promise keeps running anyway */ }
    },
  }

  try {
    const outcome = await handleBotUpdate((await readJson(req, 65_536) ?? {}) as Parameters<typeof handleBotUpdate>[0], ports)
    if (outcome !== 'ignored') log.info('bot update', { outcome })
  } catch (e) {
    log.error('bot update failed', { err: e, error_code: 'bot_update_failed' })
  }
  return json({ ok: true })
}))
