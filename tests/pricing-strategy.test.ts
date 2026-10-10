import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { calculateCustomerRate, DEFAULT_MIN_MARGIN, selectPriceRule } from '../supabase/functions/_shared/price-engine.ts'
import type { PriceRule } from '../supabase/functions/_shared/types.ts'

// The seeded strategy is read from the migration itself, so the test fails if the SQL and the engine ever disagree.
const SQL = readFileSync('supabase/migrations/20261116000000_pricing_strategy.sql', 'utf8')
const ARR = '(array\\[[^\\]]*\\]|null::text\\[\\])'
const list = (s: string): string[] | null => (s.startsWith('null') ? null : [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]!))

interface SeedRow { name: string; platform: string | null; value: number; name_all: string[] | null; name_any: string[] | null; priority: number }
const scoped: SeedRow[] = [...SQL.matchAll(new RegExp(`\\('([^']+)',\\s*'([a-z-]+)',\\s*(\\d+)::numeric,\\s*${ARR},\\s*${ARR},\\s*(\\d+)\\)`, 'g'))].map((m) => ({
  name: m[1]!, platform: m[2]!, value: Number(m[3]), name_all: list(m[4]!), name_any: list(m[5]!), priority: Number(m[6]),
}))
const unscoped: SeedRow[] = [...SQL.matchAll(new RegExp(`\\('(Strategy: [^']+)',\\s*(\\d+)::numeric,\\s*${ARR},\\s*${ARR}\\)`, 'g'))].map((m) => ({
  name: m[1]!, platform: null, value: Number(m[2]), name_all: list(m[3]!), name_any: list(m[4]!), priority: 10,
}))
const tiers = [...SQL.matchAll(/\('(Strategy tier[^']+)',\s*(\d+)::numeric,\s*([\d.]+)::numeric,\s*([\d.]+|null)::numeric\)/g)].map((m) => ({
  name: m[1]!, value: Number(m[2]), min_rate: Number(m[3]), max_rate: m[4] === 'null' ? null : Number(m[4]),
}))

let n = 0
const RULES: PriceRule[] = [
  ...tiers.map((t) => ({ id: `t${++n}`, type: 'tier' as const, value: t.value, min_rate: t.min_rate, max_rate: t.max_rate, priority: 0, is_active: true })),
  ...[...scoped, ...unscoped].map((r) => ({
    id: `k${String(++n).padStart(3, '0')}`, type: 'percentage' as const, value: r.value, platform: r.platform, name_all: r.name_all, name_any: r.name_any, priority: r.priority, is_active: true,
  })),
]
const price = (cost: number, platform: string, serviceName: string, extra: PriceRule[] = [], ctx: Record<string, string> = {}) =>
  calculateCustomerRate(cost, [...RULES, ...extra], { platform, serviceName, ...ctx })

describe('pricing strategy migration data', () => {
  it('seeds the tiers and the keyword rules the strategy asks for', () => {
    expect(tiers).toHaveLength(4)
    expect(scoped.length).toBeGreaterThanOrEqual(20)
    expect(unscoped).toHaveLength(3)
  })

  it('every rule states its multiplier in the name and the value is (multiplier - 1) * 100', () => {
    for (const r of [...tiers, ...scoped, ...unscoped]) {
      const m = /\(x([\d.]+)\)/.exec(r.name)
      expect(m, r.name).not.toBeNull()
      expect(r.value, r.name).toBe(Math.round((Number(m![1]) - 1) * 100))
    }
  })

  it('tiers cover every cost without a gap or an overlap at 4 decimals', () => {
    const sorted = [...tiers].sort((a, b) => a.min_rate - b.min_rate)
    expect(sorted[0]!.min_rate).toBe(0)
    for (let i = 1; i < sorted.length; i++) expect(Math.round((sorted[i]!.min_rate - sorted[i - 1]!.max_rate!) * 10_000)).toBe(1)
    expect(sorted.at(-1)!.max_rate).toBeNull()
  })

  it('only names platforms that exist in the registry migrations', () => {
    const known = readFileSync('supabase/migrations/20261029000000_platforms_registry.sql', 'utf8') + readFileSync('supabase/migrations/20261112000000_more_platforms.sql', 'utf8')
    for (const slug of new Set(scoped.map((r) => r.platform!))) expect(known, slug).toContain(`'${slug}'`)
  })
})

describe('fallback tiers (cost per 1000 -> multiplier)', () => {
  it.each([
    [0.0499, 0.1996], // x4.0 up to but excluding 0.05
    [0.05, 0.125], //   x2.5
    [0.4999, 1.2498],
    [0.5, 0.9], //      x1.8
    [4.9999, 8.9999], // 8.99982 rounds UP
    [5, 7.5], //        x1.5
    [100, 150],
  ])('cost %s -> %s', (cost, expected) => {
    expect(price(cost, 'snapchat', 'Snapchat Followers')).toBe(expected)
  })

  it('never goes below cost + 0.02 and rounds UP to 4 decimals', () => {
    expect(DEFAULT_MIN_MARGIN).toBe(0.02)
    expect(price(0.001, 'snapchat', 'Snapchat Views')).toBe(0.021) // 0.004 would be a loss on a small order
    expect(price(0.01234, 'snapchat', 'Snapchat Views')).toBe(0.0494) // 0.01234 * 4 = 0.04936 -> up
  })
})

describe('keyword overrides', () => {
  it('matches whole words only: "0% Drop" is not inside "10% Drop"', () => {
    expect(price(1, 'telegram', 'Telegram Members [Refill: 30 Days] [0% Drop]')).toBe(2) // x2.0
    expect(price(1, 'telegram', 'Telegram Members [Refill: 30 Days] [10% Drop]')).toBe(1.8) // falls to tier 3
  })

  it('is scoped to the platform: the same words on another platform do not match', () => {
    expect(price(1, 'telegram', 'Telegram Premium Members [Refill]')).toBe(1.6)
    expect(price(1, 'instagram', 'Telegram Premium Members [Refill]')).toBe(1.8)
  })

  it('applies the Big 4 multipliers', () => {
    expect(price(0.5, 'telegram', 'Telegram Post Views [No Refill]')).toBe(2.25) // x4.5
    expect(price(1, 'instagram', 'Instagram Followers [Non Drop] [30 Days]')).toBe(2.2)
    expect(price(1, 'instagram', 'Instagram Likes [Real]')).toBe(3)
    expect(price(1, 'instagram', 'Instagram Reels Views [Fast]')).toBe(4)
    expect(price(10, 'youtube', 'YouTube Subscribers [Refill]')).toBe(15)
    expect(price(10, 'youtube', 'YouTube Views [High Retention]')).toBe(16)
    expect(price(20, 'youtube', 'YouTube 4000 Watch Hours [Monetization]')).toBe(28)
    expect(price(1, 'tiktok', 'TikTok Followers [Real]')).toBe(2)
    expect(price(1, 'tiktok', 'TikTok Views [Fast]')).toBe(4)
  })

  it('an all-words rule needs the second phrase too ("Instagram Followers" alone falls to the tier)', () => {
    expect(price(1, 'instagram', 'Instagram Followers [Cheap]')).toBe(1.8)
  })

  it('among rules of one scope the higher priority wins', () => {
    expect(price(1, 'twitter', 'Twitter Followers')).toBe(2)
    expect(price(1, 'twitter', 'Twitter Views')).toBe(4)
    expect(price(1, 'twitter', 'Twitter Likes and Views')).toBe(4) // views (30) beats followers/likes (20)
    expect(price(1, 'discord', 'Discord Server Boosts')).toBe(1.5)
  })

  it('platform-less keyword rules apply anywhere, but a platform-scoped rule outranks them', () => {
    expect(price(2, 'snapchat', 'Snapchat Website Traffic SEO')).toBe(5) // x2.5
    expect(price(10, 'youtube', 'YouTube Views [SEO]')).toBe(16) // platform rule x1.6, not x2.5
    expect(price(2, 'other', 'Google Maps Reviews [Real]')).toBe(3) // x1.5
  })

  it('an explicit category or service rule beats a keyword rule; a platform margin does not', () => {
    const category: PriceRule = { id: 'c1', type: 'percentage', value: 10, category_id: 'cat-1', priority: 0, is_active: true }
    const platform: PriceRule = { id: 'p1', type: 'percentage', value: 10, platform: 'telegram', priority: 99, is_active: true }
    const ctx = { categoryId: 'cat-1' }
    expect(price(1, 'telegram', 'Telegram Premium Members', [category], ctx)).toBe(1.1)
    expect(price(1, 'telegram', 'Telegram Premium Members', [platform])).toBe(1.6)
    expect(selectPriceRule(1, [...RULES, platform], { platform: 'telegram', serviceName: 'Telegram Premium Members' })?.value).toBe(60)
  })

  it('without a service name keyword rules are skipped (no accidental match)', () => {
    expect(calculateCustomerRate(1, RULES, { platform: 'telegram' })).toBe(1.8)
  })
})
