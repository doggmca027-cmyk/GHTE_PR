import { describe, expect, it } from 'vitest'
import {
  calcTotalUnits,
  checkBalance,
  deriveSpeed,
  formatCompact,
  formatMoneyAmount,
  formatUnits,
  quantityPresets,
  toUnits,
  validateQuantity,
  validateTargetUrl,
} from '../src/lib/order-calc'

describe('calcTotalUnits (mirrors place_order: round(rate * qty / 1000, 4))', () => {
  it.each([
    [1000, 2.4, 24_000], //  $2.4000
    [100, 0.24, 240], //     $0.0240
    [1234, 0.0825, 1018], // 0.101805 -> $0.1018 (rounds down)
    [50, 0.0825, 41], //     0.004125 -> 0.0041
    [1, 0.5, 5], //          0.0005 exactly -> $0.0005
    [3, 0.1667, 5], //       0.0005001 -> 0.0005
    [500, 0.0001, 1], //     0.00005 -> rounds half UP to 0.0001
  ])('%d x %d/1000', (quantity, rate, expected) => {
    expect(calcTotalUnits(quantity, rate)).toBe(expected)
  })

  it('has no floating-point drift on awkward values', () => {
    expect(calcTotalUnits(3, 0.1)).toBe(3) // 0.0003, not 0.00030000000000000003
    expect(calcTotalUnits(1_000_000, 0.24)).toBe(2_400_000) // $240.00
    expect(toUnits(0.1 + 0.2)).toBe(3000)
  })
})

describe('formatting', () => {
  it('shows cents normally and extra precision only when needed', () => {
    expect(formatUnits(24_000)).toBe('$2.40')
    expect(formatUnits(1018)).toBe('$0.1018')
    expect(formatUnits(1050)).toBe('$0.105')
    expect(formatUnits(1_234_560_000)).toBe('$123,456.00')
    expect(formatMoneyAmount(24.5)).toBe('$24.50')
    expect(formatUnits(0)).toBe('$0.00')
  })
  it('compacts big numbers', () => {
    expect([750, 1000, 50_000, 1_000_000, 1_500_000].map(formatCompact)).toEqual(['750', '1K', '50K', '1M', '1.5M'])
  })
})

describe('validateQuantity', () => {
  const ok = (raw: string) => validateQuantity(raw, 100, 10_000)
  it('accepts values inside the limits (including the bounds)', () => {
    expect(ok('100')).toEqual({ ok: true, value: 100 })
    expect(ok('10000')).toEqual({ ok: true, value: 10_000 })
    expect(ok(' 1,500 ')).toEqual({ ok: true, value: 1500 })
  })
  it.each([
    ['', 'Enter a quantity'],
    ['abc', 'Use whole numbers only'],
    ['12.5', 'Use whole numbers only'],
    ['-5', 'Use whole numbers only'],
    ['99', 'Minimum is 100'],
    ['10001', 'Maximum is 10,000'],
    ['99999999999999999999', 'Quantity is too large'],
  ])('rejects %j', (raw, error) => {
    expect(ok(raw)).toEqual({ ok: false, error })
  })
})

describe('validateTargetUrl', () => {
  it('accepts http(s) links and normalises bare domains', () => {
    expect(validateTargetUrl('https://t.me/channel')).toEqual({ ok: true, value: 'https://t.me/channel' })
    expect(validateTargetUrl('  http://instagram.com/user  ')).toMatchObject({ ok: true })
    expect(validateTargetUrl('t.me/channel')).toEqual({ ok: true, value: 'https://t.me/channel' })
    expect(validateTargetUrl('www.tiktok.com/@user/video/1')).toMatchObject({ ok: true })
  })
  it.each(['', 'hello', 'ftp://example.com/x', 'javascript:alert(1)', 'https://localhost/x', 'https://exa mple.com', 'just.text', 'https://' + 'a'.repeat(2050) + '.com'])(
    'rejects %j',
    (raw) => {
      expect(validateTargetUrl(raw).ok).toBe(false)
    },
  )
})

describe('checkBalance', () => {
  it('compares in exact units', () => {
    expect(checkBalance(24.5, 245_000)).toEqual({ sufficient: true, shortfallUnits: 0 })
    expect(checkBalance(24.5, 245_001)).toEqual({ sufficient: false, shortfallUnits: 1 })
    expect(checkBalance(0, 52_000)).toEqual({ sufficient: false, shortfallUnits: 52_000 })
    expect(checkBalance(0.1 + 0.2, 3000).sufficient).toBe(true) // float noise must not flip the result
  })
})

describe('helpers', () => {
  it('offers presets inside the limits, always including the minimum', () => {
    expect(quantityPresets(100, 1_000_000)).toEqual([100, 1000, 5000, 10_000])
    expect(quantityPresets(2000, 6000)).toEqual([2000, 5000])
    expect(quantityPresets(20, 500)).toEqual([20])
  })
  it('derives speed from the service title', () => {
    expect(deriveSpeed('Views [Instant]')).toBe('Instant')
    expect(deriveSpeed('Followers [Fast, No Refill]')).toBe('Fast')
    expect(deriveSpeed('Likes (slow drip)')).toBe('Slow')
    expect(deriveSpeed('Members [Non-Drop 30D]')).toBe('Standard')
  })
})
