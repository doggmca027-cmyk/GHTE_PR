import { describe, expect, it } from 'vitest'
import { generatePromoCode, parsePromoRequest, PROMO_CODE, toPromoDto } from '../supabase/functions/_shared/admin-promos'

const ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-10-09T00:00:00Z')
const bytes = () => new Uint8Array([0, 1, 2, 3, 4, 5])
const parse = (body: unknown) => parsePromoRequest(body, bytes, NOW)

describe('parsePromoRequest', () => {
  it('lists by default', () => {
    expect(parse({})).toEqual({ action: 'LIST' })
    expect(parse({ action: 'list' })).toEqual({ action: 'LIST' })
  })

  it('creates a percentage promo; the code is upper-cased and the value rounded to cents', () => {
    expect(parse({ action: 'CREATE', code: ' summer-10 ', discountType: 'percentage', discountValue: 10.456, maxUses: 100, expiresAt: '2026-12-31T00:00:00Z' })).toEqual({
      action: 'CREATE', code: 'SUMMER-10', discountType: 'percentage', discountValue: 10.46, maxUses: 100, expiresAt: '2026-12-31T00:00:00.000Z',
    })
  })

  it('creates a fixed promo with no limit and no expiry', () => {
    expect(parse({ action: 'CREATE', code: 'GIFT5', discountType: 'fixed', discountValue: 5 })).toEqual({
      action: 'CREATE', code: 'GIFT5', discountType: 'fixed', discountValue: 5, maxUses: null, expiresAt: null,
    })
  })

  it('generates a code that passes the database check when none is given', () => {
    const r = parse({ action: 'CREATE', discountType: 'percentage', discountValue: 5 }) as { code: string }
    expect(r.code).toBe('PROMO-ABCDEF')
    expect(PROMO_CODE.test(r.code)).toBe(true)
    // random bytes can never produce a character outside the alphabet or the confusing 0/O/1/I
    expect(generatePromoCode(new Uint8Array(Array.from({ length: 256 }, (_, i) => i)))).toMatch(/^PROMO-[A-HJ-NP-Z2-9]+$/)
  })

  it.each([
    [null], [[]], ['x'],
    [{ action: 'DROP' }],
    [{ action: 'CREATE', code: 'ab', discountType: 'fixed', discountValue: 1 }],
    [{ action: 'CREATE', code: 'has space', discountType: 'fixed', discountValue: 1 }],
    [{ action: 'CREATE', code: 'X'.repeat(33), discountType: 'fixed', discountValue: 1 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'free', discountValue: 1 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'percentage', discountValue: 91 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'percentage', discountValue: 0 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'percentage', discountValue: 0.001 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'fixed', discountValue: 10_001 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'fixed', discountValue: '5' }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'fixed', discountValue: 1, maxUses: 0 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'fixed', discountValue: 1, maxUses: 1.5 }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'fixed', discountValue: 1, expiresAt: 'tomorrow-ish' }],
    [{ action: 'CREATE', code: 'OK1', discountType: 'fixed', discountValue: 1, expiresAt: '2026-01-01T00:00:00Z' }],
    [{ action: 'SET_ACTIVE', id: 'nope', active: true }],
    [{ action: 'SET_ACTIVE', id: ID, active: 'yes' }],
  ])('rejects %j', (body) => {
    expect(parse(body)).toHaveProperty('error')
  })

  it('switches a promo on or off', () => {
    expect(parse({ action: 'SET_ACTIVE', id: ID, active: false })).toEqual({ action: 'SET_ACTIVE', id: ID, active: false })
  })
})

describe('toPromoDto', () => {
  it('maps a row of promo_codes (numerics come back as strings)', () => {
    expect(toPromoDto({ id: ID, code: 'GIFT5', discount_type: 'fixed', discount_value: '5.0000', max_uses: null, current_uses: 3, expires_at: null, is_active: true, created_at: '2026-10-09T00:00:00Z' })).toEqual({
      id: ID, code: 'GIFT5', discountType: 'fixed', discountValue: 5, maxUses: null, currentUses: 3, expiresAt: null, isActive: true, createdAt: '2026-10-09T00:00:00Z',
    })
  })
})
