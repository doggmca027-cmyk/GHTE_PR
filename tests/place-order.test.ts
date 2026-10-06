import { describe, expect, it, vi } from 'vitest'
import { signJwt, verifyJwt } from '../supabase/functions/_shared/jwt.ts'
import { deriveIdempotencyKey, parsePlaceOrderBody, validateQuantity, validateTargetUrl } from '../supabase/functions/_shared/order-validation.ts'
import {
  IN_FLIGHT_NOTE,
  NEEDS_RECONCILIATION,
  PlaceOrderDbError,
  classifyProviderError,
  executePlaceOrder,
  mapDbError,
  type OrderPatch,
  type OrderRecord,
  type PlaceOrderPorts,
  type PlaceOrderRequest,
} from '../supabase/functions/_shared/place-order-flow.ts'
import { SMMProviderError } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { buildCandidates, costForQuantity, resolveOffer, type OfferRow } from '../supabase/functions/_shared/routing.ts'
import { MOCK_CATALOG } from '../src/constants/dev'
import { createMockBackend, MOCK_COMPLETED_MS, MOCK_SUBMITTED_MS } from '../src/services/api/mock-orders'
import { OrderApiError } from '../src/services/api/order-errors'
import { deliveredRatio, matchesFilter, statusMeta, truncateUrl, type OrderFilter } from '../src/lib/order-view'
import type { OrderStatus } from '../supabase/functions/_shared/types.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'

// ---------------------------------------------------------------------------
// 1. Input validation
// ---------------------------------------------------------------------------

describe('place-order body validation', () => {
  const body = { serviceId: SERVICE, targetUrl: 'https://t.me/channel', quantity: 1000, idempotencyKey: 'abcdef12-3456' }

  it('accepts a valid body and normalises the URL', () => {
    expect(parsePlaceOrderBody(body)).toEqual({
      ok: true,
      value: { serviceId: SERVICE, targetUrl: 'https://t.me/channel', quantity: 1000, clientKey: 'abcdef12-3456' },
    })
    expect(parsePlaceOrderBody({ ...body, targetUrl: 't.me/channel', idempotencyKey: undefined })).toMatchObject({
      ok: true, value: { targetUrl: 'https://t.me/channel', clientKey: undefined },
    })
  })

  it('discards every client-supplied price / user field', () => {
    const res = parsePlaceOrderBody({ ...body, price: 0.0001, rate: 0.01, total: 0, chargeAmount: 0, userId: OTHER_USER, customer_rate_per_1000: 0 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(Object.keys(res.value).sort()).toEqual(['clientKey', 'quantity', 'serviceId', 'targetUrl'])
  })

  it.each([
    ['not an object', 'hello'],
    ['array', [1]],
    ['null', null],
    ['bad service id', { ...body, serviceId: 'nope' }],
    ['sql-ish service id', { ...body, serviceId: `${SERVICE}'; drop table orders;--` }],
    ['missing url', { ...body, targetUrl: undefined }],
    ['numeric url', { ...body, targetUrl: 5 }],
    ['string quantity', { ...body, quantity: '1000' }],
    ['float quantity', { ...body, quantity: 10.5 }],
    ['zero quantity', { ...body, quantity: 0 }],
    ['negative quantity', { ...body, quantity: -5 }],
    ['unsafe quantity', { ...body, quantity: 1e20 }],
    ['short key', { ...body, idempotencyKey: 'abc' }],
    ['key with separators', { ...body, idempotencyKey: 'abc:def:ghi:jkl' }],
    ['numeric key', { ...body, idempotencyKey: 12345678 }],
  ])('rejects %s', (_name, input) => {
    expect(parsePlaceOrderBody(input)).toMatchObject({ ok: false, error: 'invalid_input' })
  })
})

describe('quantity limits (server side, limits read from the database)', () => {
  it.each([
    [100, true], [1000, true], [1_000_000, true],
    [99, false], [1_000_001, false], [0, false],
  ])('limits 100..1,000,000: %d -> %s', (q, ok) => {
    expect(validateQuantity(String(q), 100, 1_000_000).ok).toBe(ok)
  })
})

describe('URL sanitisation', () => {
  it.each([
    ['https://user:pass@t.me/x', 'username or password'],
    ['https://t.me/a b', 'spaces'],
    ['https://t.me/\u0000x', 'invalid characters'],
    ['javascript:alert(1)', 'valid link'],
    ['data:text/html,<script>', 'valid link'],
    ['file:///etc/passwd', 'valid link'],
    ['ftp://example.com/x', 'valid link'],
    ['https://localhost/x', 'valid link'],
    ['http://[::1]/x', 'valid link'],
    ['', 'Paste the link'],
  ])('rejects %j', (url, reason) => {
    const res = validateTargetUrl(url)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain(reason)
  })

  it('trims, lowercases the host and keeps path and query intact', () => {
    expect(validateTargetUrl('  HTTPS://T.me/Channel?start=1  ')).toEqual({ ok: true, value: 'https://t.me/Channel?start=1' })
  })
})

// ---------------------------------------------------------------------------
// 2. Idempotency
// ---------------------------------------------------------------------------

describe('idempotency key derivation', () => {
  it('is deterministic per (user, client key)', () => {
    expect(deriveIdempotencyKey(USER, 'abcdef12')).toBe(deriveIdempotencyKey(USER, 'abcdef12'))
    expect(deriveIdempotencyKey(USER, 'abcdef12')).toBe(`po:${USER}:abcdef12`)
  })

  it('is namespaced by user, so identical client keys never collide across users', () => {
    expect(deriveIdempotencyKey(USER, 'abcdef12')).not.toBe(deriveIdempotencyKey(OTHER_USER, 'abcdef12'))
  })

  it('is unique per request when the client sends none', () => {
    const a = deriveIdempotencyKey(USER)
    expect(a).toMatch(new RegExp(`^po:${USER}:auto:`))
    expect(a).not.toBe(deriveIdempotencyKey(USER))
  })
})

// ---------------------------------------------------------------------------
// Fake persistence + provider for the execution flow
// ---------------------------------------------------------------------------

function fakeWorld(opts: { failUpdates?: (patch: OrderPatch, n: number) => boolean; failRefund?: boolean } = {}) {
  const orders = new Map<string, OrderRecord>()
  const byKey = new Map<string, string>()
  const trail: string[] = []
  let seq = 0
  let updateCalls = 0
  const wallet = { balance: 100 }

  const ports: PlaceOrderPorts = {
    async placeOrder(a) {
      const existing = byKey.get(a.idempotencyKey)
      if (existing) return { ...orders.get(existing)! }
      const id = `order-${++seq}`
      const order: OrderRecord = {
        id, user_id: a.userId, service_id: a.serviceId, target_url: a.targetUrl, quantity: a.quantity,
        charge_amount: 2.5, status: 'paid', provider_order_id: null, error_message: null,
      }
      wallet.balance -= order.charge_amount
      orders.set(id, order)
      byKey.set(a.idempotencyKey, id)
      trail.push('debit')
      return { ...order }
    },
    async claim(id) {
      await Promise.resolve() // interleave concurrent callers
      const o = orders.get(id)!
      if (o.status !== 'paid') return null
      o.status = 'processing'
      o.error_message = IN_FLIGHT_NOTE
      trail.push('claim')
      return { ...o }
    },
    async get(id) { return { ...orders.get(id)! } },
    async update(id, patch) {
      updateCalls++
      if (opts.failUpdates?.(patch, updateCalls)) throw new PlaceOrderDbError('connection reset')
      const o = orders.get(id)!
      Object.assign(o, patch)
      trail.push(`update:${patch.status}`)
      return { ...o }
    },
    async refund(id, comment) {
      if (opts.failRefund) throw new PlaceOrderDbError('refund_order failed')
      const o = orders.get(id)!
      o.status = 'refunded'
      wallet.balance += o.charge_amount
      trail.push(`refund:${comment}`)
      return { ...o }
    },
  }
  return { ports, orders, trail, wallet }
}

const silent = { error: vi.fn(), warn: vi.fn() }
const request = (over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  userId: USER, serviceId: SERVICE, targetUrl: 'https://t.me/channel', quantity: 1000,
  idempotencyKey: `po:${USER}:abcdef12`, externalServiceId: '2001',
  providerOfferId: 'offer-1', providerId: 'prov-1', providerServiceId: 'ps-1', costAmount: 0.5, ...over,
})
const adapterThat = (impl: () => Promise<{ orderId: string }>) => ({ createOrder: vi.fn(impl) })

describe('routing -> executePlaceOrder: the chosen offer reaches place_order and the right provider', () => {
  const row = (id: string, provider: string, over: Partial<OfferRow> & { health?: string; routing?: boolean; cost?: number; score?: number; ext?: string } = {}): OfferRow => ({
    id, service_id: SERVICE, provider_id: provider, provider_service_id: `ps-${id}`, cost_per_1000: over.cost ?? 1, min_quantity: 10, max_quantity: 100_000,
    refill_supported: false, cancel_supported: false, is_active: true, routing_score: over.score ?? 0, created_at: 't', updated_at: 't',
    provider_service: { external_service_id: over.ext ?? `ext-${id}`, is_active: true },
    provider: {
      id: provider, name: provider, api_url: `https://${provider}`, api_key_encrypted: null, api_version: 'v2', is_active: true,
      routing_enabled: over.routing ?? true, health_status: (over.health ?? 'healthy') as 'healthy', last_health_check: null, last_balance_sync: null,
      provider_balance: 0, currency: 'USD', priority: 0,
    },
    ...over,
  })

  async function placeVia(rows: OfferRow[], quantity = 1000) {
    const w = fakeWorld()
    const seen: { offerId?: string; providerId?: string; providerServiceId?: string; costAmount?: number } = {}
    const place = w.ports.placeOrder
    w.ports.placeOrder = async (a) => { Object.assign(seen, { offerId: a.providerOfferId, providerId: a.providerId, providerServiceId: a.providerServiceId, costAmount: a.costAmount }); return place(a) }
    const c = buildCandidates(rows)
    const offer = resolveOffer(c.offers, c.providers, { quantity })
    const calls: Array<{ provider: string; serviceId: string }> = []
    const adapter = { createOrder: vi.fn(async (p: { serviceId: string }) => { calls.push({ provider: offer.providerId, serviceId: p.serviceId }); return { orderId: 'P-1' } }) }
    const result = await executePlaceOrder(
      request({ quantity, providerOfferId: offer.id, providerId: offer.providerId, providerServiceId: offer.providerServiceId, costAmount: costForQuantity(offer.costPer1000, quantity), externalServiceId: c.details.get(offer.id)!.externalServiceId }),
      w.ports, adapter, silent,
    )
    return { result, seen, calls }
  }

  it('the best healthy offer is snapshotted and its provider service id is what the adapter receives', async () => {
    const { result, seen, calls } = await placeVia([
      row('cheap-unhealthy', 'p-down', { cost: 0.01, score: 500, health: 'unavailable' }),
      row('cheap-degraded', 'p-slow', { cost: 0.02, score: 400, health: 'degraded' }),
      row('best', 'p-good', { cost: 0.07, score: 50, ext: '9001' }),
      row('worse', 'p-ok', { cost: 0.05, score: 10 }),
    ])
    expect(result.kind).toBe('submitted')
    expect(seen).toEqual({ offerId: 'best', providerId: 'p-good', providerServiceId: 'ps-best', costAmount: 0.07 })
    expect(calls).toEqual([{ provider: 'p-good', serviceId: '9001' }])
  })

  it('on equal scores the cheaper offer wins, and the cost is computed from that offer', async () => {
    const { seen } = await placeVia([row('a', 'pa', { cost: 0.3, score: 5 }), row('b', 'pb', { cost: 0.1234, score: 5 })], 1500)
    expect(seen).toMatchObject({ offerId: 'b', providerId: 'pb', costAmount: 0.1851 })
  })

  it('with only unhealthy / disabled providers nothing is routed (the caller refuses before charging)', () => {
    const c = buildCandidates([row('a', 'pa', { health: 'degraded' }), row('b', 'pb', { routing: false })])
    expect(() => resolveOffer(c.offers, c.providers, { quantity: 1000 })).toThrow(/No provider can fulfil/)
  })
})

describe('executePlaceOrder: replay and concurrency', () => {
  it('a repeated key returns the same order and never contacts the provider twice', async () => {
    const w = fakeWorld()
    const adapter = adapterThat(async () => ({ orderId: 'P-1' }))

    const first = await executePlaceOrder(request(), w.ports, adapter, silent)
    const second = await executePlaceOrder(request(), w.ports, adapter, silent)

    expect(first.kind).toBe('submitted')
    expect(second.kind).toBe('replayed')
    expect(second.order.id).toBe(first.order.id)
    expect(adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.wallet.balance).toBe(97.5) // charged once
  })

  it('simultaneous double-taps result in exactly one provider submission', async () => {
    const w = fakeWorld()
    const adapter = adapterThat(async () => ({ orderId: 'P-1' }))

    const results = await Promise.all([1, 2, 3].map(() => executePlaceOrder(request(), w.ports, adapter, silent)))

    expect(adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.kind === 'submitted')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'replayed')).toHaveLength(2)
    expect(w.wallet.balance).toBe(97.5)
  })

  it('different keys are different orders', async () => {
    const w = fakeWorld()
    const adapter = adapterThat(async () => ({ orderId: 'P' }))
    await executePlaceOrder(request({ idempotencyKey: 'k1' }), w.ports, adapter, silent)
    await executePlaceOrder(request({ idempotencyKey: 'k2' }), w.ports, adapter, silent)
    expect(adapter.createOrder).toHaveBeenCalledTimes(2)
    expect(w.orders.size).toBe(2)
  })
})

describe('executePlaceOrder: provider success', () => {
  it('records the provider order id and clears the in-flight note', async () => {
    const w = fakeWorld()
    const adapter = adapterThat(async () => ({ orderId: 'P-77' }))
    const res = await executePlaceOrder(request(), w.ports, adapter, silent)

    expect(res.kind).toBe('submitted')
    expect(res.order).toMatchObject({ status: 'submitted', provider_order_id: 'P-77', error_message: null })
    expect(adapter.createOrder).toHaveBeenCalledWith({ serviceId: '2001', link: 'https://t.me/channel', quantity: 1000 })
    expect(w.trail).toEqual(['debit', 'claim', 'update:submitted'])
  })

  it('never refunds once the provider accepted, even if bookkeeping fails twice', async () => {
    const w = fakeWorld({ failUpdates: (p) => p.status === 'submitted' })
    const adapter = adapterThat(async () => ({ orderId: 'P-9' }))
    const res = await executePlaceOrder(request(), w.ports, adapter, silent)

    expect(res.kind).toBe('pending')
    expect(w.trail.some((t) => t.startsWith('refund'))).toBe(false)
    expect(res.order.status).toBe('processing')
    expect(res.order.error_message).toContain(NEEDS_RECONCILIATION)
    expect(res.order.error_message).toContain('P-9') // the provider id is preserved for the operator
  })

  it('retries the bookkeeping write once', async () => {
    const w = fakeWorld({ failUpdates: (p, n) => p.status === 'submitted' && n === 1 })
    const res = await executePlaceOrder(request(), w.ports, adapterThat(async () => ({ orderId: 'P-5' })), silent)
    expect(res.kind).toBe('submitted')
    expect(res.order.provider_order_id).toBe('P-5')
  })
})

describe('executePlaceOrder: provider rejects (definitive) -> refund', () => {
  it.each([
    ['invalid link', new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link' }), 'rejected this link'],
    ['provider out of funds', new SMMProviderError('api', 'Not enough funds on balance', { code: 'insufficient_provider_balance' }), 'could not accept'],
    ['HTTP 403', new SMMProviderError('http', 'HTTP 403', { httpStatus: 403 }), 'could not accept'],
    ['misconfigured', new SMMProviderError('misconfigured', 'no url'), 'could not accept'],
  ])('%s', async (_name, error, userText) => {
    const w = fakeWorld()
    const res = await executePlaceOrder(request(), w.ports, adapterThat(async () => { throw error }), silent)

    expect(res.kind).toBe('rejected')
    expect(res.kind === 'rejected' && res.message).toContain(userText)
    expect(res.order.status).toBe('refunded')
    expect(w.wallet.balance).toBe(100) // money fully restored
    // failed (with reason) is recorded BEFORE the refund, so history shows both
    expect(w.trail).toEqual(['debit', 'claim', 'update:failed', 'refund:Provider rejected order'])
    expect(w.orders.get(res.order.id)!.error_message).toContain('provider_rejected')
  })

  it('flags needs_refund when the automatic refund itself fails', async () => {
    const w = fakeWorld({ failRefund: true })
    const err = new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link' })
    const res = await executePlaceOrder(request(), w.ports, adapterThat(async () => { throw err }), silent)

    expect(res.kind).toBe('refund_failed')
    expect(res.order.status).toBe('failed')
    expect(res.order.error_message).toMatch(/^needs_refund/)
    expect(silent.error).toHaveBeenCalled()
  })
})

describe('executePlaceOrder: ambiguous outcome -> hold in processing, never refund', () => {
  it.each([
    ['timeout', new SMMProviderError('timeout', 'add: no response within 10000ms', { ambiguous: true })],
    ['network failure', new SMMProviderError('network', 'add: network failure', { ambiguous: true })],
    ['HTTP 502', new SMMProviderError('http', 'add: HTTP 502', { ambiguous: true, httpStatus: 502 })],
    ['garbled response', new SMMProviderError('invalid_response', 'add: response has no order id', { ambiguous: true })],
    ['unexpected crash', new TypeError('boom')],
  ])('%s', async (_name, error) => {
    const w = fakeWorld()
    const res = await executePlaceOrder(request(), w.ports, adapterThat(async () => { throw error }), silent)

    expect(res.kind).toBe('pending')
    expect(res.order.status).toBe('processing')
    expect(res.order.error_message).toMatch(new RegExp(`^${NEEDS_RECONCILIATION}: `))
    expect(res.order.provider_order_id).toBeNull()
    expect(w.trail.some((t) => t.startsWith('refund'))).toBe(false)
    expect(w.wallet.balance).toBe(97.5) // funds stay held
  })

  it('a crash mid-submission still leaves the in-flight marker on the order', async () => {
    const w = fakeWorld()
    const adapter = adapterThat(() => new Promise<never>(() => {})) // never settles = process died here
    void executePlaceOrder(request(), w.ports, adapter, silent)
    await new Promise((r) => setTimeout(r, 10))

    const [order] = [...w.orders.values()]
    expect(order.status).toBe('processing')
    expect(order.error_message).toBe(IN_FLIGHT_NOTE)
  })

  it('replaying a held order does not resubmit or refund', async () => {
    const w = fakeWorld()
    const adapter = adapterThat(async () => { throw new SMMProviderError('timeout', 'x', { ambiguous: true }) })
    await executePlaceOrder(request(), w.ports, adapter, silent)
    const again = await executePlaceOrder(request(), w.ports, adapter, silent)

    expect(again.kind).toBe('replayed')
    expect(again.order.status).toBe('processing')
    expect(adapter.createOrder).toHaveBeenCalledTimes(1)
    expect(w.trail.some((t) => t.startsWith('refund'))).toBe(false)
  })
})

describe('classifyProviderError', () => {
  it('only refunds on non-ambiguous SMMProviderErrors', () => {
    expect(classifyProviderError(new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link' })).outcome).toBe('refund')
    expect(classifyProviderError(new SMMProviderError('http', '429', { httpStatus: 429, code: 'rate_limited' })).outcome).toBe('refund')
    expect(classifyProviderError(new SMMProviderError('timeout', 't', { ambiguous: true })).outcome).toBe('hold')
    expect(classifyProviderError('weird').outcome).toBe('hold')
    expect(classifyProviderError(undefined).outcome).toBe('hold')
  })
})

// ---------------------------------------------------------------------------
// Database error mapping
// ---------------------------------------------------------------------------

describe('mapDbError', () => {
  it('maps insufficient funds to 402 with the exact shortfall', () => {
    expect(mapDbError('insufficient_funds: available 24.5000, required 27.0000')).toEqual({
      httpStatus: 402, error: 'insufficient_funds', message: 'Insufficient balance.', shortfall: 2.5,
    })
    expect(mapDbError('insufficient_funds: available 0.1000, required 0.3000').shortfall).toBe(0.2) // no float noise
  })

  it.each([
    ['user is banned', 403, 'banned'],
    ['service not found or inactive', 404, 'service_unavailable'],
    ['quantity must be between 50 and 500', 400, 'invalid_input'],
    ['order total is too small', 400, 'invalid_input'],
    ['idempotency key po:x was already used with different parameters', 409, 'idempotency_conflict'],
    ['deadlock detected', 500, 'internal_error'],
  ])('%s -> %d %s', (message, httpStatus, error) => {
    expect(mapDbError(message)).toMatchObject({ httpStatus, error })
  })

  it('never leaks raw database errors to the client', () => {
    expect(mapDbError('relation "orders" does not exist').message).toBe('Something went wrong. You were not charged.')
  })
})

// ---------------------------------------------------------------------------
// JWT verification (auth for place-order)
// ---------------------------------------------------------------------------

describe('verifyJwt', () => {
  const claims = { sub: USER, role: 'authenticated', aud: 'authenticated' }
  const NOW = 1_800_000_000

  it('accepts a token minted by signJwt and returns the user id', async () => {
    const { token } = await signJwt(claims, 'secret', 3600, NOW)
    expect(await verifyJwt(token, 'secret', NOW + 10)).toMatchObject({ sub: USER })
  })

  it('rejects wrong secret, tampered payload, expiry, wrong audience and garbage', async () => {
    const { token } = await signJwt(claims, 'secret', 3600, NOW)
    const [h, p, s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: OTHER_USER, iat: NOW, exp: NOW + 3600 })).toString('base64url')

    expect(await verifyJwt(token, 'other-secret', NOW)).toBeNull()
    expect(await verifyJwt(`${h}.${forged}.${s}`, 'secret', NOW)).toBeNull()
    expect(await verifyJwt(token, 'secret', NOW + 3600)).toBeNull() // expired
    expect(await verifyJwt((await signJwt({ ...claims, aud: 'x' }, 'secret', 3600, NOW)).token, 'secret', NOW)).toBeNull()
    expect(await verifyJwt((await signJwt({ ...claims, role: 'service_role' }, 'secret', 3600, NOW)).token, 'secret', NOW)).toBeNull()
    for (const junk of ['', 'a.b', 'a.b.c', `${h}.${p}`, 'not a token']) expect(await verifyJwt(junk, 'secret', NOW)).toBeNull()
  })

  it('rejects alg=none tokens', async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const none = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ ...claims, exp: NOW + 3600 })}.`
    expect(await verifyJwt(none, 'secret', NOW)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Dev-mode mock backend (powers the end-to-end flow without Supabase)
// ---------------------------------------------------------------------------

describe('mock backend', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
  const members = MOCK_CATALOG.services.find((s) => s.name.includes('Channel Members'))! // $5.40 / 1000
  const pay = (over = {}) => ({ serviceId: members.id, targetUrl: 'https://t.me/mychannel', quantity: 2000, idempotencyKey: 'key-0001', ...over })

  it('deducts the balance and lists the new order first', () => {
    let t = 1_000
    const b = createMockBackend(memory(), () => t)
    expect(b.getWallet().balance).toBe(24.5)

    const res = b.createOrder(pay())
    expect(res.order).toMatchObject({ status: 'submitted', chargeAmount: 10.8, quantity: 2000 })
    expect(res.wallet?.balance).toBe(13.7)
    expect(b.getWallet().balance).toBe(13.7)

    t += 10
    b.createOrder(pay({ idempotencyKey: 'key-0002', quantity: 100 }))
    const list = b.listOrders()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ quantity: 100, platform: 'telegram', serviceName: members.name })
  })

  it('is idempotent: the same key neither charges nor lists twice', () => {
    const b = createMockBackend(memory())
    const first = b.createOrder(pay())
    const again = b.createOrder(pay())
    expect(again.order.id).toBe(first.order.id)
    expect(b.listOrders()).toHaveLength(1)
    expect(b.getWallet().balance).toBe(13.7)
  })

  it('rejects insufficient funds with the exact shortfall and leaves state untouched', () => {
    const b = createMockBackend(memory())
    try {
      b.createOrder(pay({ quantity: 5000 })) // $27.00 vs $24.50
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(OrderApiError)
      expect(e).toMatchObject({ code: 'insufficient_funds', shortfall: 2.5 })
    }
    expect(b.getWallet().balance).toBe(24.5)
    expect(b.listOrders()).toHaveLength(0)
  })

  it('validates link, quantity and service like the server does', () => {
    const b = createMockBackend(memory())
    expect(() => b.createOrder(pay({ targetUrl: 'javascript:alert(1)' }))).toThrow(OrderApiError)
    expect(() => b.createOrder(pay({ quantity: 1 }))).toThrow(/Minimum/)
    expect(() => b.createOrder(pay({ serviceId: 'nope' }))).toThrow(/no longer available/)
    expect(b.listOrders()).toHaveLength(0)
  })

  it('persists across "reloads" and progresses submitted -> in_progress -> completed', () => {
    const store = memory()
    let t = 0
    createMockBackend(store, () => t).createOrder(pay({ quantity: 1000 }))

    const reopened = createMockBackend(store, () => t)
    expect(reopened.getWallet().balance).toBe(19.1)
    expect(reopened.listOrders()[0]).toMatchObject({ status: 'submitted', remains: 1000 })

    t = MOCK_SUBMITTED_MS + (MOCK_COMPLETED_MS - MOCK_SUBMITTED_MS) / 2
    expect(reopened.listOrders()[0]).toMatchObject({ status: 'in_progress', remains: 500 })

    t = MOCK_COMPLETED_MS + 1
    expect(reopened.listOrders()[0]).toMatchObject({ status: 'completed', remains: 0 })
  })

  it('survives corrupted storage', () => {
    const store = memory()
    store.setItem('smm_mock_backend_v1', '{not json')
    expect(createMockBackend(store).getWallet().balance).toBe(24.5)
  })
})

// ---------------------------------------------------------------------------
// Order history helpers
// ---------------------------------------------------------------------------

describe('order history view helpers', () => {
  const ALL: OrderStatus[] = ['draft', 'awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress', 'completed', 'partial', 'canceled', 'refunded', 'failed']
  const inFilter = (f: OrderFilter) => ALL.filter((s) => matchesFilter(s, f))

  it('groups statuses into the four tabs; drafts never show', () => {
    expect(inFilter('active')).toEqual(['awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress'])
    expect(inFilter('completed')).toEqual(['completed', 'partial'])
    expect(inFilter('closed')).toEqual(['canceled', 'refunded', 'failed'])
    expect(inFilter('all')).not.toContain('draft')
    expect(inFilter('all')).toHaveLength(ALL.length - 1)
  })

  it('maps statuses to the specified badge tones', () => {
    expect(statusMeta('completed')).toMatchObject({ tone: 'success', pulse: false })
    expect(statusMeta('in_progress')).toMatchObject({ tone: 'brand', pulse: true })
    expect(statusMeta('submitted')).toMatchObject({ tone: 'brand', pulse: true })
    expect(statusMeta('processing')).toMatchObject({ tone: 'warning', pulse: true })
    expect(statusMeta('canceled')).toMatchObject({ tone: 'neutral', pulse: false })
    expect(statusMeta('refunded')).toMatchObject({ tone: 'neutral', pulse: false })
  })

  it('computes delivery progress and truncates links', () => {
    expect(deliveredRatio(1000, 250)).toBe(0.75)
    expect(deliveredRatio(1000, null)).toBeNull()
    expect(deliveredRatio(1000, 5000)).toBe(0) // clamped
    expect(truncateUrl('https://www.t.me/channel/')).toBe('t.me/channel')
    expect(truncateUrl('https://instagram.com/' + 'x'.repeat(60), 20)).toHaveLength(20)
  })
})
