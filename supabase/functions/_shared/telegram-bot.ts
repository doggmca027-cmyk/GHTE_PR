// The bot's webhook (telegram-bot function), pure with injected ports so every path is testable.
//
//   /start auth_<token>       a website sign-in waits for this account: the challenge is opened by it (bot_login_open) and the bot asks
//                             "is this you?" with [Confirm] / [Cancel] (callback data auth_ok:<token> / auth_no:<token>)
//   [Confirm] / [Cancel]      accepted only from the account that opened it (bot_login_decide); the button answers with a pop-up and the
//                             message is replaced by the outcome; the website, which polls, signs in by itself
//   /start (anything else)    a short welcome with the button that opens the Mini App
// Texts in English, Russian or Ukrainian after the user's Telegram language.

import { parseHubCallback } from './order-hub.ts'
import { START_PREFIX, TOKEN_RE, sha256Hex, type BotLoginUser } from './web-auth.ts'

export type BotLang = 'en' | 'ru' | 'uk'
export const botLang = (code: string | null | undefined): BotLang => {
  const c = (code ?? '').toLowerCase()
  return c.startsWith('uk') ? 'uk' : c.startsWith('ru') || c.startsWith('be') || c.startsWith('kk') ? 'ru' : 'en'
}

const TEXT = {
  alert: {
    en: '⚠️ <b>Security alert: sign-in</b> ⚠️\n\nSomeone is signing in to your GRAM Hub account on the website with this Telegram.\n\nIf this is NOT you, press «Cancel». If it is you, press «Confirm» to finish signing in.',
    ru: '⚠️ <b>Подтверждение входа</b> ⚠️\n\nКто-то пытается войти в ваш аккаунт на сайте GRAM Hub через этот Telegram.\n\nЕсли это НЕ вы — нажмите «Отмена». Если это вы — нажмите «Подтвердить», чтобы завершить вход.',
    uk: '⚠️ <b>Підтвердження входу</b> ⚠️\n\nХтось намагається увійти у ваш акаунт на сайті GRAM Hub через цей Telegram.\n\nЯкщо це НЕ ви — натисніть «Скасувати». Якщо це ви — натисніть «Підтвердити», щоб завершити вхід.',
  },
  confirm: { en: '✅ Confirm', ru: '✅ Подтвердить', uk: '✅ Підтвердити' },
  cancel: { en: '❌ Cancel', ru: '❌ Отмена', uk: '❌ Скасувати' },
  signedIn: { en: '✅ You are signed in on the website.', ru: '✅ Вы успешно вошли в аккаунт на сайте!', uk: '✅ Ви успішно увійшли в акаунт на сайті!' },
  cancelled: { en: '❌ Sign-in cancelled. Nobody got into your account.', ru: '❌ Вход отменён. Никто не получил доступ к вашему аккаунту.', uk: '❌ Вхід скасовано. Ніхто не отримав доступу до вашого акаунта.' },
  popupOk: { en: 'Authorization successful!', ru: 'Вход подтверждён!', uk: 'Вхід підтверджено!' },
  popupCancelled: { en: 'Sign-in cancelled.', ru: 'Вход отменён.', uk: 'Вхід скасовано.' },
  expired: { en: 'This sign-in link has expired. Start again on the website.', ru: 'Ссылка для входа устарела. Начните вход на сайте заново.', uk: 'Посилання для входу застаріло. Почніть вхід на сайті знову.' },
  used: { en: 'This sign-in request is already finished.', ru: 'Этот запрос на вход уже завершён.', uk: 'Цей запит на вхід уже завершено.' },
  otherUser: { en: 'This sign-in request belongs to another Telegram account.', ru: 'Этот запрос на вход принадлежит другому аккаунту Telegram.', uk: 'Цей запит на вхід належить іншому акаунту Telegram.' },
  unknown: { en: 'This sign-in link is not valid. Start again on the website.', ru: 'Ссылка для входа недействительна. Начните вход на сайте заново.', uk: 'Посилання для входу недійсне. Почніть вхід на сайті знову.' },
  welcome: { en: '👋 Welcome to GRAM Hub: promotion for Telegram, Instagram, YouTube, TikTok and more, paid with TON.', ru: '👋 Добро пожаловать в GRAM Hub: продвижение в Telegram, Instagram, YouTube, TikTok и не только — с оплатой в TON.', uk: '👋 Ласкаво просимо до GRAM Hub: просування в Telegram, Instagram, YouTube, TikTok та інших — з оплатою в TON.' },
  open: { en: '🚀 Open the app', ru: '🚀 Открыть приложение', uk: '🚀 Відкрити застосунок' },
} as const

type OpenResult = 'ok' | 'expired' | 'used' | 'other_user' | 'unknown'
type DecideResult = 'confirmed' | 'cancelled' | 'expired' | 'used' | 'other_user' | 'unknown'

export interface BotPorts {
  /** bot_login_open(start hash, telegram id, user) */
  openLogin(startHash: string, user: BotLoginUser): Promise<OpenResult>
  /** bot_login_decide(start hash, telegram id, approve) */
  decideLogin(startHash: string, telegramId: number, approve: boolean): Promise<DecideResult>
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

const userOf = (u: TgUser): BotLoginUser => ({
  id: u.id,
  ...(u.first_name ? { first_name: u.first_name.slice(0, 64) } : {}),
  ...(u.last_name ? { last_name: u.last_name.slice(0, 64) } : {}),
  ...(u.username ? { username: u.username.slice(0, 64) } : {}),
  ...(u.language_code ? { language_code: u.language_code.slice(0, 10) } : {}),
})

const CALLBACK_RE = /^auth_(ok|no):([A-Za-z0-9_-]{32,64})$/

/** What the bot does with one update. Never throws on a strange update: it is ignored (Telegram must get a 200 either way). */
export async function handleBotUpdate(update: TgUpdate, p: BotPorts): Promise<'challenge' | 'decided' | 'welcome' | 'hub' | 'ignored'> {
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
    const m = CALLBACK_RE.exec(cb.data ?? '')
    const lang = botLang(cb.from.language_code)
    if (!m || cb.from.is_bot) {
      await p.telegram('answerCallbackQuery', { callback_query_id: cb.id })
      return 'ignored'
    }
    const approve = m[1] === 'ok'
    const result = await p.decideLogin(await sha256Hex(m[2]), cb.from.id, approve)
    const popup = result === 'confirmed' ? TEXT.popupOk[lang]
      : result === 'cancelled' ? TEXT.popupCancelled[lang]
        : result === 'expired' ? TEXT.expired[lang]
          : result === 'other_user' ? TEXT.otherUser[lang]
            : result === 'used' ? TEXT.used[lang] : TEXT.unknown[lang]
    await p.telegram('answerCallbackQuery', { callback_query_id: cb.id, text: popup, show_alert: result !== 'confirmed' && result !== 'cancelled' })
    // the question is replaced by its outcome (no buttons left to press twice); someone else's request is left as it is
    const chatId = cb.message?.chat?.id
    const messageId = cb.message?.message_id
    if (chatId !== undefined && messageId !== undefined && result !== 'other_user') {
      const text = result === 'confirmed' ? TEXT.signedIn[lang] : result === 'cancelled' ? TEXT.cancelled[lang] : popup
      await p.telegram('editMessageText', { chat_id: chatId, message_id: messageId, text })
    }
    return 'decided'
  }

  const msg = update.message
  const from = msg?.from
  const chatId = msg?.chat?.id
  if (!msg || !from || chatId === undefined || from.is_bot || msg.chat?.type !== 'private') return 'ignored'
  const text = (msg.text ?? '').trim()
  if (!/^\/start(@\w+)?(\s|$)/.test(text)) return 'ignored'
  const lang = botLang(from.language_code)
  const arg = text.split(/\s+/)[1] ?? ''

  if (arg.startsWith(START_PREFIX) && TOKEN_RE.test(arg.slice(START_PREFIX.length))) {
    const token = arg.slice(START_PREFIX.length)
    const result = await p.openLogin(await sha256Hex(token), userOf(from))
    if (result !== 'ok') {
      const reply = result === 'expired' ? TEXT.expired[lang] : result === 'used' ? TEXT.used[lang] : result === 'other_user' ? TEXT.otherUser[lang] : TEXT.unknown[lang]
      await p.telegram('sendMessage', { chat_id: chatId, text: reply })
      return 'challenge'
    }
    await p.telegram('sendMessage', {
      chat_id: chatId,
      text: TEXT.alert[lang],
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: TEXT.confirm[lang], callback_data: `auth_ok:${token}` },
        { text: TEXT.cancel[lang], callback_data: `auth_no:${token}` },
      ]] },
    })
    return 'challenge'
  }

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
