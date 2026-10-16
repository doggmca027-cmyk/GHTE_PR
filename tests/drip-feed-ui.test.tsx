// @vitest-environment jsdom
// Drip-feed, part 4: the quote request, the catalogue flag, the sync step that keeps it, and the order form fields.
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapQuoteError, parseQuoteBody } from '../supabase/functions/_shared/discounts.ts'
import { syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run.ts'
import { silentLogger } from '../supabase/functions/_shared/logger.ts'
import { MAX_DRIP_RUNS, orderShape, validateDripSchedule } from '../src/lib/drip-feed'
import { SERVICE_COLUMNS, serviceFromRow } from '../src/services/api/services'
import { createQuoteController } from '../src/lib/quote-controller'
import { DripFeedFields } from '../src/components/services/DripFeedFields'
import type { QuoteRequest } from '../src/types/quote'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SVC = '11111111-1111-4111-8111-111111111111'

describe('quote-order body', () => {
  it('runs is optional (a plain quote is unchanged) and validated like place-order', () => {
    expect(parseQuoteBody({ serviceId: SVC, quantity: 100 })).toEqual({ ok: true, value: { serviceId: SVC, quantity: 100, promoCode: null } })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 100, runs: 1 })).toEqual({ ok: true, value: { serviceId: SVC, quantity: 100, promoCode: null } })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 5000, runs: 5 })).toEqual({ ok: true, value: { serviceId: SVC, quantity: 5000, promoCode: null, runs: 5 } })
    for (const runs of [0, -1, 2.5, '5', MAX_DRIP_RUNS + 1]) expect(parseQuoteBody({ serviceId: SVC, quantity: 5000, runs })).toMatchObject({ ok: false })
    expect(parseQuoteBody({ serviceId: SVC, quantity: 1000, runs: 3 })).toEqual({ ok: false, message: 'quantity must divide evenly by runs.' })
  })

  it('the split error of the database reads as a sentence', () => {
    expect(mapQuoteError('invalid_parameter_value: quantity must split evenly into runs')).toEqual({ status: 400, error: 'invalid_input', message: 'The quantity must divide evenly by the number of deliveries.' })
    expect(mapQuoteError('invalid_parameter_value: something else')).toMatchObject({ message: 'Invalid input.' })
  })
})

describe('catalogue flag', () => {
  const row = { id: 's', category_id: 'c', name: 'S', description: null, customer_rate_per_1000: 1, min_quantity: 10, max_quantity: 1000, refill_supported: false, sort_order: 0 }
  it('the app reads services.dripfeed_available; the service carries it only when true', () => {
    expect(SERVICE_COLUMNS).toContain('dripfeed_available')
    expect(serviceFromRow({ ...row, dripfeed_available: true }).dripfeedAvailable).toBe(true)
    expect(serviceFromRow({ ...row, dripfeed_available: false })).not.toHaveProperty('dripfeedAvailable')
    expect(serviceFromRow(row)).not.toHaveProperty('dripfeedAvailable')
  })

  it('every sync run rebuilds it (also for a donor), and a failure there never fails the sync', async () => {
    const store = (refresh: () => Promise<number>): CatalogStore => ({
      loadProviderServices: async () => [], upsertProviderServices: async () => [], flagAnomaly: async () => {}, loadOffers: async () => [], updateOffers: async () => {},
      deactivateProviderServices: async () => {}, loadLinkedServices: async () => [], loadServiceOffers: async () => [], updateServices: async () => {},
      saveBalance: async () => {}, refreshDripFeed: refresh,
    } as unknown as CatalogStore)
    const one = { externalServiceId: '1', name: 'A', type: 'Default', categoryRaw: 'c', ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false, dripfeedSupported: true }
    const adapter = { getServices: async () => [one], getBalance: async () => ({ balance: 1, currency: 'USD' }) }
    const refresh = vi.fn(async () => 3)
    const donor = { id: 'p', name: 'Donor', routing_enabled: true, catalog_mode: 'linked_only' as const }
    expect(await syncProviderCatalog({ provider: donor, adapter, store: store(refresh), rules: [], log: silentLogger })).toMatchObject({ status: 'ok', dripfeedChanged: 3 })
    expect(refresh).toHaveBeenCalledTimes(1)
    const failing = await syncProviderCatalog({ provider: donor, adapter, store: store(async () => { throw new Error('db down') }), rules: [], log: silentLogger })
    expect(failing.status).toBe('ok')
    expect(failing).not.toHaveProperty('dripfeedChanged')
  })
})

describe('order form maths', () => {
  it('schedule: 2..1000 runs, 1..10080 minutes', () => {
    expect(validateDripSchedule('5', '30')).toEqual({ ok: true, runs: 5, interval: 30 })
    expect(validateDripSchedule('1', '30')).toEqual({ ok: false, field: 'runs' })
    expect(validateDripSchedule('1001', '30')).toEqual({ ok: false, field: 'runs' })
    expect(validateDripSchedule('', '30')).toEqual({ ok: false, field: 'runs' })
    expect(validateDripSchedule('5', '0')).toEqual({ ok: false, field: 'interval' })
    expect(validateDripSchedule('5', '10081')).toEqual({ ok: false, field: 'interval' })
  })

  it('what is sent: the TOTAL quantity, with runs / interval only for drip-feed', () => {
    const s = validateDripSchedule('5', '30')
    expect(orderShape(1000, true, s)).toEqual({ quantity: 5000, runs: 5, interval: 30 })
    expect(orderShape(1000, false, s)).toEqual({ quantity: 1000, runs: 1, interval: 0 })
    expect(orderShape(null, true, s)).toBeNull()
    expect(orderShape(1000, true, validateDripSchedule('5', ''))).toBeNull()
  })

  it('the quote controller prices a new schedule again (runs is part of the request key)', async () => {
    vi.useFakeTimers()
    try {
      const fetchQuote = vi.fn(async (r: QuoteRequest) => ({ listPrice: r.quantity, tier: { slug: null, percentage: 0, discount: 0 }, promo: { applied: false, discount: 0 }, finalPrice: r.quantity, totalDiscount: 0, discountReduced: false }))
      const c = createQuoteController({ fetchQuote, onState: () => {} })
      c.update({ serviceId: SVC, quantity: 5000 })
      await vi.advanceTimersByTimeAsync(2000)
      c.update({ serviceId: SVC, quantity: 5000, runs: 5 })
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchQuote.mock.calls.map((call) => call[0])).toEqual([{ serviceId: SVC, quantity: 5000 }, { serviceId: SVC, quantity: 5000, runs: 5 }])
      c.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the requests the app sends', () => {
  const fetchMock = vi.fn()
  const session = { token: 'jwt', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: false } }
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>

  it('quote: runs only when above 1', async () => {
    const { getQuote } = await import('../src/services/api/quotes')
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, listPrice: 1, finalPrice: 1 }), { status: 200 }))
    await getQuote(session, { serviceId: SVC, quantity: 5000, runs: 5 })
    expect(sentBody()).toEqual({ serviceId: SVC, quantity: 5000, runs: 5 })
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, listPrice: 1, finalPrice: 1 }), { status: 200 }))
    await getQuote(session, { serviceId: SVC, quantity: 5000, runs: 1 })
    expect(sentBody()).toEqual({ serviceId: SVC, quantity: 5000 })
  })

  it('order: total quantity plus runs and interval', async () => {
    const { createOrder } = await import('../src/services/api/orders')
    const order = { id: 'o', status: 'submitted', chargeAmount: 1, quantity: 5000, targetUrl: 'https://t.me/x' }
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, order }), { status: 200 }))
    await createOrder(session, { serviceId: SVC, targetUrl: 'https://t.me/x', quantity: 5000, idempotencyKey: 'key-12345678', runs: 5, interval: 30 })
    expect(sentBody()).toEqual({ serviceId: SVC, targetUrl: 'https://t.me/x', quantity: 5000, idempotencyKey: 'key-12345678', runs: 5, interval: 30 })
  })
})

describe('DripFeedFields', () => {
  function Harness({ perRun }: { perRun: number | null }) {
    const [on, setOn] = useState(false)
    const [runs, setRuns] = useState('2')
    const [interval, setInterval] = useState('30')
    return createElement(DripFeedFields, {
      enabled: on, onToggle: setOn, runs, onRuns: setRuns, interval, onInterval: setInterval,
      schedule: validateDripSchedule(runs, interval), perRun, disabled: false,
    })
  }
  const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('off: only the switch; on: runs, interval and the computed total; a bad value says its bound', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(Harness, { perRun: 1000 })))
    const sw = host.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelectorAll('input')).toHaveLength(0)
    act(() => sw.click())
    const [runs, interval] = [...host.querySelectorAll('input')] as HTMLInputElement[]
    expect(host.querySelector('[data-testid="drip-total"]')!.textContent).toContain('1,000 × 2 = 2,000')
    type(runs, '5')
    expect(host.querySelector('[data-testid="drip-total"]')!.textContent).toContain('1,000 × 5 = 5,000')
    type(interval, '0')
    expect(host.textContent).toContain('Enter from 1 to 10,080 minutes')
    expect(host.querySelector('[data-testid="drip-total"]')!.textContent).toContain('—')
    type(interval, '15')
    type(runs, '1')
    expect(host.textContent).toContain('Enter from 2 to 1,000 runs')
    act(() => root.unmount())
  })
})
