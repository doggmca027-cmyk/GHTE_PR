// A price rule that applies to quality cards only (migration 20261231000200, price-engine.ts): "Quality tier 3a" lifts the quality cards whose cost is
// 1.00 - 3.00 from x2.0 to x2.5 and touches nothing else. docs/proposals/premium-markup.sql is the rule itself.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isQualityCard } from '../supabase/functions/_shared/offer-quality.ts'
import { calculateCustomerRate, selectPriceRule } from '../supabase/functions/_shared/price-engine.ts'
import type { PriceRule } from '../supabase/functions/_shared/types.ts'

const tier = (id: string, value: number, min_rate: number, max_rate: number | null, min_markup: number | null, extra: Partial<PriceRule> = {}): PriceRule =>
  ({ id, type: 'tier', value, min_rate, max_rate, min_markup, priority: 0, is_active: true, ...extra })

// the global tiers of production (Tier 1..4) and the new rule
const TIERS = [
  tier('t1', 400, 0, 0.0499, 0.1, { min_price: 0.12 }),
  tier('t2', 200, 0.05, 0.4999, 0.12),
  tier('t3', 100, 0.5, 4.9999, 0.3),
  tier('t4', 60, 5, null, null),
]
const Q3A = tier('q3a', 150, 1, 2.9999, 0.8, { priority: 1, quality_scope: 'quality' })
const RULES = [...TIERS, Q3A]

const QUALITY = 'Instagram Followers ➜ [Speed: 50k+/Day | Refill: 30 Days]'
const HQ = 'Instagram Followers | HQ | Real'
const PLAIN = 'Instagram Followers'
const NO_REFILL_HQ = 'Instagram Followers [no refill] [high quality]'
const price = (cost: number, serviceName?: string, rules = RULES) => calculateCustomerRate(cost, rules, { serviceName })

describe('the quality tier 3a', () => {
  it('quality cards at a cost of 1.00 - 3.00 sell at x2.5', () => {
    expect(price(1, QUALITY)).toBe(2.5)
    expect(price(1.5, HQ)).toBe(3.75)
    expect(price(2, QUALITY)).toBe(5)
    expect(price(2.9999, QUALITY)).toBe(7.4998) // 7.49975 rounded up to four decimals, like every price
  })

  it('a card that is not a quality card keeps x2.0, also the one that takes its promise back', () => {
    expect(isQualityCard(PLAIN)).toBe(false)
    expect(isQualityCard(NO_REFILL_HQ)).toBe(false)
    for (const name of [PLAIN, NO_REFILL_HQ, 'Instagram Followers [bots] [refill: 30 days]']) {
      expect(price(1, name)).toBe(2)
      expect(price(2, name)).toBe(4)
    }
    expect(price(1.5)).toBe(3) // a context without a name cannot be quality
  })

  it('nothing outside the band moves: the cheap bands, the floor cards and everything from 3.00', () => {
    expect(price(0.9999, QUALITY)).toBe(price(0.9999, QUALITY, TIERS))
    expect(price(0.3276, QUALITY)).toBe(0.9828) // the floor card #89336
    expect(price(0.36, QUALITY)).toBe(1.08) // and #73486
    expect(price(0.03, QUALITY)).toBe(price(0.03, QUALITY, TIERS))
    for (const cost of [3, 4.5, 5, 12]) expect(price(cost, QUALITY)).toBe(price(cost, QUALITY, TIERS))
  })

  it('only the rule\'s band, and only from the new rule: without it every price is what it was', () => {
    for (const cost of [0.04, 0.4, 0.9, 1, 2, 2.9999, 3, 6]) {
      for (const name of [QUALITY, HQ, PLAIN]) {
        const lifted = price(cost, name)
        const before = price(cost, name, TIERS)
        if (cost >= 1 && cost <= 2.9999 && isQualityCard(name)) expect(lifted).toBeGreaterThan(before)
        else expect(lifted).toBe(before)
      }
    }
  })

  it('wins against the global tier of its band, loses to a service or category rule and to an inactive switch', () => {
    expect(selectPriceRule(1.5, RULES, { serviceName: QUALITY })?.id).toBe('q3a')
    expect(selectPriceRule(1.5, RULES, { serviceName: PLAIN })?.id).toBe('t3') // it falls through
    const pinned = tier('svc', 0, 0, null, null, { type: 'percentage', service_id: 's1', value: 30 })
    expect(selectPriceRule(1.5, [...RULES, pinned], { serviceId: 's1', serviceName: QUALITY })?.id).toBe('svc')
    expect(selectPriceRule(1.5, [...RULES.slice(0, 4), { ...Q3A, is_active: false }], { serviceName: QUALITY })?.id).toBe('t3')
  })

  it('never earns less than cost + 0.80 (the rule\'s minimum), and never below the global floor', () => {
    const rule = { ...Q3A, value: 10 } // a tiny percentage: the minimum decides
    expect(calculateCustomerRate(1.5, [rule], { serviceName: QUALITY })).toBe(2.3)
  })
})

describe('where the rule is read', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')
  it.each([
    'supabase/functions/_shared/order-pricing.ts', // the shared loader: sync-catalog, quote-order and place-order read their rules through it
    'supabase/functions/admin-pricing/index.ts',
    'supabase/functions/admin-catalog-mapping/index.ts',
  ])('%s reads quality_scope with the other columns of a rule', (file) => {
    expect(read(file)).toContain("name_all, name_any, priority, is_active, quality_scope'")
  })
  it('sync-catalog reads its rules through that shared loader', () => {
    expect(read('supabase/functions/sync-catalog/index.ts')).toContain('loadPriceRules(db)')
  })
  it('the proposal that is applied by hand names the same rule', () => {
    const sql = read('docs/proposals/premium-markup.sql')
    expect(sql).toContain("'tier', 150, 1.0000, 2.9999, 0.8000, 1, true, 'quality'")
  })
})
