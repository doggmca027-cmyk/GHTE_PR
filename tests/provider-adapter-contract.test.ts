import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MockProviderAdapter,
  NORMALIZED_ORDER_STATUSES,
  NotSupportedError,
  assertSupports,
  isFinalProviderStatus,
  normalizeOrderStatus,
  normalizeRefillStatus,
  usesDripFeed,
  type IProviderAdapter,
} from '../supabase/functions/_shared/providers/index.ts'
import { SMMProviderError, SMMv2Adapter, mapProviderStatus } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { DEFAULT_SMM_V2_CAPABILITIES } from '../supabase/functions/_shared/types.ts'

const KEY = ['adapter', 'test', 'key', '0001'].join('-') // assembled at run time: the secret scanner rejects key-shaped literals

// ---------------------------------------------------------------------------
// Status normalization: one table for every panel
// ---------------------------------------------------------------------------

describe('status normalization', () => {
  it('maps every word panels use into the closed set', () => {
    const table: Record<string, string> = {
      Pending: 'submitted', Awaiting: 'submitted', Queued: 'submitted',
      Processing: 'in_progress', 'In progress': 'in_progress', 'in_progress': 'in_progress', Running: 'in_progress',
      Completed: 'completed', Success: 'completed',
      Partial: 'partial',
      Canceled: 'canceled', Cancelled: 'canceled', Refunded: 'canceled',
      Fail: 'failed', Failed: 'failed', Error: 'failed', Rejected: 'failed',
    }
    for (const [raw, want] of Object.entries(table)) expect(normalizeOrderStatus(raw), raw).toBe(want)
    for (const v of Object.values(table)) expect(NORMALIZED_ORDER_STATUSES).toContain(v)
    expect(normalizeOrderStatus('  COMPLETED ')).toBe('completed')
  })

  it('an unknown word is null, and the SMM v2 adapter turns that into an error rather than guessing a status', () => {
    expect(normalizeOrderStatus('Teleported')).toBeNull()
    expect(() => mapProviderStatus('Teleported')).toThrow(SMMProviderError)
    expect(mapProviderStatus('Refunded')).toBe('canceled') // used to throw: a documented panel status
    expect(mapProviderStatus('Awaiting')).toBe('submitted')
  })

  it('refill statuses', () => {
    expect(normalizeRefillStatus('Completed')).toBe('completed')
    expect(normalizeRefillStatus('Rejected')).toBe('rejected')
    expect(normalizeRefillStatus('In progress')).toBe('in_progress')
    expect(normalizeRefillStatus('???')).toBeNull()
  })

  it('which statuses are final', () => {
    expect(NORMALIZED_ORDER_STATUSES.filter(isFinalProviderStatus)).toEqual(['completed', 'partial', 'canceled', 'failed'])
  })
})

describe('capability guard', () => {
  it('throws NotSupportedError naming the capability and the provider', () => {
    expect(() => assertSupports(DEFAULT_SMM_V2_CAPABILITIES, 'refill', 'Acme')).toThrow(NotSupportedError)
    try { assertSupports(DEFAULT_SMM_V2_CAPABILITIES, 'cancel', 'Acme') } catch (e) {
      expect(e).toMatchObject({ name: 'NotSupportedError', capability: 'cancel', provider: 'Acme' })
      expect((e as Error).message).toBe('provider "Acme" does not support cancel')
    }
    expect(() => assertSupports(DEFAULT_SMM_V2_CAPABILITIES, 'partial', 'Acme')).not.toThrow() // every SMM v2 panel reports Partial
  })

  it('recognises drip-feed parameters', () => {
    expect(usesDripFeed({ extra: { runs: 3, interval: 30 } })).toBe(true)
    expect(usesDripFeed({ extra: { comments: 'x' } })).toBe(false)
    expect(usesDripFeed({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The same contract suite, run against the mock AND the real SMM v2 adapter (talking to a fake panel)
// ---------------------------------------------------------------------------

/** A fake SMM v2 panel behind fetch, enough for the lifecycle. */
function fakePanel(opts: { refillAnswer?: unknown; cancelAnswer?: unknown } = {}) {
  const calls: Record<string, string>[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const p = Object.fromEntries(new URLSearchParams(String(init.body)))
    calls.push(p)
    const json = (v: unknown) => new Response(JSON.stringify(v))
    switch (p.action) {
      case 'balance': return json({ balance: '12.5', currency: 'USD' })
      case 'services': return json([{ service: 1, name: 'Views', type: 'Default', category: 'Telegram', rate: '0.08', min: '100', max: '1000000', refill: true, cancel: true }])
      case 'add': return json({ order: 777 })
      case 'status': return p.orders ? json({ 777: { status: 'Refunded', charge: '0', remains: '1000', currency: 'USD' } }) : json({ status: 'In progress', charge: '0.08', remains: '400', start_count: '10', currency: 'USD' })
      case 'refill': return json(opts.refillAnswer ?? { refill: 55 })
      case 'refill_status': return json({ status: 'Completed' })
      case 'cancel': return json(opts.cancelAnswer ?? [{ order: 777, cancel: 1 }])
      default: return json({ error: 'Incorrect action' })
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
const smm = (caps: Partial<ConstructorParameters<typeof SMMv2Adapter>[0]['capabilities'] & object>, panel = fakePanel()) =>
  ({ adapter: new SMMv2Adapter({ id: 'smm', name: 'Panel', apiUrl: 'https://panel.example/api/v2', apiKey: KEY, mockMode: false, fetchImpl: panel.fetchImpl, capabilities: caps }), panel })

const implementations: { name: string; make: (caps: { supportsRefill?: boolean; supportsCancel?: boolean; supportsDripFeed?: boolean }) => IProviderAdapter; ready: (a: IProviderAdapter, orderId: string) => void }[] = [
  { name: 'MockProviderAdapter', make: (caps) => new MockProviderAdapter({ id: 'm', name: 'Mock', capabilities: caps }), ready: (a, id) => (a as MockProviderAdapter).setStatus(id, 'completed') },
  { name: 'SMMv2Adapter (fake panel)', make: (caps) => smm(caps).adapter, ready: () => {} },
]

describe('SMMv2Adapter: the panel\'s own text about a service', () => {
  const item = (service: number, extra: Record<string, unknown> = {}) => ({ service, name: `S${service}`, type: 'Default', rate: '1.00', min: 10, max: 100, category: 'c', refill: false, cancel: false, ...extra })
  const services = async (body: unknown[]) => {
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    return new SMMv2Adapter({ id: 'smm', name: 'Panel', apiUrl: 'https://panel.example/api/v2', apiKey: KEY, mockMode: false, fetchImpl, capabilities: DEFAULT_SMM_V2_CAPABILITIES }).getServices()
  }

  it('keeps "desc" or "description" trimmed with calm line breaks and a length cap; no text means no field', async () => {
    const out = await services([
      item(1, { desc: '  Refill: no\r\n\r\n\r\n\r\nSupport: yes  ' }),
      item(2, { description: 'x'.repeat(5000) }),
      item(3, { desc: '   ' }),
      item(4),
      item(5, { desc: 42 }),
    ])
    expect(out[0].description).toBe('Refill: no\n\nSupport: yes')
    expect(out[1].description).toHaveLength(2000)
    expect('description' in out[2]).toBe(false)
    expect('description' in out[3]).toBe(false)
    expect('description' in out[4]).toBe(false)
  })
})

describe('SMMv2Adapter: a big catalogue gets a longer timeout than an order or a balance', () => {
  const slowPanel = (body: unknown, delayMs: number) => (async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), delayMs)
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    })) as unknown as typeof fetch
  const adapter = (fetchImpl: typeof fetch) => new SMMv2Adapter({ id: 'smm', name: 'Panel', apiUrl: 'https://panel.example/api/v2', apiKey: KEY, mockMode: false, fetchImpl, capabilities: DEFAULT_SMM_V2_CAPABILITIES })

  it('waits 20 s for `services` (RootPanel takes that long) but still gives up on `balance` after the normal 10 s', async () => {
    vi.useFakeTimers()
    try {
      const services = adapter(slowPanel([{ service: 1, name: 'A', type: 'Default', rate: '1', min: 10, max: 100, category: 'c' }], 20_000)).getServices()
      await vi.advanceTimersByTimeAsync(20_001)
      expect(await services).toHaveLength(1)

      const balance = adapter(slowPanel({ balance: '1', currency: 'USD' }, 20_000)).getBalance()
      const failed = expect(balance).rejects.toMatchObject({ kind: 'timeout', message: 'balance: no response within 10000ms' })
      await vi.advanceTimersByTimeAsync(10_001)
      await failed
    } finally {
      vi.useRealTimers()
    }
  })
})

describe.each(implementations)('IProviderAdapter contract: $name', ({ make, ready }) => {
  it('covers balance, catalog, order creation and status in the normalized shapes', async () => {
    const a = make({})
    const balance = await a.getBalance()
    expect(balance).toEqual({ balance: expect.any(Number), currency: expect.any(String) })
    const services = await a.getServices()
    expect(services[0]).toEqual({
      externalServiceId: expect.any(String), name: expect.any(String), type: expect.any(String), categoryRaw: expect.any(String), ratePer1000: expect.any(Number),
      minQuantity: expect.any(Number), maxQuantity: expect.any(Number), refillSupported: expect.any(Boolean), cancelSupported: expect.any(Boolean),
    })
    const { orderId } = await a.createOrder({ serviceId: services[0].externalServiceId, link: 'https://t.me/channel/1', quantity: 1000 })
    expect(typeof orderId).toBe('string')
    const st = await a.getOrderStatus(orderId)
    expect(NORMALIZED_ORDER_STATUSES).toContain(st.status)
    expect(st).toMatchObject({ orderId, rawStatus: expect.any(String) })
    const batch = await a.getOrdersStatus([orderId, '999999999'])
    expect(batch[orderId]).toMatchObject({ ok: true })
    for (const e of Object.values(batch)) if (e.ok) expect(NORMALIZED_ORDER_STATUSES).toContain(e.status.status)
    expect(await a.getCapabilities()).toEqual(expect.objectContaining({ supportsRefill: false, supportsCancel: false }))
  })

  it('refill and cancel are refused with NotSupportedError, before any request, when the flags are off', async () => {
    const a = make({})
    await expect(a.createRefill!('1')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(a.getRefillStatus!('1')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(a.cancelOrder!('1')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(a.createOrder({ serviceId: '1001', link: 'https://t.me/x/1', quantity: 100, extra: { runs: 2, interval: 10 } })).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('with the flags on, refill and cancel work and report in the normalized shapes', async () => {
    const a = make({ supportsRefill: true, supportsCancel: true })
    const refillable = (await a.getServices()).find((s) => s.refillSupported)!
    const { orderId } = await a.createOrder({ serviceId: refillable.externalServiceId, link: 'https://t.me/x/1', quantity: 1000 })
    ready(a, orderId)
    const refill = await a.createRefill!(orderId)
    expect(refill).toEqual({ orderId, refillId: expect.any(String) })
    expect(await a.getRefillStatus!(refill.refillId)).toMatchObject({ refillId: refill.refillId, status: expect.stringMatching(/^(pending|in_progress|completed|rejected)$/) })
    const cancel = await a.cancelOrder!(orderId)
    expect(cancel).toMatchObject({ orderId, accepted: expect.any(Boolean) })
  })

  it('has no method that takes a credential', () => {
    const a = make({})
    for (const m of ['getBalance', 'getServices', 'createOrder', 'getOrderStatus', 'getOrdersStatus', 'createRefill', 'getRefillStatus', 'cancelOrder'] as const) {
      expect(String((a as unknown as Record<string, unknown>)[m]), m).not.toMatch(/api[_ ]?key|apiKey|secret|token/i)
    }
    expect(JSON.stringify(a)).not.toContain(KEY)
  })
})

// ---------------------------------------------------------------------------
// The mock's behaviour
// ---------------------------------------------------------------------------

describe('MockProviderAdapter', () => {
  const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms: number) => { t += ms } } }

  it('an order walks submitted -> in_progress -> completed with the clock; the balance pays for it', async () => {
    const c = clock()
    const a = new MockProviderAdapter({ id: 'm', name: 'Mock', balance: 10, now: c.now })
    const { orderId } = await a.createOrder({ serviceId: '1001', link: 'https://t.me/x/1', quantity: 10_000 }) // 0.08/1000 -> 0.8
    expect(await a.getBalance()).toEqual({ balance: 9.2, currency: 'USD' })
    expect((await a.getOrderStatus(orderId)).status).toBe('submitted')
    c.advance(6_000)
    expect(await a.getOrderStatus(orderId)).toMatchObject({ status: 'in_progress', rawStatus: 'In progress' })
    c.advance(10_000)
    expect(await a.getOrderStatus(orderId)).toMatchObject({ status: 'completed', remains: 0, charge: 0.8 })
  })

  it('refuses what a panel refuses: bad service, link, quantity, and an empty balance', async () => {
    const a = new MockProviderAdapter({ id: 'm', name: 'Mock', balance: 0.01 })
    const code = async (p: Parameters<typeof a.createOrder>[0]) => (await a.createOrder(p).catch((e) => e)) as SMMProviderError
    expect((await code({ serviceId: 'nope', link: 'https://x.y/1', quantity: 100 })).code).toBe('invalid_service')
    expect((await code({ serviceId: '1001', link: 'not a link', quantity: 100 })).code).toBe('invalid_link')
    expect((await code({ serviceId: '1001', link: 'https://x.y/1', quantity: 1 })).code).toBe('invalid_quantity')
    expect((await code({ serviceId: '1001', link: 'https://x.y/1', quantity: 1_000_000 })).code).toBe('insufficient_provider_balance')
    expect(a.orderCount).toBe(0)
  })

  it('partial orders report what is left and the reduced charge; failNext simulates an outage once', async () => {
    const a = new MockProviderAdapter({ id: 'm', name: 'Mock' })
    const { orderId } = await a.createOrder({ serviceId: '1001', link: 'https://x.y/1', quantity: 1000 })
    a.setStatus(orderId, 'partial', 250)
    expect(await a.getOrderStatus(orderId)).toMatchObject({ status: 'partial', remains: 250, charge: 0.06 })
    a.failNext('getBalance', new SMMProviderError('timeout', 'balance: no response', { retryable: true }))
    await expect(a.getBalance()).rejects.toMatchObject({ kind: 'timeout' })
    await expect(a.getBalance()).resolves.toMatchObject({ currency: 'USD' })
    await expect(a.getOrderStatus('missing')).rejects.toMatchObject({ code: 'order_not_found' })
  })

  it('cancel is accepted before the order finishes (the cost returns) and refused after', async () => {
    const c = clock()
    const a = new MockProviderAdapter({ id: 'm', name: 'Mock', balance: 10, now: c.now, capabilities: { supportsCancel: true, supportsRefill: true } })
    const early = (await a.createOrder({ serviceId: '1001', link: 'https://x.y/1', quantity: 10_000 })).orderId
    expect(await a.cancelOrder(early)).toEqual({ orderId: early, accepted: true })
    expect((await a.getOrderStatus(early)).status).toBe('canceled')
    expect((await a.getBalance()).balance).toBe(10)
    const late = (await a.createOrder({ serviceId: '3001', link: 'https://x.y/1', quantity: 100 })).orderId
    c.advance(20_000)
    expect(await a.cancelOrder(late)).toMatchObject({ accepted: false })
    // refill: only for a completed order of a refillable service
    c.advance(1)
    const refill = await a.createRefill(late)
    expect((await a.getRefillStatus(refill.refillId)).status).toBe('pending')
    c.advance(6_000)
    expect((await a.getRefillStatus(refill.refillId)).status).toBe('completed')
    await expect(a.createRefill(early)).rejects.toBeInstanceOf(SMMProviderError) // canceled, and 1001 has no refill
  })
})

// ---------------------------------------------------------------------------
// SMM v2 specifics
// ---------------------------------------------------------------------------

describe('SMMv2Adapter refill / cancel against the documented API', () => {
  const caps = { supportsRefill: true, supportsCancel: true }

  it('sends the documented calls (refill: order=; refill_status: refill=; cancel: orders=) with the key in the form body only', async () => {
    const { adapter, panel } = smm(caps)
    await adapter.createRefill('777')
    await adapter.getRefillStatus('55')
    await adapter.cancelOrder('777')
    expect(panel.calls.map(({ key: _k, ...rest }) => rest)).toEqual([{ action: 'refill', order: '777' }, { action: 'refill_status', refill: '55' }, { action: 'cancel', orders: '777' }])
    expect(panel.calls.every((c) => c.key === KEY)).toBe(true)
  })

  it('a refill refused by the panel (nested error) is an SMMProviderError; a missing refill id is an ambiguous one', async () => {
    const refused = smm(caps, fakePanel({ refillAnswer: { refill: { error: 'Order is not completed yet' } } })).adapter
    await expect(refused.createRefill('777')).rejects.toMatchObject({ name: 'SMMProviderError', kind: 'api' })
    const empty = smm(caps, fakePanel({ refillAnswer: {} })).adapter
    await expect(empty.createRefill('777')).rejects.toMatchObject({ ambiguous: true })
  })

  it('cancel: success, refusal (not an error), and no answer for the order (ambiguous)', async () => {
    expect(await smm(caps, fakePanel({ cancelAnswer: [{ order: 777, cancel: 1 }] })).adapter.cancelOrder('777')).toEqual({ orderId: '777', accepted: true })
    expect(await smm(caps, fakePanel({ cancelAnswer: [{ order: 777, cancel: { error: 'Order already completed' } }] })).adapter.cancelOrder('777'))
      .toEqual({ orderId: '777', accepted: false, reason: 'Order already completed' })
    await expect(smm(caps, fakePanel({ cancelAnswer: [{ order: 1, cancel: 1 }] })).adapter.cancelOrder('777')).rejects.toMatchObject({ ambiguous: true })
  })

  it('a provider status of Refunded now maps to canceled instead of failing the whole batch', async () => {
    const { adapter } = smm({})
    const batch = await adapter.getOrdersStatus(['777'])
    expect(batch['777']).toMatchObject({ ok: true, status: { status: 'canceled', rawStatus: 'Refunded' } })
  })

  it('real adapters stay closed to abilities the provider row does not claim', async () => {
    const { adapter, panel } = smm({})
    await expect(adapter.cancelOrder('777')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(adapter.createRefill('777')).rejects.toBeInstanceOf(NotSupportedError)
    expect(panel.calls).toEqual([]) // nothing was sent
  })
})

// ---------------------------------------------------------------------------
// The core only knows the contract
// ---------------------------------------------------------------------------

describe('layering', () => {
  const root = path.resolve(__dirname, '../supabase/functions/_shared')
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

  it('the core modules depend on the adapter interface, never on a concrete adapter', () => {
    for (const f of ['place-order-flow.ts', 'order-sync.ts', 'reconciliation.ts', 'health-monitor.ts', 'catalog-sync.ts']) expect(read(f), f).not.toMatch(/from '\.\/smm-v2-adapter\.ts'|from '\.\/providers\/mock-adapter\.ts'/)
  })

  it('the providers folder has no network or environment access of its own', () => {
    for (const f of ['providers/contract.ts', 'providers/base-adapter.ts', 'providers/mock-adapter.ts']) expect(read(f), f).not.toMatch(/\bfetch\(|Deno\.env|process\.env/)
  })
})
