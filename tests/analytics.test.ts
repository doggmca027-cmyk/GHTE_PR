import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyticsFromRpc, computeProfitAnalytics, parseAnalyticsRange, type DateRange } from '../supabase/functions/_shared/admin-analytics.ts'
import type { MetricOrder } from '../supabase/functions/_shared/admin-metrics.ts'
import type { OrderStatus } from '../supabase/functions/_shared/types.ts'
import { analyticsRequest } from '../src/lib/admin-view'
import { createMockAdmin } from '../src/services/api/mock-admin'

// ---------------------------------------------------------------------------
// Request parsing (pure)
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const DAY = 86_400_000

describe('parseAnalyticsRange', () => {
  it('defaults to the last 30 days up to now', () => {
    for (const body of [undefined, null, {}]) {
      expect(parseAnalyticsRange(body, NOW)).toEqual({ start: new Date(NOW - 30 * DAY).toISOString(), end: new Date(NOW).toISOString() })
    }
  })
  it('accepts explicit dates; a lone endDate keeps the 30-day default span', () => {
    expect(parseAnalyticsRange({ startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-10T00:00:00Z' }, NOW)).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-10T00:00:00.000Z' })
    expect(parseAnalyticsRange({ endDate: '2026-10-10T00:00:00Z' }, NOW)).toEqual({ start: new Date(Date.parse('2026-10-10T00:00:00Z') - 30 * DAY).toISOString(), end: '2026-10-10T00:00:00.000Z' })
  })
  it('an explicit null is unbounded (All Time)', () => {
    expect(parseAnalyticsRange({ startDate: null, endDate: null }, NOW)).toEqual({ start: null, end: null })
    expect(parseAnalyticsRange({ startDate: null }, NOW)).toEqual({ start: null, end: new Date(NOW).toISOString() })
  })
  it.each([
    [{ startDate: 'yesterday' }], [{ startDate: 5 }], [{ endDate: '' }], [{ startDate: '2026-13-45' }], [[]], ['x'],
    [{ startDate: '2026-10-10T00:00:00Z', endDate: '2026-10-10T00:00:00Z' }],
    [{ startDate: '2026-10-11T00:00:00Z', endDate: '2026-10-10T00:00:00Z' }],
    [{ startDate: '2099-01-01T00:00:00Z' }], // default end = now, which is before this start
  ])('rejects %j', (body) => {
    expect(parseAnalyticsRange(body, NOW)).toHaveProperty('error')
  })
})

describe('analyticsRequest (UI presets)', () => {
  const now = new Date(2026, 9, 20, 15, 30)
  it('builds the request bodies', () => {
    expect(analyticsRequest('all', now)).toEqual({ startDate: null, endDate: null })
    expect(analyticsRequest('today', now)).toEqual({ startDate: new Date(2026, 9, 20).toISOString() })
    expect(analyticsRequest('7d', now)).toEqual({ startDate: new Date(now.getTime() - 7 * DAY).toISOString() })
    expect(analyticsRequest('30d', now)).toEqual({ startDate: new Date(now.getTime() - 30 * DAY).toISOString() })
  })
})

// ---------------------------------------------------------------------------
// The shared fixture: the same orders go into PostgreSQL and into the TypeScript twin
// ---------------------------------------------------------------------------

interface Spec extends MetricOrder { key: string; profit_amount?: number }
const T = (iso: string) => iso // readability

const START = '2026-10-10T00:00:00.000Z'
const END = '2026-10-20T00:00:00.000Z'

const order = (key: string, status: OrderStatus, charge: number, cost: number, quantity: number, created_at: string, extra: Partial<Spec> = {}): Spec => ({
  key, status, charge_amount: charge, cost_amount: cost, quantity, remains: null, partial_refund_amount: 0, error_message: null, created_at, ...extra,
})

const ORDERS: Spec[] = [
  // delivered, in the period
  order('A', 'completed', 10, 4, 1000, T('2026-10-12T10:00:00Z')),
  order('B', 'completed', 5.5, 2.2501, 500, T('2026-10-13T10:00:00Z')),
  // partial: 4000 of 5000 delivered -> revenue 30 - 6 = 24, cost 10 * 4000/5000 = 8
  order('C', 'partial', 30, 10, 5000, T('2026-10-14T10:00:00Z'), { remains: 1000, partial_refund_amount: 6 }),
  // partial with rounding: 2 of 3 delivered -> revenue 10 - 3.3333 = 6.6667, cost round(3.3333 * 2/3, 4) = 2.2222
  order('D', 'partial', 10, 3.3333, 3, T('2026-10-15T10:00:00Z'), { remains: 1, partial_refund_amount: 3.3333 }),
  // placed in the period but earn and cost nothing
  order('E', 'refunded', 8, 2.7, 1500, T('2026-10-16T10:00:00Z')),
  order('F', 'canceled', 4, 1.3, 800, T('2026-10-16T11:00:00Z')),
  order('G', 'in_progress', 14.4, 4.8, 2700, T('2026-10-17T10:00:00Z'), { remains: 1200 }),
  order('H', 'draft', 99, 50, 100, T('2026-10-17T11:00:00Z')),
  order('X', 'failed', 3, 1, 100, T('2026-10-18T11:00:00Z')),
  // outside the period (before / after) and exactly on the boundaries
  order('OLD', 'completed', 1000, 100, 10_000, T('2026-10-09T23:59:59Z')),
  order('NEW', 'completed', 1000, 100, 10_000, T('2026-10-21T00:00:00Z')),
  order('AT_START', 'completed', 2, 1, 100, START),
  order('AT_END', 'completed', 500, 50, 1000, END),
]
const FEES = [
  { amount: -1.5, created_at: T('2026-10-12T00:00:00Z') },
  { amount: -0.25, created_at: T('2026-10-18T00:00:00Z') },
  { amount: -9, created_at: T('2026-10-01T00:00:00Z') }, // outside
]
const RANGE: DateRange = { start: START, end: END }

// Hand-computed for the period [START, END): A + B + C + D + AT_START
const EXPECTED = {
  totalOrders: 9, // A B C D E F G X AT_START (draft H excluded; OLD, NEW and AT_END are outside)
  completedOrders: 3,
  partialOrders: 2,
  grossRevenue: 10 + 5.5 + 24 + 6.6667 + 2, // 48.1667
  providerCost: 4 + 2.2501 + 8 + 2.2222 + 1, // 17.4723
  treasuryFees: 1.75,
}

describe('computeProfitAnalytics (TypeScript twin)', () => {
  it('matches the hand-computed numbers', () => {
    const r = computeProfitAnalytics(ORDERS, FEES, RANGE)
    expect(r).toMatchObject({ completedOrders: 3, partialOrders: 2, treasuryFees: 1.75 })
    expect(r.grossRevenue).toBeCloseTo(EXPECTED.grossRevenue, 4)
    expect(r.providerCost).toBeCloseTo(EXPECTED.providerCost, 4)
    expect(r.grossProfit).toBeCloseTo(EXPECTED.grossRevenue - EXPECTED.providerCost, 4)
    expect(r.netProfit).toBeCloseTo(EXPECTED.grossRevenue - EXPECTED.providerCost - EXPECTED.treasuryFees, 4)
  })
})

// ---------------------------------------------------------------------------
// get_profit_analytics (real SQL on PGlite)
// ---------------------------------------------------------------------------

describe('get_profit_analytics (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  const asUser = (id: string) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${id}',false)`)
  const run = async (start: string | null, end: string | null) => {
    await asUser(admin)
    const r = (await db.query<{ r: Record<string, unknown> }>(`select get_profit_analytics($1::timestamptz, $2::timestamptz) r`, [start, end])).rows[0].r
    await db.exec('reset role')
    return r
  }
  const num = (r: Record<string, unknown>, k: string) => Number(r[k])

  const CHAIN: Record<string, OrderStatus[]> = {
    draft: [],
    canceled: ['canceled'],
    failed: ['awaiting_payment', 'paid', 'failed'],
    refunded: ['awaiting_payment', 'paid', 'refunded'],
    in_progress: ['awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress'],
    completed: ['awaiting_payment', 'paid', 'processing', 'submitted', 'completed'],
    partial: ['awaiting_payment', 'paid', 'processing', 'submitted', 'partial'],
  }

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    banned = await q(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`)
    await db.exec(`
      insert into providers(name, api_url) values ('p', 'https://x');
      insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'v');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        select id, '1', 's', 1, 1, 1000000 from providers;
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id, 'Views', ps.id, 1, 1, 1000000 from categories c, provider_services ps;`)

    for (const o of ORDERS) {
      const { id } = (await db.query<{ id: string }>(
        `insert into orders(user_id, service_id, target_url, quantity, charge_amount, cost_amount, profit_amount, provider_id)
         select $1, s.id, 'https://t.me/x', $2, $3, $4, $3::numeric - $4::numeric, ps.provider_id from services s join provider_services ps on ps.id = s.primary_provider_service_id returning id`,
        [user, o.quantity, o.charge_amount, o.cost_amount])).rows[0]
      for (const s of CHAIN[o.status]) await db.query(`update orders set status = $2 where id = $1`, [id, s])
      await db.query(`update orders set remains = $2, partial_refund_amount = $3, created_at = $4 where id = $1`, [id, o.remains, o.partial_refund_amount, o.created_at])
    }

    await db.exec(`select process_treasury_transaction('deposit', 1000)`)
    for (const [i, f] of FEES.entries()) await db.query(`select process_treasury_transaction('fee', $1, 'fee', $2)`, [f.amount, `fee-${i}`])
    // a non-fee debit in the period must not count as a fee
    await db.exec(`select process_treasury_transaction('provider_topup', -40, 'topup', 'topup-1')`)
    // back-date the ledger rows (the ledger is append-only, so lift the guard for this fixture only)
    await db.exec(`alter table treasury_transactions disable trigger trg_treasury_tx_no_update`)
    for (const [i, f] of FEES.entries()) await db.query(`update treasury_transactions set created_at = $2 where reference_id = $1`, [`fee-${i}`, f.created_at])
    await db.exec(`update treasury_transactions set created_at = '2026-10-15T00:00:00Z' where type in ('deposit', 'provider_topup')`)
    await db.exec(`alter table treasury_transactions enable trigger trg_treasury_tx_no_update`)
  }, 180_000)

  it('computes realised revenue, cost, profit, fees and net profit exactly', async () => {
    const r = await run(START, END)
    expect(num(r, 'total_orders')).toBe(EXPECTED.totalOrders)
    expect(num(r, 'completed_orders')).toBe(EXPECTED.completedOrders)
    expect(num(r, 'partial_orders')).toBe(EXPECTED.partialOrders)
    expect(num(r, 'gross_revenue')).toBe(48.1667)
    expect(num(r, 'provider_cost')).toBe(17.4723)
    expect(num(r, 'gross_profit')).toBe(30.6944)
    expect(num(r, 'treasury_fees')).toBe(1.75)
    expect(num(r, 'net_profit')).toBe(28.9444)
    expect(num(r, 'margin_pct')).toBe(63.73)
  })

  it('handles partial orders by delivered share and keeps the refund out of revenue', async () => {
    // only C and D in range
    const r = await run('2026-10-14T00:00:00Z', '2026-10-16T00:00:00Z')
    expect(num(r, 'gross_revenue')).toBe(24 + 6.6667) // charge - refund, never the full charge
    expect(num(r, 'provider_cost')).toBe(8 + 2.2222) // cost prorated by delivered quantity (4000/5000, 2/3)
    expect(num(r, 'completed_profit_snapshot')).toBe(0) // partial orders are not in the completed snapshot
  })

  it('completed-order profit equals the profit snapshots taken at order time', async () => {
    const r = await run('2026-10-12T00:00:00Z', '2026-10-14T00:00:00Z') // A and B: completed only
    expect(num(r, 'gross_profit')).toBe(num(r, 'completed_profit_snapshot'))
    expect(num(r, 'gross_profit')).toBe(10 - 4 + (5.5 - 2.2501))
  })

  it('matches the TypeScript twin on the same data, across several periods', async () => {
    const ranges: DateRange[] = [RANGE, { start: null, end: null }, { start: START, end: null }, { start: null, end: END }, { start: '2026-10-14T00:00:00Z', end: '2026-10-16T00:00:00Z' }, { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }]
    for (const range of ranges) {
      const sql = analyticsFromRpc(await run(range.start, range.end))
      const ts = computeProfitAnalytics(ORDERS, FEES, range)
      expect({ ...sql, periodStart: null, periodEnd: null }).toEqual({ ...ts, periodStart: null, periodEnd: null })
    }
  })

  it('treats the period as [start, end): an order exactly at start counts, exactly at end does not', async () => {
    const r = await run(START, END)
    const at = await run(START, '2026-10-10T00:00:01Z')
    expect(num(at, 'gross_revenue')).toBe(2) // AT_START only
    const end = await run(END, '2026-10-20T00:00:01Z')
    expect(num(end, 'gross_revenue')).toBe(500) // AT_END is inside [END, END+1s)
    expect(num(r, 'gross_revenue')).toBe(48.1667) // ...and was not in [START, END)
  })

  it('open bounds: All Time includes everything, a NULL start or end is unbounded on that side', async () => {
    const all = await run(null, null)
    expect(num(all, 'gross_revenue')).toBeCloseTo(48.1667 + 1000 + 1000 + 500, 4)
    expect(num(all, 'treasury_fees')).toBe(10.75) // 9 outside the period counts for all time
    const before = await run(null, START)
    expect(num(before, 'gross_revenue')).toBe(1000)
    expect(num(before, 'treasury_fees')).toBe(9)
  })

  it('only counts fees: top-ups and deposits are not operational costs', async () => {
    const r = await run('2026-10-15T00:00:00Z', '2026-10-15T00:00:01Z') // contains the deposit and the top-up, no fee
    expect(num(r, 'treasury_fees')).toBe(0)
  })

  it('an empty period is all zeros with no margin', async () => {
    const r = await run('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
    expect(r).toMatchObject({ total_orders: 0, gross_revenue: 0, provider_cost: 0, gross_profit: 0, treasury_fees: 0, net_profit: 0, margin_pct: null })
  })

  it('net profit goes negative when fees exceed gross profit', async () => {
    // only the 1.5 fee (Oct 12) and order A (profit 6) would be positive, so use a window with fees but no delivered orders
    const r = await run('2026-10-18T00:00:00Z', '2026-10-19T00:00:00Z') // fee 0.25 + order X (failed): no revenue
    expect(num(r, 'gross_profit')).toBe(0)
    expect(num(r, 'net_profit')).toBe(-0.25)
  })

  it('rejects an inverted or empty period', async () => {
    await asUser(admin)
    await expect(db.query(`select get_profit_analytics('2026-10-20T00:00:00Z', '2026-10-10T00:00:00Z')`)).rejects.toThrow(/end date must be after/)
    await expect(db.query(`select get_profit_analytics('2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z')`)).rejects.toThrow(/end date must be after/)
    await db.exec('reset role')
  })

  it('is admin-only: users, banned admins, signed-out callers and anon are refused', async () => {
    for (const id of [user, banned, '']) {
      await asUser(id)
      await expect(db.query(`select get_profit_analytics(null, null)`)).rejects.toThrow(/forbidden/)
    }
    await db.exec(`reset role; set role anon`)
    await expect(db.query(`select get_profit_analytics(null, null)`)).rejects.toThrow()
    await db.exec('reset role')
  })

  it('uses an index on orders.created_at for a narrow period', async () => {
    const idx = (await db.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'orders' and indexdef like '%(created_at)%'`)).rows
    expect(idx.map((i) => i.indexname)).toContain('idx_orders_created_at')
  })
})

describe('mock analytics (dev mode)', () => {
  const storage = { getItem: () => null, setItem() {} }
  it('uses the same engine and respects the period', () => {
    const now = Date.now()
    const m = createMockAdmin(storage, () => now)
    const all = m.getAnalytics({ start: null, end: null })
    const none = m.getAnalytics({ start: new Date(now + DAY).toISOString(), end: new Date(now + 2 * DAY).toISOString() })
    expect(all.grossRevenue).toBeGreaterThan(0)
    expect(all.netProfit).toBeCloseTo(all.grossProfit - all.treasuryFees, 4)
    expect(none).toMatchObject({ totalOrders: 0, grossRevenue: 0, netProfit: 0, marginPct: null })
  })
})
