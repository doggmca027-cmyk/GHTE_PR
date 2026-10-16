// Drip-feed, part 3: the request body, the error mapping, and that every path that sends an order to a panel (a fresh order, a funded order,
// a reconciliation retry) sends the runs / interval the order was paid for.
import { describe, expect, it } from 'vitest'
import { MAX_DRIP_INTERVAL_MINUTES, MAX_DRIP_RUNS, parsePlaceOrderBody } from '../supabase/functions/_shared/order-validation.ts'
import { dripFeedOf, executePlaceOrder, mapDbError, submitClaimedOrder, type OrderRecord, type PlaceOrderPorts } from '../supabase/functions/_shared/place-order-flow.ts'
import { executeRetry } from '../supabase/functions/_shared/reconciliation.ts'
import { SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { ICreateOrderParams } from '../supabase/functions/_shared/types.ts'

const SERVICE = '11111111-1111-4111-8111-111111111111'
const body = (o: Record<string, unknown> = {}) => ({ serviceId: SERVICE, targetUrl: 'https://t.me/channel', quantity: 3000, ...o })
const quiet = { warn: () => {}, error: () => {} }

describe('place-order body: runs / interval', () => {
  it('absent or 1 = a plain order (nothing added, any interval ignored)', () => {
    for (const o of [{}, { runs: 1 }, { runs: 1, interval: 30 }, { runs: null }]) {
      const r = parsePlaceOrderBody(body(o))
      expect(r.ok && r.value).toEqual({ serviceId: SERVICE, targetUrl: 'https://t.me/channel', quantity: 3000, clientKey: undefined })
    }
  })

  it('a drip-feed order keeps the TOTAL quantity plus runs and interval', () => {
    const r = parsePlaceOrderBody(body({ runs: 3, interval: 60 }))
    expect(r.ok && r.value).toMatchObject({ quantity: 3000, runs: 3, interval: 60 })
  })

  it('refuses bad schedules', () => {
    for (const o of [
      { runs: 0 }, { runs: -2, interval: 5 }, { runs: 2.5, interval: 5 }, { runs: '3', interval: 5 }, { runs: MAX_DRIP_RUNS + 1, interval: 5 },
      { runs: 3 }, { runs: 3, interval: 0 }, { runs: 3, interval: 1.5 }, { runs: 3, interval: MAX_DRIP_INTERVAL_MINUTES + 1 },
      { runs: 7, interval: 10 },   // 3000 does not split into 7 whole deliveries
    ]) expect(parsePlaceOrderBody(body(o))).toMatchObject({ ok: false, error: 'invalid_input' })
  })
})

describe('database errors of a drip-feed order', () => {
  it('map to safe answers (nothing was charged)', () => {
    expect(mapDbError('quantity per run must be between 10 and 1000')).toEqual({ httpStatus: 400, error: 'invalid_input', message: 'Each delivery must be between 10 and 1000.' })
    expect(mapDbError('quantity must split evenly into runs')).toMatchObject({ httpStatus: 400, error: 'invalid_input' })
    expect(mapDbError('runs must be at least 1')).toMatchObject({ httpStatus: 400, error: 'invalid_input' })
    expect(mapDbError('interval must not be negative')).toMatchObject({ httpStatus: 400, error: 'invalid_input' })
    expect(mapDbError('the selected provider offer does not support drip-feed')).toMatchObject({ httpStatus: 503, error: 'service_unavailable' })
    // unchanged for a plain order
    expect(mapDbError('quantity must be between 10 and 1000')).toMatchObject({ httpStatus: 400, message: 'Quantity must be between 10 and 1000' })
  })
})

const order = (o: Partial<OrderRecord> = {}): OrderRecord => ({
  id: 'o1', user_id: 'u1', service_id: 's1', target_url: 'https://t.me/x', quantity: 3000, charge_amount: 1, status: 'processing',
  provider_order_id: null, error_message: null, ...o,
})

/** In-memory ports: one order, updated in place. */
function ports(start: OrderRecord): PlaceOrderPorts & { placed: unknown[] } {
  let row = { ...start }
  const placed: unknown[] = []
  return {
    placed,
    async placeOrder(a) { placed.push(a); row = { ...row, status: 'paid', runs: a.runs ?? 1, interval: a.interval ?? 0 }; return row },
    async claim() { row = { ...row, status: 'processing' }; return row },
    async get() { return row },
    async update(_id, patch) { row = { ...row, ...patch } as OrderRecord; return row },
    async refund() { row = { ...row, status: 'refunded' }; return row },
  }
}

describe('sending a drip-feed order', () => {
  it('dripFeedOf: nothing for a plain or old order', () => {
    expect(dripFeedOf({})).toEqual({})
    expect(dripFeedOf({ runs: 1, interval: 0 })).toEqual({})
    expect(dripFeedOf({ runs: 3, interval: 20 })).toEqual({ runs: 3, interval: 20 })
  })

  it('a fresh order: place_order receives runs / interval, the panel gets them from the stored order', async () => {
    const sent: ICreateOrderParams[] = []
    const p = ports(order())
    const r = await executePlaceOrder(
      { userId: 'u1', serviceId: 's1', targetUrl: 'https://t.me/x', quantity: 3000, idempotencyKey: 'k', providerOfferId: 'of', providerId: 'p', providerServiceId: 'ps', costAmount: 3, runs: 3, interval: 20, externalServiceId: '77' },
      p, { createOrder: async (params) => { sent.push(params); return { orderId: 'P1' } } }, quiet,
    )
    expect(r.kind).toBe('submitted')
    expect(p.placed[0]).toMatchObject({ quantity: 3000, runs: 3, interval: 20 })
    expect(sent).toEqual([{ serviceId: '77', link: 'https://t.me/x', quantity: 3000, runs: 3, interval: 20 }])
  })

  it('a funded (waiting) order is sent with its stored schedule; a plain one exactly as before', async () => {
    const sent: ICreateOrderParams[] = []
    const adapter = { createOrder: async (params: ICreateOrderParams) => { sent.push(params); return { orderId: 'P2' } } }
    await submitClaimedOrder(order({ runs: 3, interval: 20 }), '77', ports(order()), adapter, quiet)
    await submitClaimedOrder(order({ runs: 1, interval: 0 }), '77', ports(order()), adapter, quiet)
    expect(sent).toEqual([
      { serviceId: '77', link: 'https://t.me/x', quantity: 3000, runs: 3, interval: 20 },
      { serviceId: '77', link: 'https://t.me/x', quantity: 3000 },
    ])
  })

  it('through the real SMM v2 adapter the panel gets one run\'s quantity', async () => {
    const bodies: URLSearchParams[] = []
    const fetchImpl = (async (_url: string, init: { body: URLSearchParams | string }) => {
      bodies.push(new URLSearchParams(String(init.body)))
      return new Response(JSON.stringify({ order: 9 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const adapter = new SMMv2Adapter({ id: 'p', name: 'Panel', apiUrl: 'https://panel.test/api/v2', apiKey: 'k', mockMode: false, fetchImpl, capabilities: { supportsDripFeed: true } })
    await submitClaimedOrder(order({ runs: 3, interval: 20 }), '77', ports(order()), adapter, quiet)
    expect([bodies[0].get('quantity'), bodies[0].get('runs'), bodies[0].get('interval')]).toEqual(['1000', '3', '20'])
  })

  it('a reconciliation retry re-sends the stored schedule', async () => {
    const sent: ICreateOrderParams[] = []
    const r = await executeRetry(
      { externalServiceId: '77', link: 'https://t.me/x', quantity: 3000, runs: 3, interval: 20 },
      { finish: async () => {}, release: async () => {} },
      { createOrder: async (params) => { sent.push(params); return { orderId: 'R1' } } },
      quiet,
    )
    expect(r).toEqual({ kind: 'submitted', providerOrderId: 'R1' })
    expect(sent).toEqual([{ serviceId: '77', link: 'https://t.me/x', quantity: 3000, runs: 3, interval: 20 }])
  })
})
