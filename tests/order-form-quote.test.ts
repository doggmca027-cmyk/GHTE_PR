import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUOTE_CACHE_MS, QUOTE_DEBOUNCE_MS, createQuoteController, type QuoteFetcher } from '../src/lib/quote-controller'
import { QuoteApiError } from '../src/services/api/quote-errors'
import { MOCK_PROMO_CODE, mockQuote, mockQuoteUnits } from '../src/services/api/mock-quote'
import { MOCK_CATALOG } from '../src/constants/dev'
import { calcTotalUnits } from '../src/lib/order-calc'
import type { Quote, QuoteState } from '../src/types/quote'
import type { AuthSession } from '../src/services/api/auth'

const SERVICE = '00000000-0000-4000-8000-0000000000aa'
const quote = (final: number, extra: Partial<Quote> = {}): Quote => ({
  listPrice: final, tier: { slug: 'bronze', percentage: 0, discount: 0 }, promo: { applied: false, discount: 0 }, finalPrice: final, totalDiscount: 0, discountReduced: false, ...extra,
})

describe('quote controller: debounce, one request in flight, no repeats', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setup = (impl?: QuoteFetcher) => {
    const states: QuoteState[] = []
    const fetchQuote = vi.fn<QuoteFetcher>(impl ?? (async (r) => quote(r.quantity / 100)))
    const c = createQuoteController({ fetchQuote, onState: (s) => states.push(s) })
    return { c, fetchQuote, states, last: () => states[states.length - 1] }
  }
  const settle = async (ms = QUOTE_DEBOUNCE_MS) => { await vi.advanceTimersByTimeAsync(ms) }

  it('typing "5", "50", "500" in quick succession sends exactly ONE request, after the last keystroke', async () => {
    const { c, fetchQuote, last } = setup()
    c.update({ serviceId: SERVICE, quantity: 5 })
    await settle(100)
    c.update({ serviceId: SERVICE, quantity: 50 })
    await settle(100)
    c.update({ serviceId: SERVICE, quantity: 500 })
    await settle(QUOTE_DEBOUNCE_MS - 1)
    expect(fetchQuote).not.toHaveBeenCalled() // still waiting for the typing to stop
    await settle(1)
    expect(fetchQuote).toHaveBeenCalledTimes(1)
    expect(fetchQuote.mock.calls[0][0]).toEqual({ serviceId: SERVICE, quantity: 500 })
    expect(last()).toMatchObject({ kind: 'ready', quote: { finalPrice: 5 }, promoError: null })
  })

  it('shows loading right away and keeps the previous price on screen meanwhile', async () => {
    const { c, last, states } = setup()
    c.update({ serviceId: SERVICE, quantity: 100 })
    expect(last()).toEqual({ kind: 'loading', previous: null })
    await settle()
    c.update({ serviceId: SERVICE, quantity: 200 })
    expect(last()).toMatchObject({ kind: 'loading', previous: { finalPrice: 1 } })
    await settle()
    expect(last()).toMatchObject({ kind: 'ready', quote: { finalPrice: 2 } })
    expect(states.filter((s) => s.kind === 'ready')).toHaveLength(2)
  })

  it('an unchanged input sends nothing; going back to a recent input is answered from memory', async () => {
    const { c, fetchQuote, last } = setup()
    c.update({ serviceId: SERVICE, quantity: 100 })
    await settle()
    c.update({ serviceId: SERVICE, quantity: 100 })
    c.update({ serviceId: SERVICE, quantity: 100, promoCode: '' })
    await settle()
    expect(fetchQuote).toHaveBeenCalledTimes(1)
    c.update({ serviceId: SERVICE, quantity: 300 })
    await settle()
    c.update({ serviceId: SERVICE, quantity: 100 })
    expect(last()).toMatchObject({ kind: 'ready', quote: { finalPrice: 1 } }) // instantly, no timer
    await settle()
    expect(fetchQuote).toHaveBeenCalledTimes(2)
  })

  it('remembered answers expire', async () => {
    const { c, fetchQuote } = setup()
    c.update({ serviceId: SERVICE, quantity: 100 })
    await settle()
    c.update({ serviceId: SERVICE, quantity: 300 })
    await settle(QUOTE_CACHE_MS + 1)
    c.update({ serviceId: SERVICE, quantity: 100 })
    await settle()
    expect(fetchQuote).toHaveBeenCalledTimes(3)
  })

  it('a slow answer of a superseded request is dropped and its request is aborted', async () => {
    const resolvers: Array<(q: Quote) => void> = []
    const signals: AbortSignal[] = []
    const { c, last } = setup((r, signal) => {
      signals.push(signal)
      return new Promise<Quote>((resolve) => { resolvers.push(() => resolve(quote(r.quantity))) })
    })
    c.update({ serviceId: SERVICE, quantity: 111 })
    await settle()
    c.update({ serviceId: SERVICE, quantity: 222 }) // while 111 is still in flight
    expect(signals[0].aborted).toBe(true)
    await settle()
    resolvers[1](quote(222))
    await settle(0)
    expect(last()).toMatchObject({ kind: 'ready', quote: { finalPrice: 222 } })
    resolvers[0](quote(111)) // the old one finally answers
    await settle(0)
    expect(last()).toMatchObject({ kind: 'ready', quote: { finalPrice: 222 } }) // and is ignored
  })

  it('no valid quantity cancels everything and returns to idle', async () => {
    const { c, fetchQuote, last } = setup()
    c.update({ serviceId: SERVICE, quantity: 100 })
    c.update(null)
    await settle(2000)
    expect(fetchQuote).not.toHaveBeenCalled()
    expect(last()).toEqual({ kind: 'idle' })
  })

  it('a refused promo code: the price WITHOUT the code is fetched once, with the reason', async () => {
    const { c, fetchQuote, last } = setup(async (r) => {
      if (r.promoCode) throw new QuoteApiError('promo_expired', 'This promo code is no longer valid.')
      return quote(4)
    })
    c.update({ serviceId: SERVICE, quantity: 1000, promoCode: 'OLD' })
    await settle()
    expect(fetchQuote).toHaveBeenCalledTimes(2)
    expect(fetchQuote.mock.calls[1][0]).toEqual({ serviceId: SERVICE, quantity: 1000 })
    expect(last()).toEqual({ kind: 'ready', quote: expect.objectContaining({ finalPrice: 4 }), promoError: 'This promo code is no longer valid.' })
  })

  it('other failures become an error state, never an exception; the next input recovers', async () => {
    let fail = true
    const { c, last } = setup(async (r) => {
      if (fail) throw new QuoteApiError('network', 'Could not refresh the price.')
      return quote(r.quantity)
    })
    c.update({ serviceId: SERVICE, quantity: 100 })
    await settle()
    expect(last()).toEqual({ kind: 'error', message: 'Could not refresh the price.' })
    fail = false
    c.update({ serviceId: SERVICE, quantity: 101 })
    await settle()
    expect(last()).toMatchObject({ kind: 'ready', quote: { finalPrice: 101 } })
  })

  it('invalidate() forgets remembered answers; dispose() silences everything', async () => {
    const { c, fetchQuote, states } = setup()
    c.update({ serviceId: SERVICE, quantity: 100 })
    await settle()
    c.invalidate()
    c.update({ serviceId: SERVICE, quantity: 100 })
    await settle()
    expect(fetchQuote).toHaveBeenCalledTimes(2)
    c.update({ serviceId: SERVICE, quantity: 999 })
    c.dispose()
    const n = states.length
    await settle(2000)
    expect(fetchQuote).toHaveBeenCalledTimes(2)
    expect(states.length).toBe(n)
  })
})

describe('dev mock quote: the same order of operations as the real engine, and the order charges what the quote said', () => {
  const service = MOCK_CATALOG.services[0]

  it('list - tier - promo, in 1e-4 units', () => {
    const u = mockQuoteUnits(service.ratePer1000, 1000)
    expect(u.final).toBe(u.list - u.tier)
    const withPromo = mockQuoteUnits(service.ratePer1000, 1000, MOCK_PROMO_CODE.toLowerCase())
    expect(withPromo.promo).toBe(Math.floor(((withPromo.list - withPromo.tier) * 10 * 2 + 100) / 200))
    expect(withPromo.final).toBe(withPromo.list - withPromo.tier - withPromo.promo)
    expect(u.list).toBe(calcTotalUnits(1000, service.ratePer1000))
  })

  it('an unknown code is refused as a promo problem; an unknown service as unavailable', () => {
    try { mockQuote({ serviceId: service.id, quantity: 100, promoCode: 'NOPE' }); expect.unreachable() } catch (e) {
      expect(e).toBeInstanceOf(QuoteApiError)
      expect((e as QuoteApiError).isPromoProblem).toBe(true)
    }
    expect(() => mockQuote({ serviceId: 'x', quantity: 100 })).toThrow(/no longer available/)
  })
})

describe('getQuote / createOrder over HTTP', () => {
  const fetchMock = vi.fn()
  const session = (isMock = false): AuthSession => ({ token: 'jwt-token', expiresAt: 0, isMock, wallet: { balance: 100, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: false } })

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
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

  it('getQuote posts serviceId, quantity and the code with the user JWT, and returns the quote', async () => {
    reply(200, { success: true, ...quote(3.5, { listPrice: 4, totalDiscount: 0.5 }) })
    const { getQuote } = await import('../src/services/api/quotes')
    const q = await getQuote(session(), { serviceId: SERVICE, quantity: 1000, promoCode: 'SUMMER10' })
    expect(q).toMatchObject({ listPrice: 4, finalPrice: 3.5, totalDiscount: 0.5 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/quote-order')
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
    expect(JSON.parse(init.body)).toEqual({ serviceId: SERVICE, quantity: 1000, promoCode: 'SUMMER10' })
  })

  it('without a code the body has no promoCode; no price field is ever sent', async () => {
    reply(200, { success: true, ...quote(4) })
    const { getQuote } = await import('../src/services/api/quotes')
    await getQuote(session(), { serviceId: SERVICE, quantity: 5 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ serviceId: SERVICE, quantity: 5 })
  })

  it('maps promo errors (409/404) to promo problems with the server message, other failures to network / server', async () => {
    const { getQuote } = await import('../src/services/api/quotes')
    reply(409, { success: false, error: 'promo_exhausted', message: 'This promo code has been used up.' })
    const e1 = (await getQuote(session(), { serviceId: SERVICE, quantity: 5, promoCode: 'X' }).catch((e) => e)) as QuoteApiError
    expect([e1.code, e1.isPromoProblem, e1.message]).toEqual(['promo_exhausted', true, 'This promo code has been used up.'])
    reply(404, { success: false, error: 'promo_not_found', message: 'This promo code does not exist.' })
    expect(((await getQuote(session(), { serviceId: SERVICE, quantity: 5, promoCode: 'X' }).catch((e) => e)) as QuoteApiError).code).toBe('promo_not_found')
    reply(500, { success: false, error: 'server_error' })
    expect(((await getQuote(session(), { serviceId: SERVICE, quantity: 5 }).catch((e) => e)) as QuoteApiError).code).toBe('server')
    reply(401, { success: false })
    expect(((await getQuote(session(), { serviceId: SERVICE, quantity: 5 }).catch((e) => e)) as QuoteApiError).code).toBe('unauthorized')
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'))
    const e2 = (await getQuote(session(), { serviceId: SERVICE, quantity: 5 }).catch((e) => e)) as QuoteApiError
    expect([e2.code, e2.isPromoProblem]).toEqual(['network', false])
  })

  it('a request superseded on purpose surfaces as an abort, not as an error', async () => {
    const ctl = new AbortController()
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      ctl.abort()
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response('{}')
    })
    const { getQuote } = await import('../src/services/api/quotes')
    const err = await getQuote(session(), { serviceId: SERVICE, quantity: 5 }, ctl.signal).catch((e) => e)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
  })

  it('createOrder sends the promo code (and still no price), and maps promo refusals', async () => {
    const { createOrder } = await import('../src/services/api/orders')
    reply(200, { success: true, order: { id: 'o1', status: 'submitted', chargeAmount: 3.5, quantity: 1000, targetUrl: 'https://t.me/x' } })
    await createOrder(session(), { serviceId: SERVICE, targetUrl: 'https://t.me/x', quantity: 1000, idempotencyKey: 'key-12345678', promoCode: 'SUMMER10' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ serviceId: SERVICE, targetUrl: 'https://t.me/x', quantity: 1000, idempotencyKey: 'key-12345678', promoCode: 'SUMMER10' })

    reply(409, { success: false, error: 'promo_already_used', message: 'You have already used this promo code.' })
    const err = (await createOrder(session(), { serviceId: SERVICE, targetUrl: 'https://t.me/x', quantity: 1000, idempotencyKey: 'key-12345679', promoCode: 'SUMMER10' }).catch((e) => e)) as { code: string; message: string; isDefinitive: boolean }
    expect([err.code, err.message, err.isDefinitive]).toEqual(['promo_already_used', 'You have already used this promo code.', true])

    reply(200, { success: true, order: { id: 'o2', status: 'submitted', chargeAmount: 4, quantity: 5, targetUrl: 'https://t.me/x' } })
    await createOrder(session(), { serviceId: SERVICE, targetUrl: 'https://t.me/x', quantity: 5, idempotencyKey: 'key-12345670' })
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('promoCode')
  })

  it('dev mock: the order is charged exactly what the quote showed, promo included', async () => {
    const { getQuote } = await import('../src/services/api/quotes')
    const { createOrder } = await import('../src/services/api/orders')
    const s = session(true)
    const svc = MOCK_CATALOG.services[0]
    const q = await getQuote(s, { serviceId: svc.id, quantity: svc.minQuantity, promoCode: MOCK_PROMO_CODE })
    const r = await createOrder(s, { serviceId: svc.id, targetUrl: 'https://t.me/mockchannel', quantity: svc.minQuantity, idempotencyKey: `mock-key-${Date.now()}`, promoCode: MOCK_PROMO_CODE })
    expect(r.order.chargeAmount).toBe(q.finalPrice)
    expect(q.finalPrice).toBeLessThan(q.listPrice)
    await expect(createOrder(s, { serviceId: svc.id, targetUrl: 'https://t.me/mockchannel', quantity: svc.minQuantity, idempotencyKey: `mock-key-bad-${Date.now()}`, promoCode: 'NOPE' })).rejects.toMatchObject({ code: 'promo_not_found' })
  })
})
