// The order hub, as the owner sees it on Telegram (migration 20261218000000): a customer's top-up, an order waiting for its provider to be
// funded (with two buttons), an order sent to its provider. The database queues the facts (notification_outbox kind admin_hub, payload);
// here they become the message. Pure: no I/O. The owner reads Russian, so the messages are in Russian whatever the admin's language.

export type HubPayload =
  | { event: 'deposit'; amount: number | string; user_id?: string; username?: string | null; telegram_id?: number | string | null }
  | {
    event: 'waiting'; order_id: string; provider_id: string; provider: string; service: string; quantity: number
    charge: number | string; cost: number | string; balance: number | string | null; needed: number | string | null; waiting?: number | string | null
  }
  | {
    event: 'sent'; order_id: string; provider: string; service: string; quantity: number
    charge: number | string; cost: number | string; balance: number | string | null; from_hub?: boolean
  }

export interface InlineButton {
  text: string
  callback_data: string
}

export interface HubMessage {
  text: string
  replyMarkup?: { inline_keyboard: InlineButton[][] }
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** $5.40 / $0.0054: two decimals, up to four when needed. */
export function usd(v: unknown): string {
  const units = Math.round(num(v) * 10_000)
  const whole = Math.floor(Math.abs(units) / 10_000)
  let frac = String(Math.abs(units) % 10_000).padStart(4, '0')
  if (frac.endsWith('00')) frac = frac.slice(0, 2)
  else if (frac.endsWith('0')) frac = frac.slice(0, 3)
  return `${units < 0 ? '-' : ''}$${whole.toLocaleString('en-US')}.${frac}`
}
const signed = (v: number) => `${v < 0 ? '−' : '+'}${usd(Math.abs(v))}`
const shortId = (id: string) => esc(String(id).slice(0, 8))

export const HUB_RETRY = 'hub_retry'
export const HUB_FALLBACK = 'hub_fallback'

export function hubMessage(p: HubPayload): HubMessage {
  if (p.event === 'deposit') {
    const who = p.username ? `@${esc(p.username)}` : `ID ${esc(p.telegram_id ?? String(p.user_id ?? '').slice(0, 8))}`
    return { text: `💰 <b>Пополнение баланса: +${usd(p.amount)}</b> (клиент ${who})` }
  }
  const service = esc(clip(String(p.service ?? '—'), 120))
  const provider = esc(p.provider)
  const charge = num(p.charge)
  const cost = num(p.cost)
  if (p.event === 'waiting') {
    return {
      text: [
        `⏳ <b>Заказ #${shortId(p.order_id)} в Хабе — ждёт пополнения провайдера</b>`,
        `🏢 Провайдер: <b>${provider}</b>`,
        `📦 Услуга: ${service} (Кол-во: ${num(p.quantity).toLocaleString('en-US')})`,
        `💵 Оплатил клиент: ${usd(charge)} | Себестоимость: ${usd(cost)} | Прибыль: ${signed(charge - cost)}`,
        `🏦 Баланс на ${provider}: ${usd(p.balance)} (Нужно для всех заказов в очереди этого провайдера: <b>${usd(p.needed ?? cost)}</b>)`,
      ].join('\n'),
      replyMarkup: {
        inline_keyboard: [
          [{ text: '🚀 Проверить баланс и запустить', callback_data: `${HUB_RETRY}:${p.provider_id}` }],
          [{ text: '🔀 Отправить через другого провайдера', callback_data: `${HUB_FALLBACK}:${p.order_id}` }],
        ],
      },
    }
  }
  return {
    text: [
      p.from_hub ? `✅ <b>Заказ #${shortId(p.order_id)} из Хаба запущен в ${provider}</b>` : `✅ <b>Заказ #${shortId(p.order_id)} отправлен в ${provider}</b>`,
      `📦 ${service} × ${num(p.quantity).toLocaleString('en-US')}`,
      `💵 Клиент: ${usd(charge)} → Закуп: ${usd(cost)} (Маржа: ${signed(charge - cost)}) | Остаток на ${provider}: ${usd(p.balance)}`,
    ].join('\n'),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The hub button an admin pressed, or null for any other callback. */
export function parseHubCallback(data: string | undefined): { action: 'retry'; providerId: string } | { action: 'fallback'; orderId: string } | null {
  const m = /^(hub_retry|hub_fallback):(.+)$/.exec(data ?? '')
  if (!m || !UUID.test(m[2])) return null
  return m[1] === HUB_RETRY ? { action: 'retry', providerId: m[2] } : { action: 'fallback', orderId: m[2] }
}

/** What the order worker answers to a hub run (sync-order-status { hubProviderId }). */
export interface HubRunResult {
  provider: string
  /** The balance just read from the panel (null when it could not be read). */
  balance: number | null
  submitted: number
  returned: number
  rejected: number
  held: number
  /** Still waiting for this provider afterwards, and what they cost. */
  waiting: number
  needed: number
}

/** The bot's answer after "🚀 Проверить баланс и запустить". */
export function hubRunReply(r: HubRunResult): string {
  const lines = [`🏦 <b>${esc(r.provider)}</b>: баланс ${r.balance === null ? 'не удалось прочитать' : usd(r.balance)}`]
  if (r.submitted > 0) lines.push(`🚀 Отправлено в работу: <b>${r.submitted}</b>`)
  if (r.returned > 0) lines.push(`↩️ Панель ответила «недостаточно средств», вернулись в Хаб: ${r.returned}`)
  if (r.rejected > 0) lines.push(`❌ Отклонены панелью (клиентам возвращены деньги): ${r.rejected}`)
  if (r.held > 0) lines.push(`❔ Ответ панели неясен, на проверке: ${r.held}`)
  lines.push(r.waiting > 0 ? `⏳ Ещё ждут: ${r.waiting} на ${usd(r.needed)}` : '✅ Очередь этого провайдера пуста')
  return lines.join('\n')
}
