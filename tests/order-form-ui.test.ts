import { describe, expect, it } from 'vitest'
import type { Quote, QuoteState } from '../src/types/quote'

const quote = (over: Partial<Quote> = {}): Quote => ({
  listPrice: 4, tier: { slug: 'silver', percentage: 2, discount: 0.08 }, promo: { applied: true, discount: 0.392 }, finalPrice: 3.528, totalDiscount: 0.472, discountReduced: false, ...over,
})

const render = async (build: (m: { PriceSummary: any; PromoField: any }) => unknown) => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { PriceSummary } = await import('../src/components/services/PriceSummary')
  const { PromoField } = await import('../src/components/services/PromoField')
  const el = build({ PriceSummary, PromoField }) as [unknown, Record<string, unknown>]
  return renderToStaticMarkup(createElement(el[0] as never, el[1]))
}

const summary = (state: QuoteState, over: Record<string, unknown> = {}) => render(({ PriceSummary }) => [PriceSummary, {
  quantity: 1000, ratePer1000: 4, estimateUnits: 40_000, state, balance: 10, sufficient: true, shortfallUnits: 0, ...over,
}])

describe('displayedTotalUnits', () => {
  it('uses the server quote when it is in, the previous quote while a new one loads, the list-price estimate otherwise', async () => {
    const { displayedTotalUnits } = await import('../src/components/services/PriceSummary')
    expect(displayedTotalUnits({ kind: 'ready', quote: quote(), promoError: null }, 40_000)).toEqual({ units: 35_280, estimated: false })
    expect(displayedTotalUnits({ kind: 'loading', previous: quote() }, 40_000)).toEqual({ units: 35_280, estimated: true })
    expect(displayedTotalUnits({ kind: 'loading', previous: null }, 40_000)).toEqual({ units: 40_000, estimated: true })
    expect(displayedTotalUnits({ kind: 'error', message: 'x' }, 40_000)).toEqual({ units: 40_000, estimated: true })
    expect(displayedTotalUnits({ kind: 'idle' }, 0)).toEqual({ units: 0, estimated: true })
  })
})

describe('PriceSummary', () => {
  it('shows the list price struck through, the tier and promo discounts and the final price', async () => {
    const html = await summary({ kind: 'ready', quote: quote(), promoError: null })
    for (const text of ['List price', 'line-through', '$4.00', 'Silver tier', '−2%', '−$0.08', 'Promo code', '−$0.392', '$3.528']) expect(html).toContain(text)
    expect(html).not.toContain('aria-label="Calculating the price"')
  })

  it('without discounts it shows only the price', async () => {
    const html = await summary({ kind: 'ready', quote: quote({ finalPrice: 4, totalDiscount: 0, tier: { slug: 'bronze', percentage: 0, discount: 0 }, promo: { applied: false, discount: 0 } }), promoError: null })
    expect(html).not.toContain('List price')
    expect(html).toContain('$4.00')
  })

  it('first load: a skeleton instead of a number; later loads keep the last price, dimmed, with a spinner', async () => {
    const first = await summary({ kind: 'loading', previous: null })
    expect(first).toContain('aria-label="Calculating the price"')
    expect(first).toContain('aria-busy="true"')
    const later = await summary({ kind: 'loading', previous: quote() })
    expect(later).toContain('$3.528')
    expect(later).toContain('opacity-50')
    expect(later).toContain('aria-label="Updating the price"')
  })

  it('a failed quote falls back to the list price and says so', async () => {
    const html = await summary({ kind: 'error', message: 'Could not refresh the price.' })
    expect(html).toContain('$4.00')
    expect(html).toContain('Showing the list price')
    expect(html).toContain('applied when you order')
  })

  it('a discount that was limited says so', async () => {
    expect(await summary({ kind: 'ready', quote: quote({ discountReduced: true }), promoError: null })).toContain('Your discount was limited for this order.')
  })

  it('no valid quantity: a prompt, no price, no balance verdict', async () => {
    const html = await summary({ kind: 'idle' }, { quantity: null, estimateUnits: 0 })
    expect(html).toContain('Enter a valid quantity to see the price.')
    expect(html).not.toContain('Insufficient balance')
    expect(html).not.toContain('Enough balance')
  })

  it('balance verdict follows the FINAL price: enough, or how much is missing', async () => {
    expect(await summary({ kind: 'ready', quote: quote(), promoError: null }, { sufficient: true })).toContain('aria-label="Enough balance"')
    const short = await summary({ kind: 'ready', quote: quote(), promoError: null }, { sufficient: false, shortfallUnits: 5_280 })
    expect(short).toContain('aria-label="Insufficient balance"')
    expect(short).toContain('You need $0.528 more')
  })
})

describe('PromoField', () => {
  const field = (value: string, state: QuoteState, disabled = false) => render(({ PromoField }) => [PromoField, { value, onChange: () => {}, state, disabled }])

  it('empty and optional, with the code upper-cased by CSS and typed text restricted to code characters', async () => {
    const html = await field('', { kind: 'idle' })
    expect(html).toContain('Promo code')
    expect(html).toContain('(optional)')
    expect(html).toContain('maxLength="32"')
    expect(html).not.toContain('role="alert"')
  })

  it('a refused code shows the reason on the field', async () => {
    const html = await field('OLD', { kind: 'ready', quote: quote({ promo: { applied: false, discount: 0 }, totalDiscount: 0.08 }), promoError: 'This promo code is no longer valid.' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('This promo code is no longer valid.')
    expect(html).toContain('aria-invalid="true"')
  })

  it('an accepted code is confirmed', async () => {
    const html = await field('SUMMER10', { kind: 'ready', quote: quote(), promoError: null })
    expect(html).toContain('Promo code applied.')
    expect(html).toContain('border-emerald-300')
  })

  it('does not claim success while the price is loading or when the code gave nothing', async () => {
    expect(await field('SUMMER10', { kind: 'loading', previous: quote() })).not.toContain('Promo code applied.')
    expect(await field('SUMMER10', { kind: 'ready', quote: quote({ promo: { applied: false, discount: 0 } }), promoError: null })).not.toContain('Promo code applied.')
  })

  it('can be disabled while an order is being placed', async () => {
    expect(await field('X', { kind: 'idle' }, true)).toContain('disabled=""')
  })
})
