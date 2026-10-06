// Telegram Bot notifications. Pure + injected I/O so it runs in Deno, Node tests and the dev mock.
//
// Hard rules:
//   * Notifications are BEST EFFORT and never throw: a blocked bot, a Telegram outage or a bug here
//     must not roll back or fail a payment / order.
//   * Every message is deduplicated by a key, so re-verifying a deposit or re-syncing an order
//     can never notify twice.
//   * All dynamic text is HTML-escaped; the bot token never appears in logs or results.

export type NotifyLang = 'en' | 'uk'

export type NotifyEvent =
  | { type: 'deposit_completed'; amountUsd: number; asset?: string; amountCrypto?: string; balance: number }
  | { type: 'order_completed'; orderId: string; serviceName: string; quantity: number }
  | { type: 'order_canceled'; orderId: string; serviceName: string; quantity: number; refundAmount: number }
  | { type: 'order_partial'; orderId: string; serviceName: string; quantity: number; remains: number; refundAmount: number }
  /** Admin alert from provider-health-monitor: a provider went down ('unavailable') or came back ('healthy'). */
  | { type: 'provider_health'; providerName: string; status: 'unavailable' | 'healthy' }
  /** Admin alert from provider-health-monitor: a provider's balance fell to or below its threshold. */
  | { type: 'provider_low_balance'; providerName: string; balance: number; currency: string; /** Amount of the top-up proposal that was filed, if any. */ proposalAmount?: number }

/** Ukrainian for uk-*, English for everything else. */
export function resolveLang(languageCode: string | null | undefined): NotifyLang {
  return /^uk(\b|-|_)/i.test(languageCode ?? '') ? 'uk' : 'en'
}

/** Escapes the three characters Telegram's HTML parse mode treats specially (plus quotes for safety). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** $5.40 / $0.0054: at least 2 decimals, up to 4 when needed. */
export function formatUsd(amount: number): string {
  const units = Math.round(amount * 10_000)
  const whole = Math.floor(Math.abs(units) / 10_000)
  let frac = String(Math.abs(units) % 10_000).padStart(4, '0')
  if (frac.endsWith('00')) frac = frac.slice(0, 2)
  else if (frac.endsWith('0')) frac = frac.slice(0, 3)
  return `${units < 0 ? '-' : ''}$${whole.toLocaleString('en-US')}.${frac}`
}

/** 5.40 / -0.0054 / 1,234.50 (formatUsd without the currency symbol; the currency is printed separately). */
const plainAmount = (n: number) => `${n < 0 ? '-' : ''}${formatUsd(Math.abs(n)).slice(1)}`
const int = (n: number) => n.toLocaleString('en-US')
const shortId = (id: string) => escapeHtml(id.replace(/^mock-/, '').slice(0, 8))
const name = (n: string) => escapeHtml(clip(n.trim() || '—', 80))
const trimCrypto = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

type Template<E extends NotifyEvent> = (e: E) => string

const EN: { [K in NotifyEvent['type']]: Template<Extract<NotifyEvent, { type: K }>> } = {
  deposit_completed: (e) =>
    `✅ <b>Deposit received</b>\n<b>+${formatUsd(e.amountUsd)}</b>${e.amountCrypto && e.asset ? ` (${escapeHtml(trimCrypto(e.amountCrypto))} ${escapeHtml(e.asset)})` : ''} was added to your balance.\nNew balance: <b>${formatUsd(e.balance)}</b>`,
  order_completed: (e) =>
    `🎉 <b>Order completed</b>\n#${shortId(e.orderId)} · ${name(e.serviceName)}\n${int(e.quantity)} delivered.`,
  order_canceled: (e) =>
    `⚠️ <b>Order canceled</b>\n#${shortId(e.orderId)} · ${name(e.serviceName)}\nThe provider could not complete it. <b>${formatUsd(e.refundAmount)}</b> was refunded to your balance.`,
  order_partial: (e) =>
    `ℹ️ <b>Order partially completed</b>\n#${shortId(e.orderId)} · ${name(e.serviceName)}\n${int(e.quantity - e.remains)} of ${int(e.quantity)} delivered, ${int(e.remains)} not delivered.\n<b>${formatUsd(e.refundAmount)}</b> was refunded to your balance.`,
  provider_health: (e) =>
    e.status === 'unavailable'
      ? `🚨 <b>Provider ${name(e.providerName)} is UNAVAILABLE</b>\nTraffic is routed to fallback.`
      : `✅ <b>Provider ${name(e.providerName)} is back ONLINE</b>\nRouting restored.`,
  provider_low_balance: (e) =>
    e.proposalAmount
      ? `⚠️ <b>Provider ${name(e.providerName)} balance is low.</b> A top-up proposal for <b>${plainAmount(e.proposalAmount)} ${escapeHtml(e.currency)}</b> has been generated.\nBalance: ${plainAmount(e.balance)} ${escapeHtml(e.currency)}.`
      : `⚠️ <b>Provider ${name(e.providerName)} balance is critically low:</b> ${plainAmount(e.balance)} ${escapeHtml(e.currency)}.`,
}

const UK: typeof EN = {
  deposit_completed: (e) =>
    `✅ <b>Поповнення отримано</b>\n<b>+${formatUsd(e.amountUsd)}</b>${e.amountCrypto && e.asset ? ` (${escapeHtml(trimCrypto(e.amountCrypto))} ${escapeHtml(e.asset)})` : ''} зараховано на ваш баланс.\nНовий баланс: <b>${formatUsd(e.balance)}</b>`,
  order_completed: (e) =>
    `🎉 <b>Замовлення виконано</b>\n#${shortId(e.orderId)} · ${name(e.serviceName)}\nДоставлено: ${int(e.quantity)}.`,
  order_canceled: (e) =>
    `⚠️ <b>Замовлення скасовано</b>\n#${shortId(e.orderId)} · ${name(e.serviceName)}\nПостачальник не зміг його виконати. <b>${formatUsd(e.refundAmount)}</b> повернено на ваш баланс.`,
  order_partial: (e) =>
    `ℹ️ <b>Замовлення виконано частково</b>\n#${shortId(e.orderId)} · ${name(e.serviceName)}\nДоставлено ${int(e.quantity - e.remains)} з ${int(e.quantity)}, не доставлено ${int(e.remains)}.\n<b>${formatUsd(e.refundAmount)}</b> повернено на ваш баланс.`,
  provider_health: (e) =>
    e.status === 'unavailable'
      ? `🚨 <b>Провайдер ${name(e.providerName)} НЕДОСТУПНИЙ</b>\nТрафік переведено на резервного.`
      : `✅ <b>Провайдер ${name(e.providerName)} знову ONLINE</b>\nМаршрутизацію відновлено.`,
  provider_low_balance: (e) =>
    e.proposalAmount
      ? `⚠️ <b>Баланс провайдера ${name(e.providerName)} низький.</b> Створено заявку на поповнення на <b>${plainAmount(e.proposalAmount)} ${escapeHtml(e.currency)}</b>.\nБаланс: ${plainAmount(e.balance)} ${escapeHtml(e.currency)}.`
      : `⚠️ <b>Баланс провайдера ${name(e.providerName)} критично низький:</b> ${plainAmount(e.balance)} ${escapeHtml(e.currency)}.`,
}

const TEMPLATES: Record<NotifyLang, typeof EN> = { en: EN, uk: UK }

/** Telegram HTML message for an event. Always <= 4096 chars. */
export function buildMessage(event: NotifyEvent, lang: NotifyLang = 'en'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (TEMPLATES[lang][event.type] as Template<any>)(event)
  return clip(text, 4096)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'blocked' | 'rate_limited' | 'network' | 'timeout' | 'api'; retryable: boolean; status?: number }

export async function sendTelegramMessage(opts: {
  botToken: string
  chatId: number | string
  text: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<SendResult> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: opts.chatId, text: opts.text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    })
    if (res.ok) return { ok: true }
    // The user blocked the bot / deleted the chat: permanent, never retry.
    if (res.status === 403) return { ok: false, reason: 'blocked', retryable: false, status: 403 }
    if (res.status === 429) return { ok: false, reason: 'rate_limited', retryable: true, status: 429 }
    return { ok: false, reason: 'api', retryable: res.status >= 500, status: res.status }
  } catch (e) {
    // Deliberately not including the error: some runtimes echo the request URL, which holds the token.
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return { ok: false, reason: timedOut ? 'timeout' : 'network', retryable: true }
  }
}

// ---------------------------------------------------------------------------
// Dispatch (dedupe + preferences + failure policy)
// ---------------------------------------------------------------------------

export type NotifyOutcome = 'sent' | 'duplicate' | 'disabled' | 'unconfigured' | 'mock_logged' | 'failed' | 'error'

export interface NotifyDeps {
  /** Undefined = bot not configured. */
  botToken?: string
  /** Dev: log the message instead of sending (also used when no token is set and mock is on). */
  mock?: boolean
  /** Atomically claims the dedupe key. Resolves false if it was already claimed. */
  claim(dedupeKey: string): Promise<boolean>
  /** Gives the claim back so a later attempt may retry (used after a transient failure). */
  release(dedupeKey: string): Promise<void>
  send?: typeof sendTelegramMessage
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
}

export interface NotifyTarget {
  chatId: number
  lang: NotifyLang
  enabled: boolean
}

/** Never throws. */
export async function notifyUser(deps: NotifyDeps, target: NotifyTarget, event: NotifyEvent, dedupeKey: string): Promise<NotifyOutcome> {
  const log = deps.log ?? console
  try {
    if (!target.enabled) return 'disabled'
    const text = buildMessage(event, target.lang)

    if (!deps.botToken) {
      if (deps.mock) {
        if (!(await deps.claim(dedupeKey))) return 'duplicate'
        log.info(`[mock telegram -> ${target.chatId}] ${text}`)
        return 'mock_logged'
      }
      return 'unconfigured'
    }

    if (!(await deps.claim(dedupeKey))) return 'duplicate'

    const result = await (deps.send ?? sendTelegramMessage)({ botToken: deps.botToken, chatId: target.chatId, text })
    if (result.ok) return 'sent'

    log.warn(`telegram-notify: ${event.type} not delivered (${result.reason}${result.status ? ` ${result.status}` : ''})`)
    if (result.retryable) await deps.release(dedupeKey).catch(() => {}) // let a later re-run try again
    return 'failed'
  } catch (e) {
    try { log.warn('telegram-notify: unexpected error', e instanceof Error ? e.name : 'unknown') } catch { /* nothing left to do */ }
    return 'error'
  }
}

/** Runs a promise without blocking the response where the runtime supports it. Never rejects. */
export function fireAndForget(promise: Promise<unknown>): void {
  const safe = promise.catch(() => {})
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  try { runtime?.waitUntil?.(safe) } catch { /* fall through: the promise keeps running anyway */ }
}
