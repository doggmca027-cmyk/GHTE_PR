// @vitest-environment jsdom
// Variant switches and the bulk-price row: technical duplicates folded, named switches, unreachable volume steps hidden.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { collapseTechnicalDuplicates, withoutTechnicalTags } from '../src/lib/variants'
import { PriceSummary, reachableSteps } from '../src/components/services/PriceSummary'
import { VariantCard } from '../src/components/services/VariantCard'
import type { ICatalogService } from '../src/types/catalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const v = (id: string, name: string, rate: number, o: Partial<ICatalogService> = {}): ICatalogService =>
  ({ id, categoryId: 'c', name, description: null, ratePer1000: rate, minQuantity: 10, maxQuantity: 1000, refillSupported: false, sortOrder: 0, ...o })

describe('technical duplicates', () => {
  it('the server tag is not part of what the customer chooses', () => {
    expect(withoutTechnicalTags('Telegram Members [refill: 7 days] [Russia] [cheap] [server 3]')).toBe('telegram members [refill: 7 days] [russia] [cheap]')
    expect(withoutTechnicalTags('X [Server: 2] [s4] [backup server]')).toBe('x')
  })

  it('same name apart from the server AND same price: one stays (the widest range); a different price or detail stays apart', () => {
    const list = [
      v('a', 'Telegram Members [refill: 7 days] [Russia] [cheap] [server 2]', 1.1016),
      v('b', 'Telegram Members [refill: 30 days] [Russia] [bonus 5%]', 1.6416),
      v('c', 'Telegram Members [refill: 7 days] [Russia] [cheap] [server 3]', 2.2248, { maxQuantity: 500 }),
      v('d', 'Telegram Members [refill: 7 days] [Russia] [cheap]', 2.2248, { maxQuantity: 5000 }),
      v('e', 'Telegram Members [refill: 30 days] [good speed] [Russia]', 2.2248),
    ]
    expect(collapseTechnicalDuplicates(list).map((x) => x.id)).toEqual(['a', 'b', 'd', 'e'])
  })
})

describe('the variant card', () => {
  it('shows one switch per real choice, named', () => {
    const main = v('a', 'Members [refill: 7 days] [server 2]', 1, {
      variants: [v('b', 'Members [refill: 7 days] [server 3]', 1, { maxQuantity: 9000 }), v('c', 'Members [refill: 30 days]', 2), v('d', 'Members [refill: 90 days]', 3), v('e', 'Members [refill: 365 days]', 4)],
    })
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(VariantCard, { service: main, platform: 'telegram', onSelect: () => {} })))
    expect([...host.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(['Economy$1.00', 'Basic$2.00', 'Standard$3.00', 'Premium$4.00'])
    // the kept duplicate is the one with the widest range
    expect(host.textContent).toContain('Members [refill: 7 days] [server 3]')
    act(() => root.unmount())
  })

  it('a group that folds into one choice is a plain card without switches', () => {
    const main = v('a', 'Members [server 2]', 1, { variants: [v('b', 'Members [server 3]', 1)] })
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(VariantCard, { service: main, platform: 'telegram', onSelect: () => {} })))
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0)
    act(() => root.unmount())
  })
})

describe('bulk prices', () => {
  const steps = [{ minQuantity: 0, ratePer1000: 5 }, { minQuantity: 1000, ratePer1000: 4 }, { minQuantity: 10000, ratePer1000: 3.5 }, { minQuantity: 100000, ratePer1000: 3.2 }]

  it('a step that starts above the largest possible order is not shown', () => {
    expect(reachableSteps(steps, 300).map((s) => s.minQuantity)).toEqual([0])
    expect(reachableSteps(steps, 15000).map((s) => s.minQuantity)).toEqual([0, 1000, 10000])
    expect(reachableSteps(steps, 100000)).toHaveLength(4) // a step starting exactly at the maximum is reachable
    expect(reachableSteps(steps)).toHaveLength(4)
  })

  it('the price block hides the row when no discount is reachable, and lists only the reachable ones', () => {
    const quote = { listPrice: 1, tier: { slug: null, percentage: 0, discount: 0 }, promo: { applied: false, discount: 0 }, finalPrice: 1, totalDiscount: 0, discountReduced: false, ratePer1000: 5, volumeRates: steps }
    const render = (maxQuantity: number) => {
      const host = document.createElement('div')
      const root = createRoot(host)
      act(() => root.render(createElement(PriceSummary, { quantity: 200, ratePer1000: 5, estimateUnits: 10000, state: { kind: 'ready', quote, promoError: null }, balance: 10, sufficient: true, shortfallUnits: 0, maxQuantity })))
      const row = host.querySelector('[data-testid="volume-rates"]')
      const items = row ? [...row.querySelectorAll('li')].map((li) => li.textContent) : null
      act(() => root.unmount())
      return items
    }
    expect(render(300)).toBeNull()
    expect(render(15000)).toHaveLength(3)
  })
})
