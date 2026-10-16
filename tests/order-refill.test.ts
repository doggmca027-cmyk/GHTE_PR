// @vitest-environment jsdom
// Refill ("докрутка"): the rules in SQL (begin_order_refill), the request flow, and the button on the order card.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SMMProviderError } from '../supabase/functions/_shared/providers/contract.ts'
import { mapRefillError, parseRefillBody, requestRefill, type RefillPorts } from '../supabase/functions/_shared/refill.ts'
import { refillView } from '../src/lib/order-view'
import type { IOrderView } from '../src/types/orders'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROV = '00000000-0000-0000-0000-0000000000a2'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const OFFER = '00000000-0000-0000-0000-00000000aa01'
const PS = '00000000-0000-0000-0000-000000000a01'

describe('refill rules (SQL)', () => {
  let db: PGlite
  let user: string, other: string
  let seq = 0
  const err = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }
  const begin = (u: string, o: string) => db.query<{ r: Record<string, unknown> }>(`select begin_order_refill($1::uuid, $2::uuid) r`, [u, o])
  const order = async (id: string) => (await db.query<Record<string, unknown>>(`select status, refill_available, refill_status, provider_refill_id from orders where id = $1`, [id])).rows[0]

  /** A delivered order of `user`, `daysAgo` old. */
  async function delivered(daysAgo = 2, status: 'completed' | 'partial' = 'completed') {
    const o = (await db.query<{ id: string }>(`select id from place_order($1::uuid, '${SVC}', 'https://t.me/x', 100, '${OFFER}', '${PROV}', '${PS}', 0.1, $2)`, [user, `k-${++seq}`])).rows[0].id
    await db.query(`update orders set status = 'processing' where id = $1`, [o])
    await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [o, `P-${seq}`])
    if (status === 'partial') await db.query(`update orders set status = 'in_progress', remains = 10 where id = $1`, [o])
    await db.query(`update orders set status = $2 where id = $1`, [o, status])
    await db.query(`update orders set created_at = now() - make_interval(days => $2) where id = $1`, [o, daysAgo])
    return o
  }

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers(id, name, api_url, routing_enabled, health_status, provider_balance, last_balance_sync) values ('${PROV}', 'A', 'https://a.example', true, 'healthy', 1000, now());
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', (select id from platforms where slug = 'telegram'), 'V', 'v');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported) values ('${PS}', '${PROV}', '1', 'A', 1.0, 10, 100000, true);
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, refill_supported, attributes)
        values ('${SVC}', '00000000-0000-0000-0000-0000000000c1', 'V', '${PS}', 4.0, 10, 100000, true, '{"refill": 30}');
      delete from provider_service_offers;
      insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported)
        values ('${OFFER}', '${SVC}', '${PROV}', '${PS}', 1.0, 10, 100000, true);`)
    for (const [id, tg] of [['user', 70001], ['other', 70002]] as const) {
      const u = (await db.query<{ id: string }>(`insert into users(telegram_id) values ($1) returning id`, [tg])).rows[0].id
      await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100, null, 'f', 'f-' || $1::text)`, [u])
      if (id === 'user') user = u; else other = u
    }
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('refill_available is decided when the order is routed: service AND offer give a guarantee', async () => {
    const o = await delivered()
    expect(await order(o)).toMatchObject({ refill_available: true, refill_status: null })
  })

  it('the full path: requested, then the panel\'s refill id; once a day', async () => {
    const o = await delivered(2)
    const r = (await begin(user, o)).rows[0].r
    expect(r).toMatchObject({ order_id: o, provider_id: PROV, provider_order_id: expect.stringMatching(/^P-/) })
    expect(await order(o)).toMatchObject({ refill_status: 'requested' })
    await db.query(`select finish_order_refill($1::uuid, true, 'R-77')`, [o])
    expect(await order(o)).toMatchObject({ refill_status: 'in_progress', provider_refill_id: 'R-77' })
    expect(await err(begin(user, o))).toMatch(/refill_cooldown/)
    // a day later it can be asked again; a refusal is recorded
    await db.query(`update orders set refill_requested_at = now() - interval '25 hours' where id = $1`, [o])
    await begin(user, o)
    await db.query(`select finish_order_refill($1::uuid, false, null)`, [o])
    expect(await order(o)).toMatchObject({ refill_status: 'rejected', provider_refill_id: 'R-77' })
  })

  it('refuses: someone else\'s order, too early, not delivered, outside the guarantee, no guarantee, suspended account', async () => {
    const o = await delivered(2)
    expect(await err(begin(other, o))).toMatch(/order_not_found/)
    expect(await err(begin(user, await delivered(0)))).toMatch(/refill_too_early/)
    expect(await err(begin(user, await delivered(31)))).toMatch(/refill_expired/)
    expect(await err(begin(user, '00000000-0000-0000-0000-00000000dead'))).toMatch(/order_not_found/)
    const fresh = (await db.query<{ id: string }>(`select id from place_order($1::uuid, '${SVC}', 'https://t.me/y', 100, '${OFFER}', '${PROV}', '${PS}', 0.1, 'k-proc')`, [user])).rows[0].id
    expect(await err(begin(user, fresh))).toMatch(/refill_not_delivered/)
    await db.query(`update services set attributes = '{"refill": "none"}' where id = $1`, [SVC])
    expect(await err(begin(user, await delivered(2)))).toMatch(/refill_unavailable/)
    await db.query(`update services set attributes = '{"refill": "lifetime"}' where id = $1`, [SVC])
    expect((await begin(user, await delivered(400))).rows[0].r).toMatchObject({ provider_id: PROV }) // lifetime: no end
    const before = await delivered(2, 'partial') // ordered before the suspension
    await db.query(`update users set is_banned = true where id = $1`, [user])
    expect(await err(begin(user, before))).toMatch(/user_banned/)
    await db.query(`update users set is_banned = false where id = $1`, [user])
  })

  it('a service without refill gives orders without it', async () => {
    await db.query(`update services set refill_supported = false where id = $1`, [SVC])
    const o = await delivered(2)
    expect(await order(o)).toMatchObject({ refill_available: false })
    expect(await err(begin(user, o))).toMatch(/refill_unavailable/)
    await db.query(`update services set refill_supported = true, attributes = '{"refill": 30}' where id = $1`, [SVC])
  })

  it('clients see the refill columns of their order but cannot call the functions', async () => {
    for (const c of ['refill_available', 'refill_status', 'refill_requested_at']) {
      expect((await db.query<{ p: boolean }>(`select has_column_privilege('authenticated', 'public.orders', '${c}', 'select') p`)).rows[0].p).toBe(true)
    }
    expect((await db.query<{ p: boolean }>(`select has_column_privilege('authenticated', 'public.orders', 'provider_refill_id', 'select') p`)).rows[0].p).toBe(false)
    for (const fn of ['begin_order_refill(uuid, uuid)', 'finish_order_refill(uuid, boolean, text)']) {
      expect((await db.query<{ p: boolean }>(`select has_function_privilege('authenticated', '${fn}', 'execute') p`)).rows[0].p).toBe(false)
    }
  })
})

describe('refill request flow', () => {
  const ports = (over: Partial<RefillPorts> = {}): RefillPorts & { finished: unknown[] } => {
    const finished: unknown[] = []
    return {
      finished,
      begin: async () => ({ provider_id: 'p', provider_order_id: 'P-1' }),
      createRefill: async () => 'R-1',
      finish: async (o, ok, id) => { finished.push([o, ok, id]) },
      ...over,
    }
  }

  it('accepted by the panel -> in_progress with its id', async () => {
    const p = ports()
    expect(await requestRefill('u', 'o', p)).toEqual({ status: 200, body: { success: true, refillStatus: 'in_progress' } })
    expect(p.finished).toEqual([['o', true, 'R-1']])
  })

  it('a lost answer leaves it requested; a refusal is recorded', async () => {
    const lost = ports({ createRefill: async () => { throw new SMMProviderError('network', 'timeout', { ambiguous: true }) } })
    expect((await requestRefill('u', 'o', lost)).status).toBe(202)
    expect(lost.finished).toEqual([])
    const refused = ports({ createRefill: async () => { throw new SMMProviderError('api', 'Refill is disabled for this service') } })
    expect(await requestRefill('u', 'o', refused)).toMatchObject({ status: 409, body: { error: 'refill_refused' } })
    expect(refused.finished).toEqual([['o', false, null]])
  })

  it('maps the SQL refusals; anything else is a server error', async () => {
    const p = ports({ begin: async () => { throw new Error('refill_cooldown: one refill request a day; next after 2026-10-17T10:00:00Z') } })
    expect(await requestRefill('u', 'o', p)).toEqual({ status: 429, body: { success: false, error: 'refill_cooldown', message: expect.any(String), retryAfter: '2026-10-17T10:00:00Z' } })
    expect(mapRefillError('order_not_found: no such order').status).toBe(404)
    await expect(requestRefill('u', 'o', ports({ begin: async () => { throw new Error('connection reset') } }))).rejects.toThrow()
    expect(parseRefillBody({ orderId: 'x' })).toHaveProperty('error')
    expect(parseRefillBody({ orderId: PROV.toUpperCase() })).toEqual({ orderId: PROV })
  })
})

describe('refill on the order card', () => {
  const base: IOrderView = {
    id: 'o1', serviceName: 'Telegram Members [refill 30 days]', platform: 'telegram', targetUrl: 'https://t.me/x', quantity: 1000, chargeAmount: 4,
    status: 'completed', remains: 0, startCount: 0, refundedAmount: 0, awaitingFunds: false, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    refillAvailable: true, refillStatus: null, refillRequestedAt: null,
  }

  it('refillView: hidden, waiting, available, pending', () => {
    const now = Date.now()
    expect(refillView({ ...base, refillAvailable: false }, now)).toBeNull()
    expect(refillView({ ...base, status: 'in_progress' }, now)).toBeNull()
    expect(refillView(base, now)).toEqual({ kind: 'available' })
    expect(refillView({ ...base, createdAt: new Date(now - 3_600_000).toISOString() }, now)).toMatchObject({ kind: 'wait' })
    expect(refillView({ ...base, refillStatus: 'requested', refillRequestedAt: new Date(now - 60_000).toISOString() }, now)).toEqual({ kind: 'pending', status: 'requested' })
    expect(refillView({ ...base, refillStatus: 'rejected', refillRequestedAt: new Date(now - 60_000).toISOString() }, now)).toMatchObject({ kind: 'wait' })
    expect(refillView({ ...base, refillStatus: 'in_progress', refillRequestedAt: new Date(now - 2 * 86_400_000).toISOString() }, now)).toEqual({ kind: 'available' })
  })

  it('the button asks for a refill; a refusal is shown in words', async () => {
    const { OrderCard } = await import('../src/components/orders/OrderCard')
    const host = document.createElement('div')
    const root = createRoot(host)
    const onRefill = vi.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'refill_refused' })).mockResolvedValueOnce(undefined)
    act(() => root.render(createElement(OrderCard, { order: base, onRefill })))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Request refill'))!
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(onRefill).toHaveBeenCalledWith(base)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The provider could not start a refill now. Try again later.')
    await act(async () => { button.click() })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    act(() => root.render(createElement(OrderCard, { order: { ...base, refillStatus: 'in_progress', refillRequestedAt: new Date().toISOString() }, onRefill })))
    expect(host.textContent).toContain('Refill is in progress')
    act(() => root.render(createElement(OrderCard, { order: { ...base, refillAvailable: false }, onRefill })))
    expect(host.textContent).not.toContain('Request refill')
    act(() => root.unmount())
  })
})
