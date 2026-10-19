// The bot's webhook (telegram-bot function), pure with injected ports so every path is testable.
//
//   hub_retry / hub_fallback  the order hub buttons of the admins' messages (admins only)
//   /start                    a short welcome with the button that opens the Mini App
// The website signs in with Telegram's own Login Widget (web-auth), not through the bot (migration 20261223000000); a button of an old
// sign-in message is answered with nothing. Texts in English, Russian or Ukrainian after the user's Telegram language.

import { parseHubCallback } from './order-hub.ts'

export type BotLang = 'en' | 'ru' | 'uk'
export const botLang = (code: string | null | undefined): BotLang => {
  const c = (code ?? '').toLowerCase()
  return c.startsWith('uk') ? 'uk' : c.startsWith('ru') || c.startsWith('be') || c.startsWith('kk') ? 'ru' : 'en'
}

const TEXT = {
  welcome: { en: '👋 Welcome to GRAM Hub: promotion for Telegram, Instagram, YouTube, TikTok and more, paid with TON.', ru: '👋 Добро пожаловать в GRAM Hub: продвижение в Telegram, Instagram, YouTube, TikTok и не только — с оплатой в TON.', uk: '👋 Ласкаво просимо до GRAM Hub: просування в Telegram, Instagram, YouTube, TikTok та інших — з оплатою в TON.' },
  open: { en: '🚀 Open the app', ru: '🚀 Открыть приложение', uk: '🚀 Відкрити застосунок' },
} as const

export interface BotPorts {
  /** A Bot API call (sendMessage, answerCallbackQuery, editMessageText). */
  telegram(method: string, body: Record<string, unknown>): Promise<void>
  /** The Mini App's address, for the welcome button (none: no button). */
  webAppUrl: string | null
  /** The order hub buttons of the admins' messages (order-hub.ts). Without these ports the buttons are refused. */
  isAdmin?(telegramId: number): Promise<boolean>
  /** 🚀: read the provider's balance and send its waiting orders; resolves the reply (HTML). */
  hubRetry?(providerId: string): Promise<string>
  /** 🔀: move a waiting order to another provider of the card that can pay now, and send it; resolves the reply (HTML). */
  hubFallback?(orderId: string): Promise<string>
  /** Runs work after Telegram got its 200 (EdgeRuntime.waitUntil): a queue run can take longer than Telegram waits for a webhook. */
  later?(work: Promise<unknown>): void
}

interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string; language_code?: string }
interface TgUpdate {
  message?: { chat?: { id: number; type?: string }; from?: TgUser; text?: string }
  callback_query?: { id: string; from: TgUser; data?: string; message?: { chat?: { id: number }; message_id?: number } }
}

/** What the bot does with one update. Never throws on a strange update: it is ignored (Telegram must get a 200 either way). */
export async function handleBotUpdate(update: TgUpdate, p: BotPorts): Promise<'welcome' | 'hub' | 'ignored'> {
  const cb = update.callback_query
  const hub = cb ? parseHubCallback(cb.data) : null
  if (cb && hub) {
    // an order hub button: only an admin may press it (the message went to admins only, but a forwarded one has the same buttons)
    if (cb.from.is_bot || !p.isAdmin || !p.hubRetry || !p.hubFallback || !(await p.isAdmin(cb.from.id))) {
      await p.telegram('answerCallbackQuery', { callback_query_id: cb.id, text: 'Только для администратора.', show_alert: true })
      return 'ignored'
    }
    await p.telegram('answerCallbackQuery', { callback_query_id: cb.id, text: hub.action === 'retry' ? '⏳ Проверяю баланс и запускаю очередь…' : '⏳ Ищу другого провайдера…' })
    const chatId = cb.message?.chat?.id ?? cb.from.id
    const retry = p.hubRetry
    const fallback = p.hubFallback
    const work = (async () => {
      let text: string
      try {
        text = hub.action === 'retry' ? await retry(hub.providerId) : await fallback(hub.orderId)
      } catch {
        text = '⚠️ Не получилось выполнить. Попробуйте ещё раз через минуту.'
      }
      await p.telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' })
    })()
    if (p.later) p.later(work)
    else await work
    return 'hub'
  }
  if (cb) {
    // any other button (an old sign-in question): stop its spinner, nothing else
    await p.telegram('answerCallbackQuery', { callback_query_id: cb.id })
    return 'ignored'
  }

  const msg = update.message
  const from = msg?.from
  const chatId = msg?.chat?.id
  if (!msg || !from || chatId === undefined || from.is_bot || msg.chat?.type !== 'private') return 'ignored'
  const text = (msg.text ?? '').trim()
  if (!/^\/start(@\w+)?(\s|$)/.test(text)) return 'ignored'
  const lang = botLang(from.language_code)
  await p.telegram('sendMessage', {
    chat_id: chatId,
    text: TEXT.welcome[lang],
    ...(p.webAppUrl ? { reply_markup: { inline_keyboard: [[{ text: TEXT.open[lang], web_app: { url: p.webAppUrl } }]] } } : {}),
  })
  return 'welcome'
}

/** Telegram signs every webhook call with the secret given to setWebhook (X-Telegram-Bot-Api-Secret-Token). Constant-time compare. */
export function webhookSecretOk(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header || header.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < secret.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i)
  return diff === 0
}
