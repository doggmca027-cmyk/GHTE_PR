import { describe, expect, it } from 'vitest'
import { plural, ruleScopeRu, ruleTypeRu, timeAgoRu } from '../src/lib/admin-view'
import { describePromo, parsePromoForm, type PromoForm } from '../src/lib/promo-view'
import type { PromoView } from '../src/types/admin'

const NOW = new Date('2026-10-09T12:00:00Z')
const form = (over: Partial<PromoForm> = {}): PromoForm => ({ code: '', type: 'percentage', value: '10', maxUses: '', expires: '', ...over })
const promo = (over: Partial<PromoView> = {}): PromoView => ({
  id: 'p1', code: 'GIFT5', discountType: 'fixed', discountValue: 5, maxUses: null, currentUses: 0, expiresAt: null, isActive: true, createdAt: '2026-10-01T00:00:00Z', ...over,
})

describe('Russian helpers of the admin panel', () => {
  it('plural forms', () => {
    const f = ['услуга', 'услуги', 'услуг'] as const
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 100, 101, 111].map((n) => plural(n, f))).toEqual(
      ['услуга', 'услуги', 'услуги', 'услуг', 'услуг', 'услуг', 'услуг', 'услуга', 'услуги', 'услуг', 'услуг', 'услуга', 'услуг'])
  })

  it('relative time in Russian whatever the app language is', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const ago = (ms: number) => timeAgoRu(new Date(now - ms).toISOString(), now)
    expect([ago(10_000), ago(5 * 60_000), ago(3 * 3600_000), ago(2 * 86_400_000)]).toEqual(['только что', '5 мин назад', '3 ч назад', '2 дн назад'])
    expect(timeAgoRu(null)).toBe('никогда')
    expect(timeAgoRu('garbage')).toBe('никогда')
  })

  it('price rule scopes and types', () => {
    expect(ruleScopeRu('Global')).toBe('Все услуги')
    expect(ruleScopeRu('Platform: telegram')).toBe('Платформа: telegram')
    expect(ruleScopeRu('Category: Views')).toBe('Категория: Views')
    expect(ruleScopeRu('Service: Likes')).toBe('Услуга: Likes')
    expect(ruleScopeRu('something else')).toBe('something else')
    expect([ruleTypeRu('percentage'), ruleTypeRu('fixed'), ruleTypeRu('tier')]).toEqual(['процент', 'фиксированная', 'по диапазону закупки'])
  })
})

describe('promo form', () => {
  it('builds the request; an empty code is left for the server to generate', () => {
    expect(parsePromoForm(form(), NOW)).toEqual({ input: { discountType: 'percentage', discountValue: 10, maxUses: null, expiresAt: null } })
    expect(parsePromoForm(form({ code: 'SUMMER10', type: 'fixed', value: '2.5', maxUses: '100', expires: '2026-12-31' }), NOW)).toMatchObject({
      input: { code: 'SUMMER10', discountType: 'fixed', discountValue: 2.5, maxUses: 100, expiresAt: expect.stringMatching(/^2026-12-31T|^2027-01-01T/) },
    })
  })

  it.each([
    [{ code: 'ab' }], [{ code: 'bad code' }],
    [{ value: '' }], [{ value: 'abc' }], [{ value: '0' }], [{ value: '91' }],
    [{ type: 'fixed' as const, value: '10001' }], [{ type: 'fixed' as const, value: '0' }],
    [{ maxUses: '0' }], [{ expires: '2026-01-01' }], [{ expires: 'nope' }],
  ])('rejects %j', (over) => {
    expect(parsePromoForm(form(over), NOW)).toHaveProperty('error')
  })
})

describe('promo list', () => {
  it('shows the discount, the usage and whether it works right now', () => {
    expect(describePromo(promo(), NOW)).toEqual({ discount: '−$5.00', usage: 'использован 0 раз', status: 'Действует, без срока', live: true })
    expect(describePromo(promo({ discountType: 'percentage', discountValue: 15, maxUses: 10, currentUses: 3 }), NOW)).toMatchObject({ discount: '−15%', usage: 'использован 3 из 10', live: true })
    expect(describePromo(promo({ isActive: false }), NOW)).toMatchObject({ status: 'Выключен', live: false })
    expect(describePromo(promo({ expiresAt: '2026-10-01T00:00:00Z' }), NOW)).toMatchObject({ status: 'Срок действия истёк', live: false })
    expect(describePromo(promo({ maxUses: 5, currentUses: 5 }), NOW)).toMatchObject({ status: 'Лимит исчерпан', live: false })
  })
})
