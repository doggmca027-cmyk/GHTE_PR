import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { groupOrdersByProvider, resolveOrderProvider, syncProviderOrders, type SyncOrder, type SyncPorts } from '../supabase/functions/_shared/order-sync.ts'
import { MockProviderAdapter } from '../supabase/functions/_shared/providers/mock-adapter.ts'
import type { IProviderAdapter } from '../supabase/functions/_shared/providers/contract.ts'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('resolveOrderProvider', () => {
  it('the offer\'s provider is the panel that accepted the order', () => {
    expect(resolveOrderProvider({ provider_id: B, offer_provider_id: B })).toEqual({ kind: 'resolved', providerId: B })
    expect(resolveOrderProvider({ provider_id: null, offer_provider_id: B })).toEqual({ kind: 'resolved', providerId: B })
  })

  it('orders from before offers existed fall back to orders.provider_id', () => {
    expect(resolveOrderProvider({ provider_id: A, offer_provider_id: null })).toEqual({ kind: 'resolved', providerId: A })
  })

  it('no record at all: nothing to poll', () => {
    expect(resolveOrderProvider({ provider_id: null, offer_provider_id: null })).toEqual({ kind: 'none' })
  })

  it('the two records disagree: the order is not polled anywhere', () => {
    expect(resolveOrderProvider({ provider_id: A, offer_provider_id: B })).toEqual({ kind: 'mismatch' })
  })
})

describe('groupOrdersByProvider', () => {
  it('splits orders by the accepting provider, a failover order goes to the fallback panel', () => {
    const orders = [
      { id: 'o1', provider_id: A, offer_provider_id: A }, // primary
      { id: 'o2', provider_id: B, offer_provider_id: B }, // accepted by the fallback after the primary refused
      { id: 'o3', provider_id: A, offer_provider_id: null }, // legacy order
      { id: 'o4', provider_id: null, offer_provider_id: null },
      { id: 'o5', provider_id: A, offer_provider_id: B }, // corrupted
    ]
    const g = groupOrdersByProvider(orders)
    expect([...g.byProvider.keys()].sort()).toEqual([A, B])
    expect(g.byProvider.get(A)?.map((o) => o.id)).toEqual(['o1', 'o3'])
    expect(g.byProvider.get(B)?.map((o) => o.id)).toEqual(['o2'])
    expect(g.unassigned.map((o) => o.id)).toEqual(['o4'])
    expect(g.mismatched.map((o) => o.id)).toEqual(['o5'])
  })
})

describe('the sync runs through the IProviderAdapter contract', () => {
  const order = (over: Partial<SyncOrder> = {}): SyncOrder => ({
    id: 'o1', user_id: 'u1', service_id: 's1', provider_order_id: 'x', status: 'submitted', quantity: 1000, charge_amount: 4,
    remains: null, start_count: null, error_message: null, created_at: new Date().toISOString(), ...over,
  })
  const ports = () => {
    const calls = { partial: [] as number[], refunds: 0 }
    const p: SyncPorts = {
      setProviderOrderId: async () => {},
      updateOrder: async () => true,
      applyPartialRefund: async (_id, remains) => (calls.partial.push(remains), 1.6),
      refundOrder: async () => { calls.refunds++ },
      touch: async () => {},
    }
    return { p, calls }
  }
  const quiet = { error: vi.fn(), warn: vi.fn() }

  it('a MockProviderAdapter (an IProviderAdapter) serves Partial and Canceled answers', async () => {
    const adapter: IProviderAdapter = new MockProviderAdapter({ id: 'mock', name: 'Mock' })
    const a = (await adapter.createOrder({ serviceId: '1001', link: 'https://t.me/x', quantity: 1000 })).orderId
    const b = (await adapter.createOrder({ serviceId: '1001', link: 'https://t.me/y', quantity: 1000 })).orderId
    const mock = adapter as MockProviderAdapter
    mock.setStatus(a, 'partial', 400)
    mock.setStatus(b, 'canceled')

    const { p, calls } = ports()
    const stats = await syncProviderOrders([order({ id: 'o1', provider_order_id: a }), order({ id: 'o2', provider_order_id: b })], adapter, p, {}, quiet)
    expect(calls.partial).toEqual([400])
    expect(calls.refunds).toBe(1)
    expect(stats).toMatchObject({ partial: 1, canceledRefunded: 1, errors: [] })
  })

  it('a status query that fails refunds nothing', async () => {
    const adapter = new MockProviderAdapter({ id: 'mock', name: 'Mock' })
    const id = (await adapter.createOrder({ serviceId: '1001', link: 'https://t.me/x', quantity: 1000 })).orderId
    adapter.failNext('getOrderStatus', new Error('panel down'))
    const { p, calls } = ports()
    const stats = await syncProviderOrders([order({ provider_order_id: id })], adapter, p, {}, quiet)
    expect(calls).toEqual({ partial: [], refunds: 0 })
    expect(stats.errors).toHaveLength(1)
  })
})

describe('failover orders carry the accepting provider in the database', () => {
  let db: PGlite
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }, 180_000)

  it('place_order on the fallback offer stores the fallback provider on the order; a mismatching provider is refused', async () => {
    const one = async (sql: string, p: unknown[] = []) => (await db.query<{ id: string }>(sql, p)).rows[0].id
    const pa = await one(`insert into providers(name, api_url) values ('Primary', 'https://a.invalid') returning id`)
    const pb = await one(`insert into providers(name, api_url) values ('Fallback', 'https://b.invalid') returning id`)
    const cat = await one(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id`)
    const psa = await one(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'a', 1, 1, 100000) returning id`, [pa])
    const psb = await one(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '2', 'b', 2, 1, 100000) returning id`, [pb])
    const svc = await one(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'S', $2, 4, 1, 100000) returning id`, [cat, psa])
    const offerB = await one(`insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values ($1, $2, $3, 2, 1, 100000) returning id`, [svc, pb, psb])
    const user = await one(`insert into users(telegram_id) values (77) returning id`)
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100::numeric, null, 'fund', 'fund-77')`, [user])

    const placed = await db.query<{ provider_id: string; provider_offer_id: string }>(
      `select provider_id, provider_offer_id from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, 'k1')`, [user, svc, offerB, pb, psb])
    expect(placed.rows[0]).toEqual({ provider_id: pb, provider_offer_id: offerB })

    // the offer belongs to B: asking for it with provider A is refused, so an order can never carry A's id with B's offer
    await expect(db.query(`select place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, 'k2')`, [user, svc, offerB, pa, psb])).rejects.toThrow(/provider offer not found/)
  })
})
