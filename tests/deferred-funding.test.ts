// Deferred funding: orders paid while the provider has no money wait, are sent when the provider is topped up, and are refunded after the limit.
// Real SQL on PGlite (every migration), the pure flow with fake ports, and the whole chain with the real database behind the worker's ports.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { emptyFundedReport, FUNDED_BATCH, releaseFundedOrders, type FundedOrder, type FundedPorts } from '../supabase/functions/_shared/funded-orders.ts'
import { executePlaceOrder, IN_FLIGHT_NOTE, type OrderRecord, type PlaceOrderPorts } from '../supabase/functions/_shared/place-order-flow.ts'
import { SMMProviderError } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { unfundedFromRpc } from '../src/services/api/admin'

const quiet = { warn() {}, error() {} }
const PROV = '00000000-0000-0000-0000-0000000000a2'
const PS = '00000000-0000-0000-0000-000000000a01'
const OFFER = '00000000-0000-0000-0000-00000000aa01'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const CAT = '00000000-0000-0000-0000-0000000000c1'

async function world() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  // rate 1.00 per 1000: an order of 10,000 costs 10.00 at the provider and (price 4.00 per 1000) 40.00 for the customer
  await db.exec(`
    insert into providers(id, name, api_url, routing_enabled, health_status, is_active) values ('${PROV}', 'A', 'https://a', true, 'healthy', true);
    insert into categories(id, platform_id, name, slug) values ('${CAT}', (select id from platforms where slug = 'telegram'), 'Views', 'views');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('${PS}', '${PROV}', '77', 'A views', 1.0, 100, 100000);
    insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      values ('${SVC}', '${CAT}', 'Views', '${PS}', 4.0, 100, 100000);
    delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score)
      values ('${OFFER}', '${SVC}', '${PROV}', '${PS}', 1.0, 100, 100000, 100);`)
  return db
}

describe('deferred funding (real SQL)', () => {
  let db: PGlite
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await q<{ v: T }>(sql, p))[0].v

  const user = async (tg: number, funds = 1000, admin = false) => {
    const id = await one<string>(`insert into users(telegram_id, is_admin) values ($1, $2) returning id v`, [tg, admin])
    if (funds > 0) await db.query(`select process_wallet_transaction($1::uuid,'deposit',$2::numeric,null,'fund','fund-'||$1::text)`, [id, funds])
    return id
  }
  const providerBalance = async (b: number | null) => db.query(`update providers set provider_balance = $1, last_balance_sync = case when $2 then now() else null end where id = '${PROV}'`, [b ?? 0, b !== null])
  const settings = (sql: string) => db.exec(`update platform_settings set ${sql} where id = 1`)
  const place = (u: string, key: string, o: { qty?: number; allow?: boolean } = {}) => {
    const qty = o.qty ?? 10_000
    return db.query<Record<string, any>>(
      `select * from place_order($1::uuid, '${SVC}', 'https://t.me/x', $2::int, '${OFFER}', '${PROV}', '${PS}', $3::numeric, $4::text, null, $5::boolean)`,
      [u, qty, qty / 1000, key, o.allow ?? true],
    ).then((r) => r.rows[0])
  }
  const wallet = async (u: string) => Number(await one<string>(`select balance::text v from wallets where user_id = $1`, [u]))
  const order = async (id: string) => (await q(`select status::text, awaiting_funds_since, provider_reservation::float8 res, error_message, charge_amount::float8 charge from orders where id = $1`, [id]))[0]

  beforeEach(async () => {
    db = await world()
    await settings(`deferred_orders_enabled = true`)
    await providerBalance(3) // $3 at the provider: an order costing $10 cannot be paid for
  }, 180_000)

  it('is off by default, the migrations seed it as a closed door with a $200 cap and 24 hours', async () => {
    const fresh = await world()
    const r = (await fresh.query<Record<string, any>>(`select deferred_orders_enabled, deferred_orders_cap::float8 cap, deferred_orders_ttl_hours ttl from platform_settings`)).rows[0]
    expect(r).toEqual({ deferred_orders_enabled: false, cap: 200, ttl: 24 })
  }, 120_000)

  it('refuses as before when the caller does not ask for it, or the switch is off', async () => {
    const u = await user(1)
    await expect(place(u, 'k1', { allow: false })).rejects.toThrow(/insufficient_provider_balance/)
    await settings(`deferred_orders_enabled = false`)
    await expect(place(u, 'k2', { allow: true })).rejects.toThrow(/insufficient_provider_balance/)
    expect(await wallet(u)).toBe(1000) // nothing was charged
    expect(await q(`select 1 from orders`)).toHaveLength(0)
  })

  it('accepts and charges the order, reserves nothing, and marks it as waiting; a replay returns the same order', async () => {
    const u = await user(1)
    const o = await place(u, 'k1')
    expect(o).toMatchObject({ status: 'paid' })
    expect(o.awaiting_funds_since).not.toBeNull()
    expect(Number(o.provider_reservation)).toBe(0)
    expect(await wallet(u)).toBe(1000 - 40)
    expect(Number(await one<string>(`select provider_balance::text v from providers where id = '${PROV}'`))).toBe(3) // untouched
    const again = await place(u, 'k1')
    expect(again.id).toBe(o.id)
    expect(await wallet(u)).toBe(960) // charged once
  })

  it('a provider that CAN pay is used as always: nothing waits', async () => {
    await providerBalance(500)
    const u = await user(1)
    const o = await place(u, 'k1')
    expect(o.awaiting_funds_since).toBeNull()
    expect(Number(o.provider_reservation)).toBe(10)
  })

  it('keeps the waiting customer money under the cap: the order that would pass it is refused and costs nothing', async () => {
    await settings(`deferred_orders_cap = 100`)
    const u = await user(1)
    await place(u, 'a') // 40
    await place(u, 'b') // 80
    await expect(place(u, 'c')).rejects.toThrow(/insufficient_provider_balance/) // 120 > 100
    expect(await wallet(u)).toBe(1000 - 80)
    expect(await q(`select 1 from orders where awaiting_funds_since is not null`)).toHaveLength(2)
  })

  it('claims nothing while the provider is still short, then sends oldest first as the money arrives, reserving each cost', async () => {
    const u = await user(1)
    const a = await place(u, 'a'); const b = await place(u, 'b'); const c = await place(u, 'c')
    expect(await one(`select claim_funded_orders() v`)).toEqual([])
    await providerBalance(25) // room for two orders of $10
    const claimed = await one<{ id: string; external_service_id: string; target_url: string; quantity: number }[]>(`select claim_funded_orders() v`)
    expect(claimed.map((x) => x.id)).toEqual([a.id, b.id])
    expect(claimed[0]).toMatchObject({ external_service_id: '77', target_url: 'https://t.me/x', quantity: 10_000 })
    expect(Number(await one<string>(`select provider_balance::text v from providers where id = '${PROV}'`))).toBe(5)
    expect(await order(a.id)).toMatchObject({ status: 'processing', awaiting_funds_since: null, res: 10, error_message: IN_FLIGHT_NOTE })
    expect(await order(c.id)).toMatchObject({ status: 'paid', res: 0 })
    expect(await one(`select claim_funded_orders() v`)).toEqual([]) // the third still does not fit
  })

  it('first come, first served among the WAITING orders of a provider: a small one never jumps ahead of an older one that does not fit yet', async () => {
    const u = await user(1)
    await settings(`deferred_orders_cap = 500`) // the two orders together are $216 of customer money
    const big = await place(u, 'big', { qty: 50_000 }) // costs $50
    const small = await place(u, 'small', { qty: 4_000 }) // costs $4: more than the $3 at the provider, so it waits too
    await providerBalance(20)
    expect(await one(`select claim_funded_orders() v`)).toEqual([]) // the big one is first in line and does not fit; the small one waits behind it
    expect(await order(small.id)).toMatchObject({ status: 'paid' })
    await providerBalance(60)
    const claimed = await one<{ id: string }[]>(`select claim_funded_orders() v`)
    expect(claimed.map((x) => x.id)).toEqual([big.id, small.id])
  })

  it('does not send an order the provider has meanwhile made dearer than what the customer paid; it keeps waiting', async () => {
    const u = await user(1)
    const o = await place(u, 'a')
    await providerBalance(500)
    await db.exec(`update provider_service_offers set cost_per_1000 = 4.5 where id = '${OFFER}'`) // now $45 for what the customer paid $40
    expect(await one(`select claim_funded_orders() v`)).toEqual([])
    expect(await order(o.id)).toMatchObject({ status: 'paid' })
    await db.exec(`update provider_service_offers set cost_per_1000 = 1.0 where id = '${OFFER}'`)
    expect(await one<unknown[]>(`select claim_funded_orders() v`)).toHaveLength(1)
  })

  it('sends nothing while the provider is unhealthy, routing is off, in maintenance, or for a provider the caller cannot reach', async () => {
    const u = await user(1)
    await place(u, 'a')
    await providerBalance(500)
    await db.exec(`update providers set health_status = 'unavailable'`)
    expect(await one(`select claim_funded_orders() v`)).toEqual([])
    await db.exec(`update providers set health_status = 'healthy', routing_enabled = false`)
    expect(await one(`select claim_funded_orders() v`)).toEqual([])
    await db.exec(`update providers set routing_enabled = true`)
    await settings(`maintenance_mode = true`)
    expect(await one(`select claim_funded_orders() v`)).toEqual([])
    await settings(`maintenance_mode = false`)
    expect(await one(`select claim_funded_orders(10, array['00000000-0000-0000-0000-000000000001']::uuid[]) v`)).toEqual([])
    expect(await one<unknown[]>(`select claim_funded_orders(10, array['${PROV}']::uuid[]) v`)).toHaveLength(1)
  })

  it('refunds in full what has waited longer than the limit, leaves the fresh ones, and the customer is told', async () => {
    const u = await user(1)
    const old = await place(u, 'old'); const fresh = await place(u, 'fresh')
    await db.exec(`update orders set awaiting_funds_since = now() - interval '25 hours' where id = '${old.id}'`)
    expect(await wallet(u)).toBe(1000 - 80)
    expect(await one(`select expire_unfunded_orders() v`)).toEqual({ refunded: 1, failed: 0 })
    expect(await wallet(u)).toBe(1000 - 40)
    expect(await order(old.id)).toMatchObject({ status: 'refunded', awaiting_funds_since: null })
    expect(await order(fresh.id)).toMatchObject({ status: 'paid' })
    expect(await q(`select kind from notification_outbox where order_id = '${old.id}'`)).toEqual([{ kind: 'canceled' }])
    expect(await one(`select expire_unfunded_orders() v`)).toEqual({ refunded: 0, failed: 0 }) // idempotent
  })

  it('the time limit is a setting', async () => {
    const u = await user(1)
    const o = await place(u, 'a')
    await db.exec(`update orders set awaiting_funds_since = now() - interval '3 hours' where id = '${o.id}'`)
    expect(await one(`select expire_unfunded_orders() v`)).toEqual({ refunded: 0, failed: 0 })
    await settings(`deferred_orders_ttl_hours = 2`)
    expect(await one(`select expire_unfunded_orders() v`)).toEqual({ refunded: 1, failed: 0 })
  })

  it('tells the admin what to transfer and where, once per change of the count (and not again on the next tick)', async () => {
    const admin = await user(99, 0, true)
    const u = await user(1)
    await db.exec(`select notify_admin_anomalies()`)
    expect(await q(`select 1 from notification_outbox where kind = 'admin_alert'`)).toHaveLength(0) // nothing waits, nothing is said
    await place(u, 'a'); await place(u, 'b')
    const summary = unfundedFromRpc(await one(`select unfunded_orders_summary() v`))
    expect(summary).toMatchObject({ count: 2, charge: 80, cost: 20 })
    expect(summary.providers).toEqual([expect.objectContaining({ name: 'A', count: 2, cost: 20, balance: 3 })])
    await db.exec(`select notify_admin_anomalies()`)
    await db.exec(`select notify_admin_anomalies()`)
    const alerts = await q(`select payload from notification_outbox where kind = 'admin_alert' and user_id = $1`, [admin])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].payload.headline).toBe('2 paid order(s) wait for a provider top-up')
    expect(alerts[0].payload.detail).toContain('Transfer about $20.00 to: A $20.00 (2)')
    await place(u, 'c')
    await db.exec(`select notify_admin_anomalies()`)
    expect(await q(`select 1 from notification_outbox where kind = 'admin_alert' and user_id = $1`, [admin])).toHaveLength(2)
  })

  it('is service-role only, and a customer reads only the waiting flag of their own order', async () => {
    for (const fn of ['claim_funded_orders(integer, uuid[])', 'expire_unfunded_orders()', 'unfunded_orders_summary()', 'notify_admin_anomalies()']) {
      for (const role of ['anon', 'authenticated']) expect((await q(`select has_function_privilege('${role}', 'public.${fn}', 'execute') ok`))[0].ok, `${role} ${fn}`).toBe(false)
      expect((await q(`select has_function_privilege('service_role', 'public.${fn}', 'execute') ok`))[0].ok, fn).toBe(true)
    }
    for (const role of ['anon', 'authenticated']) {
      expect((await q(`select has_function_privilege('${role}', 'public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean)', 'execute') ok`))[0].ok).toBe(false)
    }
    expect((await q(`select has_column_privilege('authenticated', 'public.orders', 'awaiting_funds_since', 'select') ok`))[0].ok).toBe(true)
    expect((await q(`select has_column_privilege('anon', 'public.orders', 'awaiting_funds_since', 'select') ok`))[0].ok).toBe(false)
    expect((await q(`select has_column_privilege('authenticated', 'public.orders', 'provider_reservation', 'select') ok`))[0].ok).toBe(false)
    expect((await q(`select has_table_privilege('authenticated', 'public.platform_settings', 'select') ok`))[0].ok).toBe(false)
  })

  describe('the whole chain: pay, wait, top up, the worker sends it', () => {
    /** The worker's ports on the real database; the panel is a fake. */
    const chain = (panel: { createOrder: (a: { serviceId: string; link: string; quantity: number }) => Promise<{ orderId: string }> }) => {
      const asOrder = (r: Record<string, any>) => r as unknown as OrderRecord
      const orders: PlaceOrderPorts = {
        placeOrder: async () => { throw new Error('not used by the worker') },
        claim: async () => { throw new Error('the database claims for the worker') },
        get: async (id) => asOrder((await q(`select * from orders where id = $1`, [id]))[0]),
        update: async (id, patch) => asOrder((await q(
          `update orders set status = $2, provider_order_id = coalesce($3, provider_order_id), error_message = $4 where id = $1 returning *`,
          [id, patch.status, patch.provider_order_id ?? null, patch.error_message ?? null]))[0]),
        refund: async (id, comment) => asOrder((await q(`select * from refund_order($1::uuid, null, $2)`, [id, comment]))[0]),
        releaseReservation: async (id) => { await q(`select release_provider_reservation($1::uuid)`, [id]) },
      }
      const ports: FundedPorts = {
        expire: async () => (await q<{ v: { refunded: number; failed: number } }>(`select expire_unfunded_orders() v`))[0].v,
        claim: async (limit, ids) => (await q<{ v: FundedOrder[] }>(`select claim_funded_orders($1::int, $2::uuid[]) v`, [limit, ids]))[0].v,
        adapters: async () => new Map([[PROV, panel]]),
        orders,
      }
      return ports
    }

    it('the order is sent once the provider has the money, with the panel order id recorded and the reservation kept', async () => {
      const u = await user(1)
      const o = await place(u, 'a')
      const sent: unknown[] = []
      const panel = { createOrder: async (a: { serviceId: string; link: string; quantity: number }) => { sent.push(a); return { orderId: '555' } } }
      const ports = chain(panel)

      expect(await releaseFundedOrders(ports, quiet)).toEqual({ ...emptyFundedReport(), claimed: 0 }) // still no money: nothing happens
      expect(sent).toEqual([])

      await providerBalance(30) // the owner topped the provider up; the health monitor read the new balance
      const report = await releaseFundedOrders(ports, quiet)
      expect(report).toMatchObject({ claimed: 1, submitted: 1, held: 0, rejected: 0, errors: 0 })
      expect(sent).toEqual([{ serviceId: '77', link: 'https://t.me/x', quantity: 10_000 }])
      expect(await order(o.id)).toMatchObject({ status: 'submitted', awaiting_funds_since: null, res: 10, error_message: null })
      expect(await q(`select provider_order_id from orders where id = $1`, [o.id])).toEqual([{ provider_order_id: '555' }])
      expect(Number(await one<string>(`select provider_balance::text v from providers where id = '${PROV}'`))).toBe(20)
      expect(await wallet(u)).toBe(960) // paid once, still paid
      expect((await releaseFundedOrders(ports, quiet)).claimed).toBe(0) // nothing is sent twice
      expect(sent).toHaveLength(1)
    })

    it('a panel that refuses the order for good: the customer is refunded and the reservation given back', async () => {
      const u = await user(1)
      const o = await place(u, 'a')
      await providerBalance(30)
      const panel = { createOrder: async () => { throw new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link' }) } }
      const report = await releaseFundedOrders(chain(panel), quiet)
      expect(report).toMatchObject({ claimed: 1, rejected: 1, submitted: 0 })
      expect(await order(o.id)).toMatchObject({ status: 'refunded' })
      expect(await wallet(u)).toBe(1000)
      expect(Number(await one<string>(`select provider_balance::text v from providers where id = '${PROV}'`))).toBe(30) // the $10 came back
    })

    it('a panel that does not answer: the order is HELD for reconciliation, never refunded and never sent again', async () => {
      const u = await user(1)
      const o = await place(u, 'a')
      await providerBalance(30)
      let calls = 0
      const panel = { createOrder: async () => { calls++; throw new SMMProviderError('timeout', 'add: no response within 10000ms', { ambiguous: true }) } }
      const ports = chain(panel)
      const report = await releaseFundedOrders(ports, quiet)
      expect(report).toMatchObject({ claimed: 1, held: 1, rejected: 0 })
      expect(await order(o.id)).toMatchObject({ status: 'processing' })
      expect((await order(o.id)).error_message).toContain('needs_reconciliation')
      expect(await wallet(u)).toBe(960)
      await releaseFundedOrders(ports, quiet)
      expect(calls).toBe(1)
    })

    it('an order that waited too long is refunded by the same run, before anything is claimed', async () => {
      const u = await user(1)
      const o = await place(u, 'a')
      await db.exec(`update orders set awaiting_funds_since = now() - interval '30 hours' where id = '${o.id}'`)
      await providerBalance(30)
      const report = await releaseFundedOrders(chain({ createOrder: async () => ({ orderId: '1' }) }), quiet)
      expect(report).toMatchObject({ expired: 1, claimed: 0, submitted: 0 })
      expect(await order(o.id)).toMatchObject({ status: 'refunded' })
      expect(await wallet(u)).toBe(1000)
    })
  })
})

// ---------------------------------------------------------------------------
// The flow and the worker with fake ports
// ---------------------------------------------------------------------------
const record = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  id: 'o1', user_id: 'u1', service_id: 's1', target_url: 'https://t.me/x', quantity: 1000, charge_amount: 4, status: 'paid',
  provider_order_id: null, error_message: null, ...over,
})

describe('executePlaceOrder with a waiting order', () => {
  const ports = (placed: OrderRecord) => {
    const calls: string[] = []
    const p: PlaceOrderPorts = {
      placeOrder: async (a) => { calls.push(`place:${a.allowUnfunded === true}`); return placed },
      claim: async () => { calls.push('claim'); return record({ status: 'processing' }) },
      get: async () => placed,
      update: async () => placed,
      refund: async () => placed,
    }
    return { p, calls }
  }
  const req = { userId: 'u1', serviceId: 's1', targetUrl: 'https://t.me/x', quantity: 1000, idempotencyKey: 'k', providerOfferId: 'of', providerId: 'p', providerServiceId: 'ps', costAmount: 1, externalServiceId: '77', allowUnfunded: true }

  it('stops after the charge: no claim, nothing is sent', async () => {
    const { p, calls } = ports(record({ awaiting_funds_since: '2026-10-09T00:00:00Z' }))
    let sent = 0
    const r = await executePlaceOrder(req, p, { createOrder: async () => { sent++; return { orderId: '1' } } }, quiet)
    expect(r.kind).toBe('awaiting_funds')
    expect(calls).toEqual(['place:true'])
    expect(sent).toBe(0)
  })

  it('a normal paid order is still claimed and sent', async () => {
    const { p, calls } = ports(record())
    let sent = 0
    const r = await executePlaceOrder({ ...req, allowUnfunded: false }, p, { createOrder: async () => { sent++; return { orderId: '1' } } }, quiet)
    expect(calls).toEqual(['place:false', 'claim'])
    expect(sent).toBe(1)
    expect(r.kind).toBe('submitted')
  })
})

describe('releaseFundedOrders (fake ports)', () => {
  const claimedOrder = (id: string): FundedOrder => ({ id, user_id: 'u', provider_id: 'p1', target_url: 'https://t.me/x', quantity: 1000, charge_amount: 4, external_service_id: '77' })
  const fake = (over: Partial<FundedPorts> = {}) => {
    const log: string[] = []
    const ports: FundedPorts = {
      expire: async () => { log.push('expire'); return { refunded: 0, failed: 0 } },
      claim: async (limit, ids) => { log.push(`claim:${limit}:${ids.join(',')}`); return [] },
      adapters: async () => new Map([['p1', { createOrder: async () => ({ orderId: '9' }) }]]),
      orders: {
        placeOrder: async () => record(), claim: async () => null,
        get: async (id) => record({ id, status: 'processing' }),
        update: async (id, patch) => record({ id, ...patch }),
        refund: async (id) => record({ id, status: 'refunded' }),
      },
      ...over,
    }
    return { ports, log }
  }

  it('expires first, then claims only for the providers it can reach, a bounded number', async () => {
    const { ports, log } = fake()
    const r = await releaseFundedOrders(ports, quiet)
    expect(log).toEqual(['expire', `claim:${FUNDED_BATCH}:p1`])
    expect(r).toEqual(emptyFundedReport())
  })

  it('claims nothing when no provider can be reached (a claimed order that cannot be sent would sit in processing)', async () => {
    const { ports, log } = fake({ adapters: async () => new Map() })
    await releaseFundedOrders(ports, quiet)
    expect(log).toEqual(['expire'])
  })

  it('sends every claimed order, counts the outcomes, and a failure in one never stops the rest', async () => {
    let n = 0
    const { ports } = fake({
      claim: async () => [claimedOrder('a'), claimedOrder('b'), claimedOrder('c'), claimedOrder('d')],
      adapters: async () => new Map([['p1', {
        createOrder: async () => {
          n++
          if (n === 2) throw new SMMProviderError('api', 'bad link', { code: 'invalid_link' })
          if (n === 3) throw new SMMProviderError('timeout', 'slow', { ambiguous: true })
          return { orderId: String(n) }
        },
      }]]),
    })
    const r = await releaseFundedOrders(ports, quiet)
    expect(r).toMatchObject({ claimed: 4, submitted: 2, rejected: 1, held: 1, errors: 0 })
  })

  it('an order it cannot even read after the claim is an error for reconciliation, not a refund or a re-send', async () => {
    const refunds: string[] = []
    const { ports } = fake({
      claim: async () => [claimedOrder('a'), claimedOrder('b')],
      orders: {
        placeOrder: async () => record(), claim: async () => null,
        get: async (id) => { if (id === 'a') throw new Error('db down'); return record({ id, status: 'processing' }) },
        update: async (id, patch) => record({ id, ...patch }),
        refund: async (id) => { refunds.push(id); return record({ id }) },
      },
    })
    const r = await releaseFundedOrders(ports, quiet)
    expect(r).toMatchObject({ claimed: 2, submitted: 1, errors: 1 })
    expect(refunds).toEqual([])
  })

  it('a failing expiry or claim is reported and never throws', async () => {
    const a = await releaseFundedOrders(fake({ expire: async () => { throw new Error('x') } }).ports, quiet)
    expect(a.errors).toBe(1)
    const b = await releaseFundedOrders(fake({ claim: async () => { throw new Error('y') } }).ports, quiet)
    expect(b).toMatchObject({ errors: 1, claimed: 0 })
    const c = await releaseFundedOrders(fake({ adapters: async () => { throw new Error('z') } }).ports, quiet)
    expect(c.errors).toBe(1)
  })
})

describe('unfundedFromRpc', () => {
  it('maps the summary and treats a missing one as nothing waiting', () => {
    expect(unfundedFromRpc(null)).toMatchObject({ count: 0, providers: [] })
    expect(unfundedFromRpc({ count: '2', charge: '80.0000', cost: 20, oldest: 't', providers: [{ id: 'p', name: 'A', count: 2, cost: '20.0000', balance: '3.0000', oldest: 't' }] }))
      .toEqual({ count: 2, charge: 80, cost: 20, oldest: 't', providers: [{ id: 'p', name: 'A', count: 2, cost: 20, balance: 3, oldest: 't' }] })
  })
})
