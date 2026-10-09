import { recoverProviderOrderId } from '../../supabase/functions/_shared/order-sync.ts'
import { formatUnits, toUnits } from '@/lib/order-calc'

export { recoverProviderOrderId }

/** Russian plural form: plural(1, ['минуту', 'минуты', 'минут']) = 'минуту'. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const m10 = Math.abs(n) % 10
  const m100 = Math.abs(n) % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1]
  return forms[2]
}

/** "только что", "5 мин назад", "3 ч назад", "2 дн назад" or "никогда": the admin panel is Russian whatever language the app is in. */
export function timeAgoRu(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'никогда'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return 'никогда'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'только что'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} мин назад`
  if (s < 86_400) return `${Math.round(s / 3600)} ч назад`
  return `${Math.round(s / 86_400)} дн назад`
}

export const usd = (amount: number): string => formatUnits(toUnits(amount))

/** "+150%" for percentage / tier markups, "+$0.50 / 1k" for fixed ones. */
export function formatRuleValue(type: 'percentage' | 'fixed' | 'tier', value: number): string {
  return type === 'fixed' ? `+${usd(value)} / 1k` : `+${value}%`
}

/** "Global" / "Platform: x" / "Category: x" / "Service: x" (admin_list_price_rules) in Russian. */
export function ruleScopeRu(scope: string): string {
  if (scope === 'Global') return 'Все услуги'
  const m = /^(Platform|Category|Service): (.*)$/.exec(scope)
  if (!m) return scope
  return `${m[1] === 'Platform' ? 'Платформа' : m[1] === 'Category' ? 'Категория' : 'Услуга'}: ${m[2]}`
}

export const ruleTypeRu = (type: 'percentage' | 'fixed' | 'tier'): string => (type === 'fixed' ? 'фиксированная' : type === 'tier' ? 'по диапазону закупки' : 'процент')

/** Below this margin percentage (or any loss) a pricing row is highlighted. */
export const LOW_MARGIN_PERCENT = 10

export function pricingHealth(row: { marginAbsolute: number | null; marginPercent: number | null }): 'loss' | 'low' | 'ok' | 'unknown' {
  if (row.marginAbsolute === null || row.marginPercent === null) return 'unknown'
  if (row.marginAbsolute < 0) return 'loss'
  return row.marginPercent < LOW_MARGIN_PERCENT ? 'low' : 'ok'
}

export interface NoteDescription {
  title: string
  detail: string
  /** True when money is still owed to the customer. */
  refundOwed: boolean
}

/** Turns the machine notes written by place-order / the sync worker into plain language for admins. */
export function describeNote(note: string | null): NoteDescription {
  const text = note ?? ''
  const recovered = recoverProviderOrderId(text)
  if (recovered) {
    return {
      title: 'Провайдер принял этот заказ',
      detail: `Провайдер создал его под номером #${recovered}, но сохранить этот номер не удалось. Закройте кейс с этим номером, и воркер синхронизации начнёт отслеживать заказ.`,
      refundOwed: false,
    }
  }
  if (text.startsWith('needs_refund')) {
    return { title: 'Клиенту нужно вернуть деньги', detail: text.replace(/^needs_refund:?\s*/, '') || 'Автоматический возврат не прошёл.', refundOwed: true }
  }
  if (text.startsWith('needs_reconciliation')) {
    const reason = text.replace(/^needs_reconciliation:?\s*/, '')
    return {
      title: 'Результат неизвестен',
      detail: `${(reason || 'Нет подтверждения от провайдера').replace(/[.\s]+$/, '')}. Провайдер мог создать этот заказ, а мог и нет: проверьте его панель до возврата денег.`,
      refundOwed: false,
    }
  }
  return { title: 'Требует внимания', detail: text || 'Заказ завис в обработке без подтверждения от провайдера.', refundOwed: false }
}

/** Balance relative to the alert threshold: 'low' at or below it (same rule as the monitor), 'ok' above, 'unknown' if never read. */
export function balanceState(balance: number, threshold: number, lastSync: string | null): 'low' | 'ok' | 'unknown' {
  if (lastSync === null) return 'unknown'
  return balance <= threshold ? 'low' : 'ok'
}

/** Parses a non-negative amount with up to 4 decimals; null when invalid. */
export function parseAmount(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(t)) return null
  const n = Number(t)
  return n <= 1_000_000_000 ? n : null
}

const TREASURY_LABELS: Record<string, string> = {
  deposit: 'Пополнение', withdrawal: 'Вывод', provider_topup: 'Пополнение провайдера', fee: 'Комиссия', network_fee: 'Комиссия сети', manual_adjustment: 'Ручная корректировка',
}
export const treasuryTypeLabel = (type: string): string => TREASURY_LABELS[type] ?? type

/** "+$5.00" / "-$5.00": the signed amount of a ledger row. */
export function signedUsd(amount: number): string {
  return `${amount < 0 ? '-' : '+'}${usd(Math.abs(amount))}`
}

export type AnalyticsRangeKey = 'today' | '7d' | '30d' | 'all'

export const ANALYTICS_RANGES: { key: AnalyticsRangeKey; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'all', label: 'За всё время' },
]

/** Request body for admin-analytics. Omitted endDate = now; null = unbounded (All Time). "Today" starts at the viewer's local midnight. */
export function analyticsRequest(key: AnalyticsRangeKey, now: Date = new Date()): { startDate: string | null; endDate?: null } {
  const DAY = 86_400_000
  if (key === 'all') return { startDate: null, endDate: null }
  if (key === 'today') return { startDate: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() }
  return { startDate: new Date(now.getTime() - (key === '7d' ? 7 : 30) * DAY).toISOString() }
}
