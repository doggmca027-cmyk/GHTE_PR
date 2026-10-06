import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, vi } from 'vitest'
import {
  NEEDS_REFUND,
  calcPartialRefund,
  calcPartialRefundUnits,
  chunkArray,
  emptySyncStats,
  recoverProviderOrderId,
  stepsTo,
  syncProviderOrders,
  type OrderFieldsPatch,
  type SyncOrder,
  type SyncPorts,
} from '../supabase/functions/_shared/order-sync.ts'
import { ALL_ORDER_STATUSES, isValidOrderTransition } from '../supabase/functions/_shared/order-transitions.ts'
import { SMMProviderError, SMMv2Adapter, parseBatchStatusResponse } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { BatchStatusEntry, IProviderOrderStatus, OrderStatus } from '../supabase/functions/_shared/types.ts'
import { MOCK_CATALOG } from '../src/constants/dev'
import { MOCK_PARTIAL_REMAINS_RATIO, createMockBackend, mockScenario } from '../src/services/api/mock-orders'

// ---------------------------------------------------------------------------
// 1. SMM v2 multi-order status payloads
// ---------------------------------------------------------------------------

describe('parseBatchStatusResponse (SMM v2 multi-order status)', () => {
  it('maps the standard map keyed by order id (string numbers, all statuses)', () => {
    const out = parseBatchStatusResponse(
      {
        '1': { charge: '0.27819', start_count: '3572', status: 'Partial', remains: '157', currency: 'USD' },
        '2': { charge: '1.5', start_count: '0', status: 'Completed', remains: '0', currency: 'USD' },
        '3': { status: 'In progress', remains: '900', start_count: '12' },
        '4': { status: 'Pending' },
        '5': { status: 'Canceled', remains: '1000' },
        '6': { status: 'Processing', remains: 5 },
      },
      ['1', '2', '3', '4', '5', '6'],
    )
    expect(out['1']).toEqual({
      ok: true,
      status: { orderId: '1', rawStatus: 'Partial', status: 'partial', charge: 0.27819, currency: 'USD', startCount: 3572, remains: 157 },
    })
    expect(Object.fromEntries(Object.entries(out).map(([id, e]) => [id, e.ok ? e.status.status : 'ERR']))).toEqual({
      '1': 'partial', '2': 'completed', '3': 'in_progress', '4': 'submitted', '5': 'canceled', '6': 'in_progress',
    })
    expect(out['3']).toMatchObject({ ok: true, status: { remains: 900, startCount: 12 } })
    expect(out['4']).toMatchObject({ ok: true, status: { remains: undefined, startCount: undefined } })
  })

  it('turns per-order errors into error entries without failing the rest', () => {
    const out = parseBatchStatusResponse({ '1': { status: 'Completed', remains: '0' }, '2': { error: 'Incorrect order ID' } }, ['1', '2'])
    expect(out['1'].ok).toBe(true)
    expect(out['2']).toEqual({ ok: false, error: 'Incorrect order ID', code: 'order_not_found' })
  })

  it('never treats an unanswered id as a terminal status', () => {
    const out = parseBatchStatusResponse({ '1': { status: 'Completed' } }, ['1', '2', '3'])
    expect(out['2']).toMatchObject({ ok: false, code: 'order_not_found' })
    expect(out['3']).toMatchObject({ ok: false })
  })

  it('rejects unknown statuses and non-object entries per order', () => {
    const out = parseBatchStatusResponse({ '1': { status: 'Exploded' }, '2': 'oops', '3': { status: 'Partial', remains: 'abc' } }, ['1', '2', '3'])
    for (const id of ['1', '2', '3']) expect(out[id].ok).toBe(false)
  })

  it('accepts an array reply (items carry an "order" field) and a bare object for a single id', () => {
    const arr = parseBatchStatusResponse([{ order: 7, status: 'Completed', remains: 0 }, { order: '8', status: 'Pending' }], ['7', '8'])
    expect(arr['7']).toMatchObject({ ok: true, status: { status: 'completed' } })
    expect(arr['8']).toMatchObject({ ok: true, status: { status: 'submitted' } })

    const single = parseBatchStatusResponse({ status: 'In progress', remains: '40', start_count: '1' }, ['99'])
    expect(single['99']).toMatchObject({ ok: true, status: { orderId: '99', status: 'in_progress', remains: 40 } })
  })

  it('ignores ids the panel returned but we did not ask for', () => {
    expect(Object.keys(parseBatchStatusResponse({ '1': { status: 'Completed' }, '2': { status: 'Completed' } }, ['1']))).toEqual(['1'])
  })

  it('rejects a payload that is not an object or array', () => {
    expect(() => parseBatchStatusResponse('nope', ['1'])).toThrow(SMMProviderError)
    expect(() => parseBatchStatusResponse(null, ['1'])).toThrow(SMMProviderError)
  })
})

describe('SMMv2Adapter.getOrdersStatus', () => {
  const adapterWith = (impl: (body: URLSearchParams) => Response) => {
    const calls: URLSearchParams[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as URLSearchParams)
      calls.push(body)
      return impl(body)
    }) as unknown as typeof fetch
    return { calls, adapter: new SMMv2Adapter({ id: 'p', name: 'P', apiUrl: 'https://panel.test/api/v2', apiKey: 'KEY', fetchImpl }) }
  }

  it('sends ONE request with orders=id1,id2,id3 and maps the keyed reply', async () => {
    const { adapter, calls } = adapterWith(() => new Response(JSON.stringify({ '10': { status: 'Completed', remains: '0' }, '11': { error: 'Incorrect order ID' } })))
    const out = await adapter.getOrdersStatus(['10', '11'])
    expect(calls).toHaveLength(1)
    expect([calls[0].get('action'), calls[0].get('orders'), calls[0].get('key')]).toEqual(['status', '10,11', 'KEY'])
    expect(out['10'].ok).toBe(true)
    expect(out['11']).toMatchObject({ ok: false, code: 'order_not_found' })
  })

  it('does not call the panel for an empty list', async () => {
    const { adapter, calls } = adapterWith(() => new Response('{}'))
    expect(await adapter.getOrdersStatus([])).toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('surfaces a top-level API error (e.g. bad key) as an exception, not as order statuses', async () => {
    const { adapter } = adapterWith(() => new Response(JSON.stringify({ error: 'Incorrect API key' })))
    await expect(adapter.getOrdersStatus(['1'])).rejects.toMatchObject({ kind: 'api', code: 'invalid_api_key' })
  })

  it('mock mode reports every order delivered without network access', async () => {
    const boom = (async () => { throw new Error('no network in mock mode') }) as unknown as typeof fetch
    const out = await new SMMv2Adapter({ id: 'm', name: 'M', apiUrl: 'x', fetchImpl: boom }).getOrdersStatus(['1', '2'])
    expect(Object.values(out).every((e) => e.ok && e.status.status === 'completed')).toBe(true)
  })
})

describe('sync helpers', () => {
  it('chunks lists', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkArray([], 3)).toEqual([])
  })

  it('recovers a provider order id from a reconciliation note', () => {
    expect(recoverProviderOrderId('needs_reconciliation: provider accepted as 12345 but database update failed')).toBe('12345')
    expect(recoverProviderOrderId('needs_reconciliation: timeout: add: no response')).toBeNull()
    expect(recoverProviderOrderId(null)).toBeNull()
  })

  it('plans only valid forward moves', () => {
    expect(stepsTo('submitted', 'in_progress')).toEqual(['in_progress'])
    expect(stepsTo('submitted', 'completed')).toEqual(['completed'])
    expect(stepsTo('in_progress', 'in_progress')).toEqual([])
    expect(stepsTo('processing', 'completed')).toEqual(['submitted', 'completed'])
    expect(stepsTo('processing', 'in_progress')).toEqual(['submitted', 'in_progress'])
    expect(stepsTo('in_progress', 'submitted')).toBeNull() // never regress
    expect(stepsTo('completed', 'in_progress')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Partial refund maths (no rounding leaks)
// ---------------------------------------------------------------------------

describe('partial refund calculation', () => {
  it.each([
    // quantity, remains, charge ($), expected refund ($)
    [1000, 250, 5.4, 1.35],
    [1000, 1, 5.4, 0.0054],
    [1000, 0, 5.4, 0],
    [1000, 1000, 5.4, 5.4],
    [3, 1, 1, 0.3333],
    [3, 2, 1, 0.6667],
    [7, 3, 0.0001, 0],
    [7, 4, 0.0001, 0.0001],
    [999, 333, 2.5, 0.8333],
    [1500, 700, 10.8, 5.04],
    [50, 49, 0.27, 0.2646],
    [1, 1, 0.0001, 0.0001],
  ])('%d units, %d undelivered, charged $%s -> refund $%s', (quantity, remains, charge, expected) => {
    expect(calcPartialRefund(quantity, remains, charge)).toBe(expected)
  })

  it('rounds half up in 1e-4 units (same as PostgreSQL round)', () => {
    expect(calcPartialRefundUnits(2, 1, 1)).toBe(1n) // 0.5 unit -> 1
    expect(calcPartialRefundUnits(4, 1, 2)).toBe(1n) // 0.5 -> 1
    expect(calcPartialRefundUnits(4, 1, 1)).toBe(0n) // 0.25 -> 0
    expect(calcPartialRefundUnits(4, 3, 1)).toBe(1n) // 0.75 -> 1
  })

  it('never leaks: 0 <= refund <= charge, error <= half a unit, and refunded + retained == charge (randomised)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32)
    for (let i = 0; i < 3000; i++) {
      const quantity = 1 + Math.floor(rnd() * 100_000)
      const remains = Math.floor(rnd() * (quantity + 1))
      const charge = BigInt(1 + Math.floor(rnd() * 5_000_000)) // 1e-4 units, up to $500
      const refund = calcPartialRefundUnits(quantity, remains, charge)
      const retained = charge - refund

      expect(refund >= 0n && refund <= charge).toBe(true)
      expect(retained >= 0n).toBe(true)
      expect(refund + retained).toBe(charge) // exact: nothing created or destroyed
      // |refund - exact| <= 1/2 unit  <=>  |2*refund*q - 2*charge*remains| <= q
      const q = BigInt(quantity)
      const diff = 2n * refund * q - 2n * charge * BigInt(remains)
      expect((diff < 0n ? -diff : diff) <= q).toBe(true)
    }
  })

  it('is monotonic in remains and symmetric within one unit (delivered share + refunded share = charge)', () => {
    const quantity = 997
    const charge = 123_457n
    let prev = -1n
    for (let remains = 0; remains <= quantity; remains++) {
      const refund = calcPartialRefundUnits(quantity, remains, charge)
      expect(refund >= prev).toBe(true)
      prev = refund
      const deliveredShare = calcPartialRefundUnits(quantity, quantity - remains, charge)
      const sum = refund + deliveredShare
      expect(sum >= charge - 1n && sum <= charge + 1n).toBe(true)
    }
    expect(calcPartialRefundUnits(quantity, 0, charge)).toBe(0n)
    expect(calcPartialRefundUnits(quantity, quantity, charge)).toBe(charge)
  })

  it('rejects impossible inputs', () => {
    expect(() => calcPartialRefundUnits(0, 0, 1)).toThrow(RangeError)
    expect(() => calcPartialRefundUnits(10, 11, 1)).toThrow(RangeError)
    expect(() => calcPartialRefundUnits(10, -1, 1)).toThrow(RangeError)
    expect(() => calcPartialRefundUnits(10, 1.5, 1)).toThrow(RangeError)
    expect(() => calcPartialRefundUnits(10, 1, -1)).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// 3. Database: exactness against SQL, idempotency, no double refund
// ---------------------------------------------------------------------------

async function freshDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  await db.exec(`
    insert into providers(name, api_url) values ('p', 'https://x');
    insert into categories(platform, name, slug) values ('telegram', 'c', 'c');
    insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
      select id, '1', 's', 1, 1, 1000000 from providers;
    insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      select c.id, 's', ps.id, 1, 1, 1000000 from categories c, provider_services ps;`)
  return db
}

let telegramSeq = 0
async function paidOrder(db: PGlite, opts: { quantity: number; charge: string; status?: OrderStatus; userId?: string }) {
  const userId = opts.userId ?? (await db.query<{ id: string }>(`insert into users(telegram_id) values ($1) returning id`, [++telegramSeq])).rows[0].id
  await db.query(`select process_wallet_transaction($1,'deposit',1000,null,'fund','fund:'||gen_random_uuid())`, [userId])
  const { id } = (await db.query<{ id: string }>(
    `insert into orders(user_id, service_id, target_url, quantity, charge_amount, provider_id, provider_order_id)
     select $1, s.id, 'https://t.me/x', $2, $3, ps.provider_id, 'P-' || gen_random_uuid() from services s join provider_services ps on ps.id = s.primary_provider_service_id
     returning id`, [userId, opts.quantity, opts.charge])).rows[0]
  await db.query(`select process_wallet_transaction($1::uuid,'purchase',-$2::numeric,$3::uuid,'order','purchase:'||$3::text)`, [userId, opts.charge, id])
  const chain: OrderStatus[] = ['awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress']
  for (const s of chain) {
    await db.query(`update orders set status=$2 where id=$1`, [id, s])
    if (s === (opts.status ?? 'in_progress')) break
  }
  return { id, userId }
}
const balanceOf = async (db: PGlite, userId: string) => (await db.query<{ b: string }>(`select balance::text b from wallets where user_id=$1`, [userId])).rows[0].b
const ledgerOf = async (db: PGlite, orderId: string) =>
  (await db.query<{ type: string; amount: string; idempotency_key: string; description: string }>(
    `select type, amount::text, idempotency_key, description from wallet_transactions where reference_id=$1 and type in ('refund') order by created_at`, [orderId])).rows

describe('apply_partial_refund (atomic, single execution)', () => {
  it('SQL and TypeScript agree on the refund for many quantity/remains/charge combinations', async () => {
    const db = await freshDb()
    let seed = 99
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32)
    for (let i = 0; i < 40; i++) {
      const quantity = 1 + Math.floor(rnd() * 20_000)
      const remains = Math.floor(rnd() * (quantity + 1))
      const chargeUnits = 1 + Math.floor(rnd() * 400_000)
      const charge = (chargeUnits / 10_000).toFixed(4)
      const { id, userId } = await paidOrder(db, { quantity, charge })
      const before = Number((await balanceOf(db, userId)))

      const o = (await db.query<{ partial_refund_amount: string; status: string; remains: number }>(`select * from apply_partial_refund($1,$2,5)`, [id, remains])).rows[0]
      const expected = calcPartialRefundUnits(quantity, remains, chargeUnits)
      expect(BigInt(Math.round(Number(o.partial_refund_amount) * 10_000))).toBe(expected)
      expect(o.status).toBe('partial')
      expect(o.remains).toBe(remains)
      expect(Math.round((Number(await balanceOf(db, userId)) - before) * 10_000)).toBe(Number(expected))
      expect(await ledgerOf(db, id)).toHaveLength(expected > 0n ? 1 : 0) // a zero refund creates no ledger entry
    }
  }, 120_000)

  it('credits exactly once and records state, refund and ledger entry', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 1000, charge: '5.4000' })
    const before = await balanceOf(db, userId)

    const first = (await db.query<{ status: string; partial_refund_amount: string; remains: number; start_count: number }>(`select * from apply_partial_refund($1,250,40)`, [id])).rows[0]
    expect(first).toMatchObject({ status: 'partial', partial_refund_amount: '1.3500', remains: 250, start_count: 40 })
    expect(Number(await balanceOf(db, userId)) - Number(before)).toBeCloseTo(1.35, 4)

    expect(await ledgerOf(db, id)).toEqual([{ type: 'refund', amount: '1.3500', idempotency_key: `partial_refund:${id}`, description: `Partial refund for order #${id}` }])
    const history = (await db.query<{ old_status: string; new_status: string; comment: string }>(`select old_status, new_status, comment from order_status_history where order_id=$1 order by created_at, id`, [id])).rows
    expect(history.at(-1)).toMatchObject({ old_status: 'in_progress', new_status: 'partial' })
    expect(history.at(-1)!.comment).toContain('refunded 1.3500')
  }, 60_000)

  it('is idempotent: repeating (even with different numbers) changes nothing and credits nothing', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 1000, charge: '5.4000' })
    await db.query(`select * from apply_partial_refund($1,250,40)`, [id])
    const afterFirst = await balanceOf(db, userId)

    for (const remains of [250, 250, 900, 0]) {
      const again = (await db.query<{ partial_refund_amount: string; remains: number }>(`select * from apply_partial_refund($1,$2,99)`, [id, remains])).rows[0]
      expect(again).toMatchObject({ partial_refund_amount: '1.3500', remains: 250 })
    }
    expect(await balanceOf(db, userId)).toBe(afterFirst)
    expect(await ledgerOf(db, id)).toHaveLength(1)
  }, 60_000)

  it('the ledger idempotency key independently blocks a second credit', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 1000, charge: '5.4000' })
    await db.query(`select * from apply_partial_refund($1,250)`, [id])
    const before = await balanceOf(db, userId)
    // simulate a replay that bypasses the status check: same key, same amount => no second credit
    await db.query(`select process_wallet_transaction($1::uuid,'refund',1.35,$2::uuid,'x','partial_refund:'||$2::text)`, [userId, id])
    expect(await balanceOf(db, userId)).toBe(before)
    await expect(db.query(`select process_wallet_transaction($1::uuid,'refund',9.99,$2::uuid,'x','partial_refund:'||$2::text)`, [userId, id])).rejects.toThrow(/different parameters/)
  }, 60_000)

  it('moves a held `processing` order through `submitted` and refuses invalid input or states', async () => {
    const db = await freshDb()
    const held = await paidOrder(db, { quantity: 100, charge: '1.0000', status: 'processing' })
    await db.query(`select * from apply_partial_refund($1,40)`, [held.id])
    // Both steps are written in ONE transaction, so they share created_at (now()) and their random ids give no order:
    // check the transitions themselves (old -> new), which say the same thing deterministically.
    const steps = (await db.query<{ step: string }>(`select old_status || ' -> ' || new_status as step from order_status_history where order_id=$1 and old_status is not null`, [held.id])).rows.map((r) => r.step)
    expect(steps).toContain('processing -> submitted')
    expect(steps).toContain('submitted -> partial')
    expect(steps).not.toContain('processing -> partial')

    const o = await paidOrder(db, { quantity: 100, charge: '1.0000' })
    await expect(db.query(`select * from apply_partial_refund($1,101)`, [o.id])).rejects.toThrow(/remains must be between/)
    await expect(db.query(`select * from apply_partial_refund($1,-1)`, [o.id])).rejects.toThrow(/remains must be between/)
    await db.query(`update orders set status='completed' where id=$1`, [o.id])
    await expect(db.query(`select * from apply_partial_refund($1,10)`, [o.id])).rejects.toThrow(/cannot become partial/)
    await expect(db.query(`select * from apply_partial_refund(gen_random_uuid(),1)`)).rejects.toThrow(/not found/)
  }, 60_000)

  it('a zero refund (everything delivered) marks partial without a ledger entry', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 1000, charge: '5.4000' })
    const before = await balanceOf(db, userId)
    await db.query(`select * from apply_partial_refund($1,0)`, [id])
    expect(await balanceOf(db, userId)).toBe(before)
    expect(await ledgerOf(db, id)).toEqual([])
  }, 60_000)

  it('is service_role only and bounded by the charge', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 10, charge: '1.0000' })
    await expect(db.query(`update orders set partial_refund_amount = 2 where id=$1`, [id])).rejects.toThrow(/orders_partial_refund_bounds|check/)
    await db.exec(`set role authenticated; select set_config('request.jwt.sub','${userId}',false)`)
    await expect(db.query(`select * from apply_partial_refund('${id}',1)`)).rejects.toThrow(/permission/)
    await db.exec(`reset role`)
  }, 60_000)
})

describe('refund_order after a partial refund (no double payout)', () => {
  it('refunds only the part not yet returned, once', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 1000, charge: '10.0000' })
    await db.query(`select * from apply_partial_refund($1,250)`, [id]) // refunds 2.50
    const afterPartial = Number(await balanceOf(db, userId))

    const r = (await db.query<{ status: string }>(`select * from refund_order($1,null,'support')`, [id])).rows[0]
    expect(r.status).toBe('refunded')
    expect(Number(await balanceOf(db, userId)) - afterPartial).toBeCloseTo(7.5, 4) // NOT 10
    await db.query(`select * from refund_order($1,null,'support again')`, [id]) // idempotent
    expect(Number(await balanceOf(db, userId)) - afterPartial).toBeCloseTo(7.5, 4)

    const total = (await ledgerOf(db, id)).reduce((s, e) => s + Number(e.amount), 0)
    expect(total).toBeCloseTo(10, 4) // partial + remainder == the original charge, never more
  }, 60_000)

  it('rejects a manual amount above what is left', async () => {
    const db = await freshDb()
    const { id } = await paidOrder(db, { quantity: 1000, charge: '10.0000' })
    await db.query(`select * from apply_partial_refund($1,250)`, [id])
    await expect(db.query(`select * from refund_order($1,7.5001)`, [id])).rejects.toThrow(/refund amount must be in/)
  }, 60_000)

  it('closes the order without a payout when the partial refund already returned everything', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 100, charge: '3.0000' })
    await db.query(`select * from apply_partial_refund($1,100)`, [id]) // nothing delivered: 100% back
    const before = await balanceOf(db, userId)
    expect((await db.query<{ status: string }>(`select * from refund_order($1)`, [id])).rows[0].status).toBe('refunded')
    expect(await balanceOf(db, userId)).toBe(before)
    expect(await ledgerOf(db, id)).toHaveLength(1)
  }, 60_000)

  it('a plain cancellation still refunds the full charge', async () => {
    const db = await freshDb()
    const { id, userId } = await paidOrder(db, { quantity: 100, charge: '3.0000' })
    const before = Number(await balanceOf(db, userId))
    await db.query(`update orders set status='canceled' where id=$1`, [id])
    await db.query(`select * from refund_order($1,null,'Provider canceled order')`, [id])
    await db.query(`select * from refund_order($1,null,'Provider canceled order')`, [id])
    expect(Number(await balanceOf(db, userId)) - before).toBeCloseTo(3, 4)
  }, 60_000)
})

describe('state machine: TypeScript mirror equals the database', () => {
  it('agrees on every (from, to) pair', async () => {
    const db = await freshDb()
    for (const from of ALL_ORDER_STATUSES) {
      for (const to of ALL_ORDER_STATUSES) {
        const sql = (await db.query<{ v: boolean }>(`select is_valid_order_transition($1::order_status_enum, $2::order_status_enum) v`, [from, to])).rows[0].v
        expect(isValidOrderTransition(from, to), `${from} -> ${to}`).toBe(sql)
      }
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 4. Worker behaviour (fake ports that mimic the database rules)
// ---------------------------------------------------------------------------

interface FakeOrder extends SyncOrder { user: string; partial_refund_amount: number }

function world(initial: Partial<FakeOrder>[], opts: { failRefundTimes?: number; failUpdateFor?: string } = {}) {
  const orders = new Map<string, FakeOrder>()
  initial.forEach((o, i) => {
    const id = o.id ?? `o${i + 1}`
    orders.set(id, {
      id, user: 'u1', user_id: 'u1', service_id: 's1', provider_order_id: `P${i + 1}`, status: 'in_progress', quantity: 1000, charge_amount: 5.4, remains: null,
      start_count: null, error_message: null, created_at: new Date(NOW - 5 * 60_000).toISOString(), partial_refund_amount: 0, ...o,
    })
  })
  const credits: { orderId: string; amount: number; kind: 'partial' | 'refund' }[] = []
  const calls = { touch: [] as string[], refund: [] as { id: string; comment: string }[], partial: [] as string[], updates: [] as { id: string; patch: OrderFieldsPatch }[] }
  let refundFailures = opts.failRefundTimes ?? 0

  const ports: SyncPorts = {
    async setProviderOrderId(id, pid) { orders.get(id)!.provider_order_id = pid },
    async updateOrder(id, patch, expect) {
      if (opts.failUpdateFor === id) throw new Error('db down')
      const o = orders.get(id)!
      if (!expect.includes(o.status)) return false
      if (patch.status && patch.status !== o.status && !isValidOrderTransition(o.status, patch.status)) {
        throw new Error(`illegal order status transition: ${o.status} -> ${patch.status}`) // what the DB trigger does
      }
      Object.assign(o, patch)
      calls.updates.push({ id, patch })
      return true
    },
    async applyPartialRefund(id, remains) {
      calls.partial.push(id)
      const o = orders.get(id)!
      if (o.status === 'partial') return o.partial_refund_amount // single execution per order
      const refund = calcPartialRefund(o.quantity, remains, o.charge_amount)
      Object.assign(o, { status: 'partial', remains, partial_refund_amount: refund, error_message: null })
      if (refund > 0) credits.push({ orderId: id, amount: refund, kind: 'partial' })
      return refund
    },
    async refundOrder(id, comment) {
      calls.refund.push({ id, comment })
      if (refundFailures > 0) { refundFailures--; throw new Error('refund_order failed') }
      const o = orders.get(id)!
      if (o.status === 'refunded') return
      if (!isValidOrderTransition(o.status, 'refunded')) throw new Error(`illegal order status transition: ${o.status} -> refunded`)
      const remaining = Number((o.charge_amount - o.partial_refund_amount).toFixed(4))
      o.status = 'refunded'
      if (remaining > 0) credits.push({ orderId: id, amount: remaining, kind: 'refund' })
    },
    async touch(id) { calls.touch.push(id) },
  }
  return { orders, ports, credits, calls }
}

const NOW = Date.parse('2026-10-09T12:00:00Z')
const st = (status: IProviderOrderStatus['status'], rest: Partial<IProviderOrderStatus> = {}): BatchStatusEntry => ({
  ok: true, status: { orderId: 'x', rawStatus: status, status, ...rest },
})
const adapterReturning = (map: Record<string, BatchStatusEntry>) => ({ getOrdersStatus: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, map[id]]).filter(([, v]) => v))) })
const quiet = { error: vi.fn(), warn: vi.fn() }
const run = (w: ReturnType<typeof world>, adapter: ReturnType<typeof adapterReturning>, o: { now?: number } = {}) =>
  syncProviderOrders([...w.orders.values()], adapter, w.ports, { now: NOW, ...o }, quiet)

describe('sync worker: completion and progress', () => {
  it('completes orders (remains 0, start_count kept) from every active status, stepping through valid transitions', async () => {
    const w = world([{ status: 'in_progress' }, { status: 'submitted' }, { status: 'processing', provider_order_id: 'P3' }])
    const stats = await run(w, adapterReturning({ P1: st('completed', { startCount: 10, remains: 0 }), P2: st('completed', { remains: 0 }), P3: st('completed', { remains: 0 }) }))
    expect([...w.orders.values()].map((o) => [o.status, o.remains])).toEqual([['completed', 0], ['completed', 0], ['completed', 0]])
    expect(w.orders.get('o1')!.start_count).toBe(10)
    expect(stats).toMatchObject({ completed: 3, errors: [] })
    expect(w.credits).toEqual([]) // completion never moves money
    expect(w.calls.updates.filter((u) => u.id === 'o3').map((u) => u.patch.status)).toEqual(['submitted', 'completed'])
  })

  it('updates progress fields and moves forward only', async () => {
    const w = world([{ status: 'submitted' }, { status: 'in_progress', remains: 500 }, { status: 'in_progress', remains: 300, start_count: 5 }])
    const stats = await run(w, adapterReturning({
      P1: st('in_progress', { remains: 800, startCount: 12 }),
      P2: st('submitted'), // provider says Pending again: must not regress in_progress
      P3: st('in_progress', { remains: 300, startCount: 5 }), // identical: no write
    }))
    expect(w.orders.get('o1')).toMatchObject({ status: 'in_progress', remains: 800, start_count: 12 })
    expect(w.orders.get('o2')).toMatchObject({ status: 'in_progress', remains: 500 })
    expect(stats).toMatchObject({ progressed: 1, unchanged: 2 })
    expect(w.calls.touch).toEqual(['o2', 'o3']) // unchanged orders rotate to the back of the queue
  })
})

describe('sync worker: cancellation -> full refund', () => {
  it('marks canceled, refunds the whole charge once, and clears the note', async () => {
    const w = world([{ status: 'in_progress', charge_amount: 5.4 }])
    const stats = await run(w, adapterReturning({ P1: st('canceled', { remains: 1000 }) }))
    expect(w.orders.get('o1')).toMatchObject({ status: 'refunded', error_message: null })
    expect(w.credits).toEqual([{ orderId: 'o1', amount: 5.4, kind: 'refund' }])
    expect(w.calls.refund).toEqual([{ id: 'o1', comment: 'Provider canceled order' }])
    expect(stats.canceledRefunded).toBe(1)
  })

  it('a second run over the same order does not pay again', async () => {
    const w = world([{ status: 'in_progress' }])
    const adapter = adapterReturning({ P1: st('canceled') })
    await run(w, adapter)
    await run(w, adapter) // order is `refunded` now; even if it were re-fed, refund_order is idempotent
    expect(w.credits).toHaveLength(1)
  })

  it('a failed refund leaves a needs_refund marker and the next run retries it', async () => {
    const w = world([{ status: 'in_progress' }], { failRefundTimes: 1 })
    const adapter = adapterReturning({ P1: st('canceled') })
    const first = await run(w, adapter)
    expect(first.errors).toHaveLength(1)
    expect(w.orders.get('o1')).toMatchObject({ status: 'canceled' })
    expect(w.orders.get('o1')!.error_message).toMatch(new RegExp(`^${NEEDS_REFUND}`))
    expect(w.credits).toEqual([])

    const second = await run(w, adapter) // retry class: no provider call needed
    expect(second.retriedRefunds).toBe(1)
    expect(w.orders.get('o1')).toMatchObject({ status: 'refunded', error_message: null })
    expect(w.credits).toEqual([{ orderId: 'o1', amount: 5.4, kind: 'refund' }])
    expect(adapter.getOrdersStatus).toHaveBeenCalledTimes(1)
  })

  it('treats a provider "Fail" like a cancellation, and retries refunds for failed orders flagged by place-order', async () => {
    const w = world([{ status: 'submitted' }, { status: 'failed', provider_order_id: null, error_message: `${NEEDS_REFUND}: provider_rejected` }])
    await run(w, adapterReturning({ P1: st('failed') }))
    expect(w.orders.get('o1')!.status).toBe('refunded')
    expect(w.orders.get('o2')!.status).toBe('refunded')
    expect(w.calls.refund.map((r) => r.comment)).toEqual(['Automatic refund retry', 'Provider failed order'])
    expect(w.credits).toHaveLength(2)
  })

  it('does NOT refund when the order changed under us (conflict)', async () => {
    const w = world([{ status: 'in_progress' }])
    const adapter = adapterReturning({ P1: st('canceled') })
    const original = w.ports.updateOrder
    w.ports.updateOrder = async (id, patch, expect) => { w.orders.get(id)!.status = 'completed'; return original(id, patch, expect) }
    const stats = await run(w, adapter)
    expect(stats.conflicts).toBe(1)
    expect(w.calls.refund).toEqual([])
    expect(w.credits).toEqual([])
  })
})

describe('sync worker: partial completion -> exact partial refund', () => {
  it('refunds round(remains / quantity * charge, 4) and sets status partial', async () => {
    const w = world([{ quantity: 1000, charge_amount: 5.4 }, { quantity: 3, charge_amount: 1 }])
    const stats = await run(w, adapterReturning({ P1: st('partial', { remains: 250, startCount: 3 }), P2: st('partial', { remains: 1 }) }))
    expect(w.credits).toEqual([
      { orderId: 'o1', amount: 1.35, kind: 'partial' },
      { orderId: 'o2', amount: 0.3333, kind: 'partial' },
    ])
    expect([...w.orders.values()].map((o) => [o.status, o.remains, o.partial_refund_amount])).toEqual([['partial', 250, 1.35], ['partial', 1, 0.3333]])
    expect(stats).toMatchObject({ partial: 2, partialRefundedUnits: 16_833 })
  })

  it('is idempotent when the provider keeps reporting Partial for an already-settled order', async () => {
    const w = world([{ quantity: 1000, charge_amount: 5.4 }])
    const adapter = adapterReturning({ P1: st('partial', { remains: 250 }) })
    await run(w, adapter)
    await run(w, adapter) // re-fed on purpose
    await run(w, adapter)
    expect(w.credits).toHaveLength(1)
    expect(w.orders.get('o1')!.partial_refund_amount).toBe(1.35)
  })

  it('never refunds on an unusable remains value', async () => {
    const w = world([{ quantity: 100 }, { quantity: 100 }, { quantity: 100 }])
    const stats = await run(w, adapterReturning({ P1: st('partial'), P2: st('partial', { remains: 101 }), P3: st('partial', { remains: -1 }) }))
    expect(w.credits).toEqual([])
    expect(w.calls.partial).toEqual([])
    expect(stats.errors).toHaveLength(3)
    expect([...w.orders.values()].every((o) => o.status === 'in_progress')).toBe(true) // untouched, retried next run
  })

  it('a partial order refunded later by support only pays the remainder', async () => {
    const w = world([{ quantity: 1000, charge_amount: 10 }])
    await run(w, adapterReturning({ P1: st('partial', { remains: 250 }) }))
    await w.ports.refundOrder('o1', 'support')
    await w.ports.refundOrder('o1', 'support')
    expect(w.credits.reduce((s, c) => s + c.amount, 0)).toBeCloseTo(10, 4)
  })
})

describe('sync worker: reconciliation of orders held in processing', () => {
  const HELD = `needs_reconciliation: timeout: add: no response within 10000ms`

  it('leaves a young held order alone (it may still be in flight)', async () => {
    const w = world([{ status: 'processing', provider_order_id: null, error_message: HELD, created_at: new Date(NOW - 10 * 60_000).toISOString() }])
    const adapter = adapterReturning({})
    const stats = await run(w, adapter)
    expect(w.orders.get('o1')!.status).toBe('processing')
    expect(w.calls.refund).toEqual([])
    expect(adapter.getOrdersStatus).not.toHaveBeenCalled()
    expect(stats.unchanged).toBe(1)
  })

  it('never auto-refunds a held order, however old: it waits in the Reconciliation Center (Phase 2)', async () => {
    const w = world([{ status: 'processing', provider_order_id: null, error_message: HELD, created_at: new Date(NOW - 61 * 60_000).toISOString() }])
    const stats = await run(w, adapterReturning({}))
    expect(w.orders.get('o1')).toMatchObject({ status: 'processing', error_message: HELD })
    expect(w.credits).toEqual([])
    expect(w.calls.refund).toEqual([])
    expect(w.calls.updates).toEqual([])
    expect(stats).toMatchObject({ heldForReconciliation: 1, unchanged: 1 })
  })

  it('even days later nothing is refunded or changed by the worker (no hidden time window any more)', async () => {
    const w = world([{ status: 'processing', provider_order_id: null, error_message: HELD, created_at: new Date(NOW - 3 * 24 * 3600_000).toISOString() }])
    await run(w, adapterReturning({}))
    expect(w.orders.get('o1')!.status).toBe('processing')
    expect(w.credits).toEqual([])
  })

  it('recovers the provider order id from the note and follows the provider instead of refunding', async () => {
    const w = world([{
      status: 'processing', provider_order_id: null, created_at: new Date(NOW - 3 * 3600_000).toISOString(), // old enough to be refunded...
      error_message: 'needs_reconciliation: provider accepted as 777 but database update failed',
    }])
    const stats = await run(w, adapterReturning({ '777': st('in_progress', { remains: 400, startCount: 2 }) }))
    expect(w.orders.get('o1')).toMatchObject({ provider_order_id: '777', status: 'in_progress', remains: 400 }) // ...but the provider has it
    expect(w.credits).toEqual([])
    expect(stats).toMatchObject({ idsRecovered: 1, progressed: 1 })
  })

  it('a recovered order that the provider already completed ends completed (through submitted)', async () => {
    const w = world([{ status: 'processing', provider_order_id: null, error_message: 'needs_reconciliation: provider accepted as 55 but database update failed' }])
    await run(w, adapterReturning({ '55': st('completed', { remains: 0 }) }))
    expect(w.orders.get('o1')!.status).toBe('completed')
    expect(w.calls.updates.map((u) => u.patch.status)).toEqual(['submitted', 'completed'])
  })
})

describe('sync worker: safety', () => {
  it('"order not found" at the provider never refunds', async () => {
    const w = world([{ status: 'in_progress' }])
    const adapter = { getOrdersStatus: vi.fn(async () => ({ P1: { ok: false as const, error: 'Incorrect order ID', code: 'order_not_found' } })) }
    const stats = await run(w, adapter)
    expect(stats.providerLost).toBe(1)
    expect(w.calls.refund).toEqual([])
    expect(w.orders.get('o1')!.status).toBe('in_progress')
    expect(w.calls.touch).toEqual(['o1'])
  })

  it('a failed provider query changes nothing and refunds nothing', async () => {
    const w = world([{ status: 'in_progress' }, { status: 'submitted' }])
    const adapter = { getOrdersStatus: vi.fn(async () => { throw new SMMProviderError('timeout', 'status: no response', { retryable: true }) }) }
    const stats = await run(w, adapter)
    expect(stats.errors).toHaveLength(2)
    expect(w.calls.refund).toEqual([])
    expect(w.credits).toEqual([])
    expect([...w.orders.values()].map((o) => o.status)).toEqual(['in_progress', 'submitted'])
    expect(w.calls.touch).toEqual(['o1', 'o2'])
  })

  it('one failing order does not stop the others', async () => {
    const w = world([{ status: 'in_progress' }, { status: 'in_progress' }], { failUpdateFor: 'o1' })
    const stats = await run(w, adapterReturning({ P1: st('completed'), P2: st('completed') }))
    expect(stats.errors).toEqual([{ orderId: 'o1', message: 'db down' }])
    expect(w.orders.get('o2')!.status).toBe('completed')
  })

  it('queries the provider in chunks of at most 50 ids', async () => {
    const w = world(Array.from({ length: 120 }, () => ({ status: 'in_progress' as const })))
    const adapter = adapterReturning({})
    await run(w, adapter)
    expect(adapter.getOrdersStatus.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20])
  })

  it('starts from empty statistics', () => {
    expect(emptySyncStats()).toMatchObject({ checked: 0, errors: [] })
  })
})

// ---------------------------------------------------------------------------
// 5. Dev mode: simulated provider progress and refunds
// ---------------------------------------------------------------------------

describe('mock backend: simulated order progress', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
  const members = MOCK_CATALOG.services.find((s) => s.name.includes('Channel Members'))! // $5.40 / 1000
  const DELAYS = { submittedMs: 1_000, completedMs: 5_000 }
  const place = (b: ReturnType<typeof createMockBackend>, url = 'https://t.me/x', key = 'key-00001') =>
    b.createOrder({ serviceId: members.id, targetUrl: url, quantity: 1000, idempotencyKey: key }).order

  it('advances submitted -> in_progress -> completed after the configured delays', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t, DELAYS)
    place(b)
    const status = () => b.listOrders()[0]
    expect(status()).toMatchObject({ status: 'submitted', remains: 1000, refundedAmount: 0 })
    t += 999
    expect(status().status).toBe('submitted')
    t += 1_001 // 2000ms in: halfway through the in-progress window? (1000..5000) -> 25%
    expect(status()).toMatchObject({ status: 'in_progress', remains: 750 })
    t += 3_000 // 5000ms
    expect(status()).toMatchObject({ status: 'completed', remains: 0, refundedAmount: 0 })
    expect(b.getWallet().balance).toBe(19.1) // no refund for a normal completion
  })

  it('#mock-partial ends partial and credits the exact partial refund once', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t, DELAYS)
    place(b, 'https://t.me/x#mock-partial')
    expect(mockScenario('https://t.me/x#mock-partial')).toBe('partial')
    expect(b.getWallet().balance).toBe(19.1)

    t += 5_000
    const [o] = b.listOrders()
    const remains = Math.ceil(1000 * MOCK_PARTIAL_REMAINS_RATIO)
    expect(o).toMatchObject({ status: 'partial', remains, refundedAmount: calcPartialRefund(1000, remains, 5.4) })
    expect(o.refundedAmount).toBe(1.62)
    expect(b.getWallet().balance).toBe(20.72) // 24.50 - 5.40 + 1.62

    for (let i = 0; i < 5; i++) b.listOrders() // repeated polling must not credit again
    t += 60_000
    expect(b.getWallet().balance).toBe(20.72)

    const refunds = b.listLedger().filter((e) => e.type === 'refund')
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ amount: 1.62, status: 'completed', description: expect.stringContaining('Partial refund for order #') })
  })

  it('#mock-cancel ends refunded with the full charge returned once', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t, DELAYS)
    place(b, 'https://t.me/x#mock-cancel')
    t += 10_000
    expect(b.listOrders()[0]).toMatchObject({ status: 'refunded', refundedAmount: 5.4 })
    b.listOrders()
    expect(b.getWallet().balance).toBe(24.5)
    expect(b.listLedger().filter((e) => e.type === 'refund').map((e) => e.amount)).toEqual([5.4])
  })

  it('settles refunds even if nobody looked at the orders until much later, and persists', () => {
    const store = memory()
    let t = 1_700_000_000_000
    const first = createMockBackend(store, () => t, DELAYS)
    place(first, 'https://t.me/x#mock-partial')
    t += 3_600_000
    const reopened = createMockBackend(store, () => t, DELAYS) // new session
    expect(reopened.getWallet().balance).toBe(20.72)
    expect(createMockBackend(store, () => t, DELAYS).getWallet().balance).toBe(20.72)
  })

  it('defaults to short, human-friendly delays', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t) // default delays
    place(b)
    t += 25_000
    expect(b.listOrders()[0].status).toBe('completed')
  })
})
