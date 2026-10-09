import type { PromoInput, PromoView } from '@/types/admin'
import { usd } from '@/lib/admin-view'

/** What the admin typed into the "new promo code" form (all text, as in the inputs). */
export interface PromoForm {
  code: string
  type: 'percentage' | 'fixed'
  value: string
  maxUses: string
  /** yyyy-mm-dd from <input type="date">, or empty. */
  expires: string
}

/** Validates the form like the server does and builds the request; the message is Russian because the admin panel is. */
export function parsePromoForm(f: PromoForm, now: Date = new Date()): { input: PromoInput } | { error: string } {
  const code = f.code.trim()
  if (code !== '' && !/^[A-Z0-9_-]{3,32}$/.test(code)) return { error: 'Код: от 3 до 32 символов, только A-Z, 0-9, «_» и «-».' }
  if (!/^\d+(\.\d{1,2})?$/.test(f.value.trim())) return { error: 'Введите размер скидки.' }
  const value = Number(f.value)
  if (f.type === 'percentage' && (value < 1 || value > 90)) return { error: 'Скидка в процентах: от 1 до 90.' }
  if (f.type === 'fixed' && (value <= 0 || value > 10_000)) return { error: 'Скидка в долларах: от 0.01 до 10000.' }
  let maxUses: number | null = null
  if (f.maxUses !== '') {
    maxUses = Number(f.maxUses)
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) return { error: 'Лимит использований: целое число от 1.' }
  }
  let expiresAt: string | null = null
  if (f.expires !== '') {
    // valid until the end of the chosen day, in the admin's own time zone
    const end = new Date(`${f.expires}T23:59:59`)
    if (Number.isNaN(end.getTime())) return { error: 'Неверная дата.' }
    if (end.getTime() <= now.getTime()) return { error: 'Эта дата уже прошла.' }
    expiresAt = end.toISOString()
  }
  return { input: { ...(code ? { code } : {}), discountType: f.type, discountValue: value, maxUses, expiresAt } }
}

export interface PromoDescription {
  discount: string
  usage: string
  status: string
  /** Can be used right now. */
  live: boolean
}

/** One promo as three short Russian lines for the list. */
export function describePromo(p: PromoView, now: Date = new Date()): PromoDescription {
  const discount = p.discountType === 'percentage' ? `−${p.discountValue}%` : `−${usd(p.discountValue)}`
  const usage = p.maxUses === null ? `использован ${p.currentUses} раз` : `использован ${p.currentUses} из ${p.maxUses}`
  const expired = p.expiresAt !== null && new Date(p.expiresAt).getTime() <= now.getTime()
  const spent = p.maxUses !== null && p.currentUses >= p.maxUses
  if (!p.isActive) return { discount, usage, status: 'Выключен', live: false }
  if (expired) return { discount, usage, status: 'Срок действия истёк', live: false }
  if (spent) return { discount, usage, status: 'Лимит исчерпан', live: false }
  const until = p.expiresAt === null ? 'без срока' : `до ${new Date(p.expiresAt).toLocaleDateString('ru-RU')}`
  return { discount, usage, status: `Действует, ${until}`, live: true }
}
