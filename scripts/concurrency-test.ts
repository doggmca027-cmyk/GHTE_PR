// Real-PostgreSQL concurrency test for the money paths (PGlite runs on ONE connection and cannot prove locking).
//
//   npm run test:concurrency
//       Starts a throwaway, real PostgreSQL server (embedded-postgres, no Docker needed), applies every migration and
//       fires the races below through a pool of separate connections. The server is deleted afterwards.
//
//   Scenarios: A wallet race, B provider balance reservation race, C idempotency race,
//              D provider payment daily limit race, E treasury minimum reserve race,
//              F reconciliation detector race (pg_cron and admins running sync_reconciliation_cases at once),
//              G worker heartbeat race (overlapping worker runs reporting at once; no run may be lost),
//              H double Partial, I Canceled + Partial race, J Partial + full refund race, K refund_order storm
//                (the order-status refund paths: never more than the charge back, never twice, always a safe final state),
//              L affiliate withdrawal storm, M many small withdrawals, N same-key retries, O withdrawal against a clawback
//                (transfer_affiliate_balance_to_wallet: the referral balance can never be spent twice),
//              P promo max_uses race, Q stacked discounts under load, R a price drop racing the orders that were priced from it
//                (the discount engine: a code is never over-redeemed and no order is ever sold under its cost).
//
//   CONCURRENCY_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:concurrency
//       Runs against a LOCAL Supabase instead (`npx supabase start`; migrations are applied there by the CLI).
//       Only localhost is accepted: this script writes test users, providers and orders.
//
// Every request runs in its own transaction on its own connection: BEGIN; place_order(...); pg_sleep(HOLD); COMMIT.
// The sleep keeps each transaction's row locks held for a while, so the requests really queue on the wallet and
// provider rows instead of finishing one by one. A sampler counts sessions waiting on a lock to prove they did.

import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrate, openDatabase } from './lib/real-postgres.ts'

const HOLD_MS = Number(process.env.CONCURRENCY_HOLD_MS ?? 15)

// ---------------------------------------------------------------------------
// Fixtures: one provider + provider service + service + offer per scenario
// ---------------------------------------------------------------------------

interface Scenario {
  service: string
  offer: string
  provider: string
  providerService: string
}

async function seedScenario(admin: pg.Client, tag: string, o: { customerRate: number; costRate: number; providerBalance: number | null }): Promise<Scenario> {
  const provider = randomUUID(), providerService = randomUUID(), service = randomUUID(), category = randomUUID()
  await admin.query(`insert into providers(id, name, api_url, routing_enabled, health_status) values ($1, $2, 'https://race.invalid', true, 'healthy')`, [provider, `race-${tag}-${provider.slice(0, 8)}`])
  if (o.providerBalance !== null) {
    await admin.query(`update providers set provider_balance = $2, last_balance_sync = now() where id = $1`, [provider, o.providerBalance])
  }
  await admin.query(`insert into categories(id, platform_id, name, slug) select $1, id, $2, $2 from platforms where slug = 'telegram'`, [category, `race-${tag}-${category.slice(0, 8)}`])
  await admin.query(`insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, '1', 'race', $3, 1, 1000000)`, [providerService, provider, o.costRate])
  await admin.query(`insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, $2, 'race', $3, $4, 1, 1000000)`, [service, category, providerService, o.customerRate])
  const offer = (await admin.query<{ id: string }>(`select id from provider_service_offers where service_id = $1`, [service])).rows[0].id
  return { service, offer, provider, providerService }
}

async function seedUser(admin: pg.Client, funds: number) {
  const id = (await admin.query<{ id: string }>(`insert into users(telegram_id) values ($1) returning id`, [Math.floor(Math.random() * 9e12) + 1e12])).rows[0].id
  await admin.query(`select process_wallet_transaction($1::uuid, 'deposit', $2::numeric, null, 'race funding', 'race-fund-' || $1::text)`, [id, funds])
  return id
}

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

interface Attempt {
  user: string
  key: string
}
interface RaceResult {
  ok: { orderId: string }[]
  errors: Map<string, number>
  ms: number
  peakLockWaiters: number
  peakActive: number
}

const classify = (message: string) =>
  /insufficient_funds/.test(message) ? 'insufficient_funds'
    : /insufficient_provider_balance/.test(message) ? 'insufficient_provider_balance'
      : /deadlock/.test(message) ? 'DEADLOCK'
        : `other: ${message.slice(0, 80)}`

async function race(pool: pg.Pool, sampler: pg.Client, s: Scenario, attempts: Attempt[], quantity: number, costAmount: number): Promise<RaceResult> {
  // Open every connection BEFORE the start, so all requests leave at the same moment.
  const clients = await Promise.all(attempts.map(() => pool.connect()))
  let sampling = true
  let peakLockWaiters = 0
  let peakActive = 0
  const sample = (async () => {
    while (sampling) {
      const r = await sampler.query<{ waiting: number; active: number }>(
        `select count(*) filter (where wait_event_type = 'Lock')::int waiting, count(*) filter (where state = 'active')::int active
           from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`)
      peakLockWaiters = Math.max(peakLockWaiters, r.rows[0].waiting)
      peakActive = Math.max(peakActive, r.rows[0].active)
    }
  })()

  const started = Date.now()
  const settled = await Promise.allSettled(
    attempts.map(async (a, i) => {
      const c = clients[i]
      try {
        await c.query('begin')
        const r = await c.query<{ id: string }>(
          `select id from place_order($1::uuid, $2::uuid, 'https://t.me/race', $3::int, $4::uuid, $5::uuid, $6::uuid, $7::numeric, $8::text)`,
          [a.user, s.service, quantity, s.offer, s.provider, s.providerService, costAmount, a.key])
        await c.query('select pg_sleep($1)', [HOLD_MS / 1000]) // hold the locks: make the others queue
        await c.query('commit')
        return { orderId: r.rows[0].id }
      } catch (e) {
        await c.query('rollback').catch(() => {})
        throw e
      }
    }),
  )
  const ms = Date.now() - started
  sampling = false
  await sample
  clients.forEach((c) => c.release())

  const errors = new Map<string, number>()
  const ok: { orderId: string }[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') ok.push(r.value)
    else {
      const k = classify(r.reason instanceof Error ? r.reason.message : String(r.reason))
      errors.set(k, (errors.get(k) ?? 0) + 1)
    }
  }
  return { ok, errors, ms, peakLockWaiters, peakActive }
}

/** Provider payments: fires validate_provider_payment for every id at once (own connection, locks held HOLD_MS). */
async function raceValidations(pool: pg.Pool, sampler: pg.Client, paymentIds: string[]): Promise<RaceResult> {
  const clients = await Promise.all(paymentIds.map(() => pool.connect()))
  let sampling = true
  let peakLockWaiters = 0
  let peakActive = 0
  const sample = (async () => {
    while (sampling) {
      const r = await sampler.query<{ waiting: number; active: number }>(
        `select count(*) filter (where wait_event_type = 'Lock')::int waiting, count(*) filter (where state = 'active')::int active
           from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`)
      peakLockWaiters = Math.max(peakLockWaiters, r.rows[0].waiting)
      peakActive = Math.max(peakActive, r.rows[0].active)
    }
  })()
  const started = Date.now()
  const settled = await Promise.allSettled(paymentIds.map(async (id, i) => {
    const c = clients[i]
    try {
      await c.query('begin')
      await c.query('select validate_provider_payment($1::uuid)', [id])
      await c.query('select pg_sleep($1)', [HOLD_MS / 1000])
      await c.query('commit')
      return { orderId: id }
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    }
  }))
  const ms = Date.now() - started
  sampling = false
  await sample
  clients.forEach((c) => c.release())
  const errors = new Map<string, number>()
  const ok: { orderId: string }[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') ok.push(r.value)
    else {
      const m = r.reason instanceof Error ? r.reason.message : String(r.reason)
      const k = /max_daily_topup_exceeded|treasury_reserve_breached|max_topup_per_tx_exceeded|insufficient_treasury_funds|deadlock/.exec(m)?.[0] ?? `other: ${m.slice(0, 80)}`
      errors.set(k, (errors.get(k) ?? 0) + 1)
    }
  }
  return { ok, errors, ms, peakLockWaiters, peakActive }
}

async function seedPayoutProvider(admin: pg.Client, maxPerTx: number, maxDaily: number) {
  const id = randomUUID()
  await admin.query(
    `insert into providers(id, name, api_url, allowed_destination_wallet, max_topup_per_tx, max_daily_topup) values ($1, $2, 'https://race.invalid', $3, $4, $5)`,
    [id, `race-pay-${id.slice(0, 8)}`, `0:${'ab'.repeat(32)}`, maxPerTx, maxDaily])
  return id
}
async function approvedPayment(admin: pg.Client, provider: string, amount: number) {
  const id = (await admin.query<{ id: string }>(
    `insert into provider_payments(provider_id, amount, asset, network, destination_wallet, status, idempotency_key)
     select id, $2, payout_asset, payout_network, allowed_destination_wallet, 'PROPOSED', 'race:' || gen_random_uuid() from providers where id = $1 returning id`,
    [provider, amount])).rows[0].id
  await admin.query(`update provider_payments set status = 'APPROVED' where id = $1`, [id])
  return id
}
/** A payment walked through the real engine to `to`; its clock is then set back so the detector sees it as stuck. */
async function stuckPayment(admin: pg.Client, provider: string, to: 'BROADCASTED' | 'CONFIRMED') {
  const id = await approvedPayment(admin, provider, 10)
  await admin.query('select validate_provider_payment($1::uuid)', [id])
  await admin.query('select create_provider_payment_instruction($1::uuid)', [id])
  await admin.query('select record_provider_payment_broadcast($1::uuid, $2)', [id, `race-tx-${id}`])
  if (to === 'CONFIRMED') {
    await admin.query(`select advance_provider_payment($1::uuid, 'CONFIRMING')`, [id])
    await admin.query(`select advance_provider_payment($1::uuid, 'CONFIRMED')`, [id])
    await admin.query(`update provider_payments set confirmed_at = now() - interval '45 minutes' where id = $1`, [id])
  } else {
    await admin.query(`update provider_payments set broadcasted_at = now() - interval '5 hours' where id = $1`, [id])
  }
  return id
}

/** The detector: n concurrent sync_reconciliation_cases() runs, each in its own transaction holding its locks HOLD_MS. */
async function raceDetector(pool: pg.Pool, n: number): Promise<{ results: { payments: { opened: number } }[]; errors: string[]; ms: number }> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()))
  const started = Date.now()
  const settled = await Promise.allSettled(clients.map(async (c) => {
    try {
      await c.query('begin')
      const r = await c.query<{ r: { payments: { opened: number } } }>('select sync_reconciliation_cases() r')
      await c.query('select pg_sleep($1)', [HOLD_MS / 1000])
      await c.query('commit')
      return r.rows[0].r
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    }
  }))
  const ms = Date.now() - started
  clients.forEach((c) => c.release())
  return {
    results: settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])),
    errors: settled.flatMap((s) => (s.status === 'rejected' ? [s.reason instanceof Error ? s.reason.message.slice(0, 80) : String(s.reason)] : [])),
    ms,
  }
}

const treasuryBalance = async (admin: pg.Client) => Number((await admin.query<{ b: string }>(`select balance::text b from treasury_state where id = 1`)).rows[0].b)
const treasuryConsistent = async (admin: pg.Client) =>
  (await admin.query<{ ok: boolean }>(`select (select balance from treasury_state where id = 1) = (select coalesce(sum(amount), 0) from treasury_transactions) ok`)).rows[0].ok

// ---------------------------------------------------------------------------
// Order refund races (H-K): apply_partial_refund / refund_order / the worker's cancel path
// ---------------------------------------------------------------------------

const ORDER_QUANTITY = 1000
const ORDER_CHARGE = 4 // customerRate 4 per 1000 x 1000 units

/** A paid order the provider has accepted (status submitted), exactly where sync-order-status finds it. */
async function seedSubmittedOrder(admin: pg.Client, s: Scenario, user: string): Promise<string> {
  const id = (await admin.query<{ id: string }>(
    `select id from place_order($1::uuid, $2::uuid, 'https://t.me/race', $3::int, $4::uuid, $5::uuid, $6::uuid, 1::numeric, $7::text)`,
    [user, s.service, ORDER_QUANTITY, s.offer, s.provider, s.providerService, `race-refund-${randomUUID()}`])).rows[0].id
  await admin.query(`update orders set status = 'processing' where id = $1`, [id])
  await admin.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [id, `P-${id.slice(0, 8)}`])
  return id
}

/** A referrer with `rewards` x 0.20 of cleared affiliate earnings (hold 0, 5%): rewards come from real completed orders of one invitee. */
async function seedReferrer(admin: pg.Client, s: Scenario, rewards: number): Promise<{ referrer: string; buyer: string; orders: string[] }> {
  await admin.query(`update platform_settings set referral_reward_percentage = 5, referral_hold_days = 0 where id = 1`)
  const referrer = await seedUser(admin, 1)
  const buyer = await seedUser(admin, 100_000)
  const code = (await admin.query<{ c: string }>(`select referral_code c from users where id = $1`, [referrer])).rows[0].c
  await admin.query(`select apply_referral($1::uuid, $2)`, [buyer, code])
  const orders: string[] = []
  for (let i = 0; i < rewards; i++) {
    const id = await seedSubmittedOrder(admin, s, buyer)
    await admin.query(`update orders set status = 'completed' where id = $1`, [id])
    orders.push(id)
  }
  return { referrer, buyer, orders }
}

const transferOp = (user: string, amount: number | null, key: string | null): RaceOp => (c) =>
  inTx(c, async () => {
    const r = await c.query<{ r: { transferred: string; replayed: boolean } }>(`select transfer_affiliate_balance_to_wallet($1::uuid, $2::numeric, $3::text) r`, [user, amount, key])
    return `transfer:${r.rows[0].r.transferred}:${r.rows[0].r.replayed ? 'replayed' : 'new'}`
  })

/** One database operation of a race. It manages its own transaction(s), like the worker's separate RPC calls do. */
type RaceOp = (c: pg.PoolClient) => Promise<string>

const inTx = async (c: pg.PoolClient, body: () => Promise<string>): Promise<string> => {
  await c.query('begin')
  try {
    const out = await body()
    await c.query('select pg_sleep($1)', [HOLD_MS / 1000]) // hold the row locks so the others really queue
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  }
}

const partialOp = (order: string, remains: number): RaceOp => (c) =>
  inTx(c, async () => {
    const r = await c.query<{ partial_refund_amount: string; status: string }>(`select partial_refund_amount::text, status::text from apply_partial_refund($1::uuid, $2::int, 10)`, [order, remains])
    return `partial:${r.rows[0].status}:${r.rows[0].partial_refund_amount}`
  })

const refundOp = (order: string): RaceOp => (c) =>
  inTx(c, async () => {
    const r = await c.query<{ status: string }>(`select status::text from refund_order($1::uuid, null, 'race refund')`, [order])
    return `refund:${r.rows[0].status}`
  })

/**
 * The worker's cancel path (order-sync failAndRefund): a conditional status update, then refund_order. Whether the two
 * run in one transaction or in two (as they do over PostgREST) must not matter.
 */
/** refund_order, then the worker drops the needs_refund note (failAndRefund does the same). */
const refundAndClear = async (c: { query: pg.Client['query'] }, order: string, comment: string) => {
  await c.query(`select refund_order($1::uuid, null, $2)`, [order, comment])
  await c.query(`update orders set error_message = null where id = $1 and status = 'refunded'`, [order])
}

const cancelOp = (order: string, twoTransactions: boolean): RaceOp => async (c) => {
  const update = async () => (await c.query(
    `update orders set status = 'canceled', error_message = 'needs_refund: provider canceled order' where id = $1 and status in ('submitted', 'in_progress') returning id`, [order])).rowCount ?? 0
  if (twoTransactions) {
    await c.query('begin')
    const n = await update()
    await c.query('select pg_sleep($1)', [HOLD_MS / 1000])
    await c.query('commit')
    if (n === 0) return 'cancel:conflict'
    return inTx(c, async () => { await refundAndClear(c, order, 'Provider canceled order'); return 'cancel:refunded' })
  }
  return inTx(c, async () => {
    if ((await update()) === 0) return 'cancel:conflict'
    await refundAndClear(c, order, 'Provider canceled order')
    return 'cancel:refunded'
  })
}

interface OpResult { ok: string[]; errors: string[] }

/** Every op on its own connection, all released at (nearly) the same moment. */
async function raceOps(pool: pg.Pool, ops: RaceOp[], jitterMs = 0): Promise<OpResult> {
  const clients = await Promise.all(ops.map(() => pool.connect()))
  // jitterMs > 0 staggers the start by a random 0..jitterMs, so over many rounds each op wins the row lock sometimes
  const settled = await Promise.allSettled(ops.map(async (op, i) => {
    if (jitterMs > 0) await new Promise((r) => setTimeout(r, Math.random() * jitterMs))
    return op(clients[i])
  }))
  clients.forEach((c) => c.release())
  const out: OpResult = { ok: [], errors: [] }
  for (const r of settled) {
    if (r.status === 'fulfilled') out.ok.push(r.value)
    else out.errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
  }
  return out
}

interface OrderMoney { status: string; partial: number; refunded: number; entries: number; needsRefund: boolean }

async function orderMoney(admin: pg.Client, order: string): Promise<OrderMoney> {
  const o = (await admin.query<{ status: string; partial: string; note: string | null }>(`select status::text, partial_refund_amount::text partial, error_message note from orders where id = $1`, [order])).rows[0]
  const t = (await admin.query<{ s: string; n: number }>(`select coalesce(sum(amount), 0)::text s, count(*)::int n from wallet_transactions where reference_id = $1 and type = 'refund' and status = 'completed'`, [order])).rows[0]
  return { status: o.status, partial: num(o.partial), refunded: num(t.s), entries: t.n, needsRefund: (o.note ?? '').startsWith('needs_refund') }
}

/** What the next sync-order-status run does for an order left canceled with a needs_refund note. */
async function workerRetry(admin: pg.Client, order: string) {
  const m = await orderMoney(admin, order)
  if ((m.status === 'canceled' || m.status === 'failed') && m.needsRefund) await refundAndClear(admin, order, 'Automatic refund retry')
}

// ---------------------------------------------------------------------------
// Checks + output
// ---------------------------------------------------------------------------

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${JSON.stringify(actual)}${pass ? '' : `   (expected ${JSON.stringify(expected)})`}`)
}
const num = (v: unknown) => Number(v)
const summary = (r: RaceResult) =>
  `  ${r.ok.length} succeeded, ${[...r.errors].map(([k, v]) => `${v} ${k}`).join(', ') || '0 rejected'} | ${r.ms} ms | ` +
  `peak sessions waiting on a row lock: ${r.peakLockWaiters}, peak active: ${r.peakActive}`

/** Every wallet's balance must equal the sum of its completed ledger entries, and never be negative. */
async function ledgerConsistent(admin: pg.Client, users: string[]) {
  const r = await admin.query<{ bad: number }>(
    `select count(*)::int bad from wallets w
      where w.user_id = any($1::uuid[])
        and (w.balance < 0 or w.balance <> (select coalesce(sum(amount), 0) from wallet_transactions t where t.wallet_id = w.id and t.status = 'completed'))`,
    [users])
  return r.rows[0].bad === 0
}

async function main() {
  const db = await openDatabase()
  const admin = new pg.Client({ connectionString: db.url })
  await admin.connect()
  const sampler = new pg.Client({ connectionString: db.url })
  await sampler.connect()
  const pool = new pg.Pool({ connectionString: db.url, max: 120 })
  try {
    const version = (await admin.query<{ v: string }>(`select current_setting('server_version') v`)).rows[0].v
    const migrations = db.embedded ? await migrate(admin) : 'already applied (local Supabase)'
    console.log(`Real PostgreSQL ${version} (${db.embedded ? 'embedded, throwaway' : 'local Supabase'}), migrations: ${migrations}, lock hold per request: ${HOLD_MS} ms\n`)

    // ---- A. Wallet race -------------------------------------------------------------------------
    console.log('A. Wallet race: 1 user with $10.00, 100 concurrent $2.00 orders')
    const sA = await seedScenario(admin, 'a', { customerRate: 2, costRate: 0.5, providerBalance: null })
    const uA = await seedUser(admin, 10)
    const rA = await race(pool, sampler, sA, Array.from({ length: 100 }, (_, i) => ({ user: uA, key: `race-a-${i}-${randomUUID()}` })), 1000, 0.5)
    console.log(summary(rA))
    const wA = await admin.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [uA])
    const oA = await admin.query<{ n: number }>(`select count(*)::int n from orders where user_id = $1`, [uA])
    const pA = await admin.query<{ n: number; s: string }>(`select count(*)::int n, coalesce(sum(amount), 0)::text s from wallet_transactions t join wallets w on w.id = t.wallet_id where w.user_id = $1 and t.type = 'purchase'`, [uA])
    check('orders that succeeded', rA.ok.length, 5)
    check('rejected for insufficient funds', rA.errors.get('insufficient_funds') ?? 0, 95)
    check('any other error (deadlock, unexpected)', [...rA.errors.keys()].filter((k) => k !== 'insufficient_funds'), [])
    check('wallet balance', num(wA.rows[0].b), 0)
    check('orders in the database', oA.rows[0].n, 5)
    check('purchase ledger entries / total', [pA.rows[0].n, num(pA.rows[0].s)], [5, -10])
    check('wallet = sum of its ledger, never negative', await ledgerConsistent(admin, [uA]), true)

    // ---- B. Provider capacity race --------------------------------------------------------------
    console.log('\nB. Provider capacity race: provider with $15.00, 5 users with $100.00, 100 concurrent orders costing the provider $2.00')
    const sB = await seedScenario(admin, 'b', { customerRate: 4, costRate: 2, providerBalance: 15 })
    const usersB: string[] = []
    for (let i = 0; i < 5; i++) usersB.push(await seedUser(admin, 100))
    const rB = await race(pool, sampler, sB, Array.from({ length: 100 }, (_, i) => ({ user: usersB[i % 5], key: `race-b-${i}-${randomUUID()}` })), 1000, 2)
    console.log(summary(rB))
    const provB = await admin.query<{ b: string }>(`select provider_balance::text b from providers where id = $1`, [sB.provider])
    const oB = await admin.query<{ n: number; r: string }>(`select count(*)::int n, coalesce(sum(provider_reservation), 0)::text r from orders where provider_id = $1`, [sB.provider])
    const wB = await admin.query<{ s: string; neg: number }>(`select sum(balance)::text s, count(*) filter (where balance < 0)::int neg from wallets where user_id = any($1::uuid[])`, [usersB])
    check('orders that succeeded', rB.ok.length, 7)
    check('rejected: provider balance cannot cover the cost', rB.errors.get('insufficient_provider_balance') ?? 0, 93)
    check('any other error (deadlock, unexpected)', [...rB.errors.keys()].filter((k) => k !== 'insufficient_provider_balance'), [])
    check('provider balance (never negative)', num(provB.rows[0].b), 1)
    check('orders / total reserved', [oB.rows[0].n, num(oB.rows[0].r)], [7, 14])
    check('customers charged only for the 7 orders (500 - 7 x 4)', num(wB.rows[0].s), 472)
    check('negative customer wallets', wB.rows[0].neg, 0)
    check('wallets = sum of their ledgers', await ledgerConsistent(admin, usersB), true)

    // ---- C. Idempotency race --------------------------------------------------------------------
    console.log('\nC. Idempotency race: 50 concurrent requests with the SAME idempotency key for a $5.00 order')
    const sC = await seedScenario(admin, 'c', { customerRate: 5, costRate: 1, providerBalance: null })
    const uC = await seedUser(admin, 100)
    const key = `race-c-${randomUUID()}`
    const rC = await race(pool, sampler, sC, Array.from({ length: 50 }, () => ({ user: uC, key })), 1000, 1)
    console.log(summary(rC))
    const oC = await admin.query<{ n: number }>(`select count(*)::int n from orders where idempotency_key = $1`, [key])
    const wC = await admin.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [uC])
    const pC = await admin.query<{ n: number }>(`select count(*)::int n from wallet_transactions t join wallets w on w.id = t.wallet_id where w.user_id = $1 and t.type = 'purchase'`, [uC])
    check('requests answered (each gets the one order)', rC.ok.length, 50)
    check('distinct order ids returned', new Set(rC.ok.map((o) => o.orderId)).size, 1)
    check('orders created for the key', oC.rows[0].n, 1)
    check('purchase ledger entries', pC.rows[0].n, 1)
    check('wallet balance (100 - 5)', num(wC.rows[0].b), 95)
    check('wallet = sum of its ledger', await ledgerConsistent(admin, [uC]), true)

    // ---- D. Provider payment daily limit race ---------------------------------------------------
    console.log('\nD. Payout daily limit race: provider with max $10/tx and $50/day, 20 concurrent $10 payments')
    await admin.query(`update platform_settings set minimum_treasury_reserve = 0 where id = 1`)
    await admin.query(`select process_treasury_transaction('deposit', 10000, 'race funding', 'race-treasury-' || gen_random_uuid())`)
    const tD0 = await treasuryBalance(admin)
    const pD = await seedPayoutProvider(admin, 10, 50)
    const payD: string[] = []
    for (let i = 0; i < 20; i++) payD.push(await approvedPayment(admin, pD, 10))
    const rD = await raceValidations(pool, sampler, payD)
    console.log(summary(rD))
    const usedD = await admin.query<{ s: string; n: number }>(`select coalesce(sum(amount), 0)::text s, count(*)::int n from provider_payments where provider_id = $1 and status = 'VALIDATED'`, [pD])
    check('payments validated', rD.ok.length, 5)
    check('refused: daily limit', rD.errors.get('max_daily_topup_exceeded') ?? 0, 15)
    check('any other error (deadlock, unexpected)', [...rD.errors.keys()].filter((k) => k !== 'max_daily_topup_exceeded'), [])
    check('total committed today (never above $50)', [usedD.rows[0].n, num(usedD.rows[0].s)], [5, 50])
    check('treasury debited exactly $50', tD0 - (await treasuryBalance(admin)), 50)
    check('treasury balance = sum of its journal', await treasuryConsistent(admin), true)

    // ---- E. Treasury minimum reserve race --------------------------------------------------------
    console.log('\nE. Treasury reserve race: reserve leaves room for $50, 10 concurrent $25 payments to 10 different providers')
    const tE0 = await treasuryBalance(admin)
    const reserve = tE0 - 60 // room for two $25 payments, not three
    await admin.query(`update platform_settings set minimum_treasury_reserve = $1 where id = 1`, [reserve])
    const payE: string[] = []
    for (let i = 0; i < 10; i++) payE.push(await approvedPayment(admin, await seedPayoutProvider(admin, 100, 1000), 25))
    const rE = await raceValidations(pool, sampler, payE)
    console.log(summary(rE))
    const tE1 = await treasuryBalance(admin)
    check('payments validated', rE.ok.length, 2)
    check('refused: minimum reserve', rE.errors.get('treasury_reserve_breached') ?? 0, 8)
    check('any other error (deadlock, unexpected)', [...rE.errors.keys()].filter((k) => k !== 'treasury_reserve_breached'), [])
    check('treasury debited exactly $50', tE0 - tE1, 50)
    check('treasury never below the reserve', tE1 >= reserve, true)
    check('treasury balance = sum of its journal', await treasuryConsistent(admin), true)
    await admin.query(`update platform_settings set minimum_treasury_reserve = 0 where id = 1`)

    // ---- F. Reconciliation detector race ---------------------------------------------------------
    console.log('\nF. Detector race: 3 payments stuck BROADCASTED > 4 h, 3 CONFIRMED > 30 min, 30 concurrent sync_reconciliation_cases() runs')
    const pF = await seedPayoutProvider(admin, 100, 10000)
    const stuck: string[] = []
    for (let i = 0; i < 3; i++) stuck.push(await stuckPayment(admin, pF, 'BROADCASTED'))
    for (let i = 0; i < 3; i++) stuck.push(await stuckPayment(admin, pF, 'CONFIRMED'))
    const rF = await raceDetector(pool, 30)
    console.log(`  ${rF.results.length} runs succeeded, ${rF.errors.length} failed | ${rF.ms} ms`)
    const casesF = await admin.query<{ open: number; total: number; limbo: number; credit: number }>(
      `select count(*) filter (where status = 'open')::int open, count(*)::int total,
              count(*) filter (where reason like 'Stuck in BROADCASTED for over 4 h:%')::int limbo,
              count(*) filter (where reason like 'Confirmed on chain at % but not completed after 30 min%')::int credit
         from reconciliation_cases where entity_type = 'provider_payment' and entity_id = any($1::text[])`, [stuck])
    check('detector runs that failed (deadlock, unique violation)', rF.errors, [])
    check('open provider_payment cases (exactly one per payment)', casesF.rows[0].open, 6)
    check('cases ever created for these payments', casesF.rows[0].total, 6)
    check('cases opened, summed over all 30 runs', rF.results.reduce((s, r) => s + r.payments.opened, 0), 6)
    check('Rule B (limbo) / Rule A (confirmed) reasons', [casesF.rows[0].limbo, casesF.rows[0].credit], [3, 3])

    // ---- G. Worker heartbeat race ----------------------------------------------------------------
    console.log('\nG. Heartbeat race: 40 overlapping worker runs (30 ok, 10 failed) report at once; the health snapshot is read meanwhile')
    const worker = `race-worker-${randomUUID().slice(0, 8)}`
    const clientsG = await Promise.all(Array.from({ length: 41 }, () => pool.connect()))
    const settledG = await Promise.allSettled(clientsG.map(async (c, i) => {
      try {
        await c.query('begin')
        if (i < 40) await c.query('select record_worker_heartbeat($1, $2, $3, $4)', [worker, i % 4 !== 0, i % 4 === 0 ? 'race failure' : null, 100 + i])
        else await c.query('select get_system_health(24)') // a reader never blocks nor is blocked
        await c.query('select pg_sleep($1)', [HOLD_MS / 1000])
        await c.query('commit')
      } catch (e) {
        await c.query('rollback').catch(() => {})
        throw e
      }
    }))
    clientsG.forEach((c) => c.release())
    const hb = await admin.query<{ runs: string; failures: string; ok: boolean; err: boolean }>(
      `select runs::text, failures::text, last_success_at is not null ok, last_error_at is not null err from worker_heartbeats where worker = $1`, [worker])
    check('heartbeat calls that failed (deadlock, unique violation)', settledG.filter((r) => r.status === 'rejected').length, 0)
    check('runs counted, none lost', num(hb.rows[0].runs), 40)
    check('failures counted', num(hb.rows[0].failures), 10)
    check('last success and last error both kept', [hb.rows[0].ok, hb.rows[0].err], [true, true])

    // ---- H-K. Order refunds ---------------------------------------------------------------------
    const sR = await seedScenario(admin, 'refund', { customerRate: ORDER_CHARGE, costRate: 1, providerBalance: null })
    const uR = await seedUser(admin, 100_000)
    const sumRefunds = async (orders: string[]) => (await admin.query<{ s: string }>(`select coalesce(sum(amount), 0)::text s from wallet_transactions where reference_id = any($1::uuid[]) and type = 'refund' and status = 'completed'`, [orders])).rows[0].s
    const walletOf = async () => num((await admin.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [uR])).rows[0].b)

    // ---- H. Double Partial ----------------------------------------------------------------------
    console.log('\nH. Double Partial: 2 concurrent Partial answers for the same order (25 rounds; same remains in half, 400 vs 700 in the rest)')
    const ordersH: string[] = []
    let hBadEntries = 0, hOverCharge = 0, hNotPartial = 0, hMismatch = 0, hErrors = 0
    for (let i = 0; i < 25; i++) {
      const order = await seedSubmittedOrder(admin, sR, uR)
      ordersH.push(order)
      const r = await raceOps(pool, [partialOp(order, 400), partialOp(order, i % 2 === 0 ? 400 : 700)])
      hErrors += r.errors.length
      const m = await orderMoney(admin, order)
      if (m.entries !== 1) hBadEntries++
      if (m.refunded > ORDER_CHARGE) hOverCharge++
      if (m.status !== 'partial') hNotPartial++
      if (Math.abs(m.refunded - m.partial) > 1e-9 || ![1.6, 2.8].includes(m.refunded)) hMismatch++
    }
    check('errors (both calls answered; the second returns the settled order)', hErrors, 0)
    check('rounds where the wallet was credited other than exactly once', hBadEntries, 0)
    check('rounds where more than the charge came back', hOverCharge, 0)
    check('rounds not ending in partial', hNotPartial, 0)
    check('rounds where credit differs from orders.partial_refund_amount', hMismatch, 0)
    check('wallet = sum of its ledger', await ledgerConsistent(admin, [uR]), true)

    // ---- I. Cancel + Partial race ---------------------------------------------------------------
    console.log('\nI. Canceled + Partial race: the worker\'s cancel path against apply_partial_refund (40 rounds, one and two transactions)')
    const ordersI: string[] = []
    const finalI = new Map<string, number>()
    let iOverCharge = 0, iUnsafe = 0, iStuck = 0, iFullOrPartialOnly = 0
    for (let i = 0; i < 40; i++) {
      const order = await seedSubmittedOrder(admin, sR, uR)
      ordersI.push(order)
      await raceOps(pool, i % 2 === 0 ? [cancelOp(order, i % 4 === 0), partialOp(order, 400)] : [partialOp(order, 400), cancelOp(order, i % 4 === 1)], 25)
      await workerRetry(admin, order) // the next sync run finishes a cancel whose refund did not happen
      const m = await orderMoney(admin, order)
      finalI.set(m.status, (finalI.get(m.status) ?? 0) + 1)
      if (m.refunded > ORDER_CHARGE) iOverCharge++
      if (!['refunded', 'partial'].includes(m.status)) iUnsafe++
      if (m.needsRefund) iStuck++
      // refunded: the whole charge came back; partial: exactly the undelivered share. Nothing in between, nothing more.
      if (!((m.status === 'refunded' && m.refunded === ORDER_CHARGE) || (m.status === 'partial' && m.refunded === 1.6))) iFullOrPartialOnly++
    }
    console.log(`  final states: ${[...finalI].map(([k, v]) => `${v} ${k}`).join(', ')}`)
    check('rounds where more than the charge came back', iOverCharge, 0)
    check('rounds ending in an unsafe state (not refunded / partial)', iUnsafe, 0)
    check('rounds left with an unfinished refund (needs_refund)', iStuck, 0)
    check('rounds where the credit is neither the full charge nor the exact partial', iFullOrPartialOnly, 0)
    check('wallet = sum of its ledger', await ledgerConsistent(admin, [uR]), true)

    // ---- J. Partial + full refund race ----------------------------------------------------------
    console.log('\nJ. Partial + full refund race: apply_partial_refund against refund_order (an admin force refund), 25 rounds')
    const ordersJ: string[] = []
    let jOverCharge = 0, jNotTerminal = 0, jExact = 0
    for (let i = 0; i < 25; i++) {
      const order = await seedSubmittedOrder(admin, sR, uR)
      ordersJ.push(order)
      // refund_order on a still-submitted order is refused by the state machine; the admin tool only refunds settled orders, so
      // the full refund here follows the cancel path. Either order of arrival must leave the charge returned once, in total.
      await raceOps(pool, i % 2 === 0 ? [partialOp(order, 250), cancelOp(order, false)] : [cancelOp(order, false), partialOp(order, 250)], 25)
      await workerRetry(admin, order)
      // an admin force-refunds whatever is left (idempotent when already refunded)
      await admin.query(`select refund_order($1::uuid, null, 'Admin force refund')`, [order])
      const m = await orderMoney(admin, order)
      if (m.refunded > ORDER_CHARGE) jOverCharge++
      if (m.status !== 'refunded') jNotTerminal++
      if (m.refunded === ORDER_CHARGE) jExact++
    }
    check('rounds where more than the charge came back', jOverCharge, 0)
    check('rounds not ending in refunded', jNotTerminal, 0)
    check('rounds where exactly the charge came back, in total', jExact, 25)

    // ---- K. refund_order storm ------------------------------------------------------------------
    console.log('\nK. refund_order storm: 30 concurrent refunds of one canceled order')
    const orderK = await seedSubmittedOrder(admin, sR, uR)
    await admin.query(`update orders set status = 'canceled' where id = $1`, [orderK])
    const rK = await raceOps(pool, Array.from({ length: 30 }, () => refundOp(orderK)))
    const mK = await orderMoney(admin, orderK)
    check('refund calls that failed', rK.errors, [])
    check('credits for the order', [mK.entries, mK.refunded, mK.status], [1, ORDER_CHARGE, 'refunded'])

    // ---- L-O. Affiliate withdrawals ---------------------------------------------------------------
    const sA2 = await seedScenario(admin, 'affiliate', { customerRate: ORDER_CHARGE, costRate: 1, providerBalance: null })
    const affiliate = async (referrer: string) => (await admin.query<{ b: { total: number; available: number } }>(`select referral_balance($1::uuid) b`, [referrer])).rows[0].b
    const walletBalance = async (user: string) => num((await admin.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [user])).rows[0].b)
    const ledgerOf = async (referrer: string) => (await admin.query<{ n: number; s: string }>(`select count(*) filter (where transaction_type = 'transfer_to_wallet')::int n, coalesce(sum(-amount) filter (where transaction_type = 'transfer_to_wallet'), 0)::text s from referral_ledger where user_id = $1`, [referrer])).rows[0]

    // ---- L. Withdrawal storm --------------------------------------------------------------------
    console.log('\nL. Withdrawal storm: 30 concurrent "withdraw everything" requests, $10.00 cleared (50 rewards of $0.20)')
    const refL = await seedReferrer(admin, sA2, 50)
    const startL = await walletBalance(refL.referrer)
    check('cleared affiliate balance before the storm', (await affiliate(refL.referrer)).available, 10)
    const rL = await raceOps(pool, Array.from({ length: 30 }, () => transferOp(refL.referrer, null, null)))
    const succeededL = rL.ok.length
    const lL = await ledgerOf(refL.referrer)
    check('requests that moved money', succeededL, 1)
    check('refused: nothing left to withdraw', rL.errors.filter((e) => /insufficient_affiliate_balance/.test(e)).length, 29)
    check('any other error (deadlock, unexpected)', rL.errors.filter((e) => !/insufficient_affiliate_balance/.test(e)), [])
    check('wallet credited exactly once, by the whole balance', [num(lL.s), (await walletBalance(refL.referrer)) - startL], [10, 10])
    check('affiliate balance left', (await affiliate(refL.referrer)).total, 0)

    // ---- M. Many small withdrawals --------------------------------------------------------------
    console.log('\nM. Small withdrawals: 40 concurrent $0.50 requests with distinct keys against $10.00 cleared')
    const refM = await seedReferrer(admin, sA2, 50)
    const startM = await walletBalance(refM.referrer)
    const rM = await raceOps(pool, Array.from({ length: 40 }, () => transferOp(refM.referrer, 0.5, `m-${randomUUID()}`)))
    const lM = await ledgerOf(refM.referrer)
    check('requests that moved money (20 x $0.50 = $10.00)', rM.ok.length, 20)
    check('refused for lack of balance', rM.errors.filter((e) => /insufficient_affiliate_balance/.test(e)).length, 20)
    check('any other error', rM.errors.filter((e) => !/insufficient_affiliate_balance/.test(e)), [])
    check('total withdrawn never exceeds what was earned', [num(lM.s), (await walletBalance(refM.referrer)) - startM], [10, 10])
    check('affiliate balance left', (await affiliate(refM.referrer)).total, 0)

    // ---- N. Same-key retries --------------------------------------------------------------------
    console.log('\nN. Retries: 25 concurrent requests with the SAME idempotency key (a client retrying a timeout)')
    const refN = await seedReferrer(admin, sA2, 10)
    const startN = await walletBalance(refN.referrer)
    const keyN = `n-${randomUUID()}`
    const rN = await raceOps(pool, Array.from({ length: 25 }, () => transferOp(refN.referrer, 1, keyN)))
    const lN = await ledgerOf(refN.referrer)
    check('requests answered', [rN.ok.length, rN.errors], [25, []])
    check('of which moved money / replayed', [rN.ok.filter((o) => o.endsWith(':new')).length, rN.ok.filter((o) => o.endsWith(':replayed')).length], [1, 24])
    check('withdrawn once ($1.00)', [lN.n, num(lN.s), (await walletBalance(refN.referrer)) - startN], [1, 1, 1])

    // ---- O. Withdrawal against clawbacks --------------------------------------------------------
    console.log('\nO. Withdrawal vs clawback: 20 rounds, "withdraw everything" races the refund of the order that earned the reward')
    let oOverWithdrawn = 0, oUnbalanced = 0, oBothWays = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const r = await seedReferrer(admin, sA2, 1) // $0.20 cleared
      const startO = await walletBalance(r.referrer)
      await raceOps(pool, i % 2 === 0 ? [transferOp(r.referrer, null, null), refundOp(r.orders[0])] : [refundOp(r.orders[0]), transferOp(r.referrer, null, null)], 25)
      const l = await ledgerOf(r.referrer)
      const b = await affiliate(r.referrer)
      const credited = (await walletBalance(r.referrer)) - startO
      if (num(l.s) > 0.2 + 1e-9) oOverWithdrawn++            // never more than was earned
      if (Math.abs(credited - num(l.s)) > 1e-9) oUnbalanced++ // the wallet got exactly what the ledger says left
      oBothWays.add(num(l.s) > 0 ? 'withdrawn before the clawback (balance goes negative, recovered later)' : 'clawback first (nothing to withdraw)')
      if (b.total < -0.2 - 1e-9) oOverWithdrawn++
    }
    console.log(`  outcomes seen: ${[...oBothWays].join('; ')}`)
    check('rounds where more than the earned reward left the ledger', oOverWithdrawn, 0)
    check('rounds where wallet credit and ledger debit differ', oUnbalanced, 0)
    const refAll = [refL.referrer, refM.referrer, refN.referrer]
    check('wallets = sum of their ledgers (referrers)', await ledgerConsistent(admin, refAll), true)
    const refTotals = await admin.query<{ bad: number }>(`select count(*)::int bad from (select user_id, sum(amount) s from referral_ledger group by user_id) x where x.s < -0.2`)
    check('no referrer below the one-reward clawback floor', refTotals.rows[0].bad, 0)

    // ---- P-R. Discount engine -----------------------------------------------------------------
    const sD = await seedScenario(admin, 'discount', { customerRate: 4, costRate: 2, providerBalance: null })
    const adminD = (await admin.query<{ id: string }>(`insert into users(telegram_id, is_admin) values ($1, true) returning id`, [Math.floor(Math.random() * 9e12) + 1e12])).rows[0].id
    await admin.query(`update platform_settings set discount_min_margin_per_1000 = 0.01 where id = 1`)
    const placeOp = (user: string, promo: string | null, service = sD): RaceOp => (c) =>
      inTx(c, async () => {
        const r = await c.query<{ charge_amount: string }>(
          `select charge_amount::text from place_order($1::uuid, $2::uuid, 'https://t.me/race', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, $6::text, $7::text)`,
          [user, service.service, service.offer, service.provider, service.providerService, `d-${randomUUID()}`, promo])
        return `order:${r.rows[0].charge_amount}`
      })
    const vipUsers = async (count: number) => {
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = await seedUser(admin, 1000)
        await admin.query(`update users set tier_id = (select id from user_tiers where slug = 'vip') where id = $1`, [id])
        ids.push(id)
      }
      return ids
    }

    // ---- P. Promo max_uses race -----------------------------------------------------------------
    console.log('\nP. Promo race: a code with max_uses = 5, 60 different users order with it at the same moment')
    await admin.query(`select admin_upsert_promo_code($1::uuid, 'RACE5', 'fixed', 0.5, 5)`, [adminD])
    const usersP = await vipUsers(60)
    const rP = await raceOps(pool, usersP.map((u) => placeOp(u, 'RACE5')))
    const usedP = (await admin.query<{ uses: number; reds: number }>(`select (select current_uses from promo_codes where code = 'RACE5') uses, (select count(*)::int from promo_code_redemptions r join promo_codes p on p.id = r.promo_code_id where p.code = 'RACE5') reds`)).rows[0]
    check('orders that got the code', rP.ok.length, 5)
    check('refused: used up', rP.errors.filter((e) => /promo_exhausted/.test(e)).length, 55)
    check('any other error (deadlock, unexpected)', rP.errors.filter((e) => !/promo_exhausted/.test(e)), [])
    check('uses counted / redemptions recorded (never above max_uses)', [usedP.uses, usedP.reds], [5, 5])

    // ---- Q. Stacked discounts under load ----------------------------------------------------------
    console.log('\nQ. Stacking under load: 60 VIP customers with a $3.00 promo each (far more than the margin allows)')
    await admin.query(`select admin_upsert_promo_code($1::uuid, 'GREEDY', 'fixed', 3)`, [adminD])
    const usersQ = await vipUsers(60)
    const rQ = await raceOps(pool, usersQ.map((u) => placeOp(u, 'GREEDY')))
    const chargesQ = rQ.ok.map((o) => num(o.split(':')[1]))
    const lossQ = await admin.query<{ n: number }>(`select count(*)::int n from orders where service_id = $1 and charge_amount < cost_amount`, [sD.service])
    check('orders placed', [rQ.ok.length, rQ.errors], [60, []])
    check('every charge is exactly the floor (cost 2.00 + margin 0.01)', [...new Set(chargesQ)], [2.01])
    check('orders sold under their cost', lossQ.rows[0].n, 0)

    // ---- R. A price drop racing the orders -------------------------------------------------------
    console.log('\nR. Price drop vs orders: 40 orders race an admin who cuts the list price below cost')
    const usersR = await vipUsers(40)
    const dropper: RaceOp = (c) => inTx(c, async () => {
      await c.query(`update services set customer_rate_per_1000 = 1 where id = $1`, [sD.service]) // below the cost of 2.00
      return 'price-drop'
    })
    // orders start at random moments over ~400 ms, the price drop at 150 ms: some orders are in flight when it arrives (it waits for
    // them), the rest start after it and must see the new price
    const after = (ms: number, op: RaceOp): RaceOp => async (c) => { await new Promise((r) => setTimeout(r, ms)); return op(c) }
    const rR = await raceOps(pool, [...usersR.map((u) => after(Math.random() * 400, placeOp(u, null))), after(150, dropper)])
    const lossR = await admin.query<{ n: number }>(`select count(*)::int n from orders where service_id = $1 and charge_amount < cost_amount`, [sD.service])
    check('every order either went through at a safe price or was refused as below cost', rR.errors.filter((e) => !/below_cost/.test(e)), [])
    check('orders sold under their cost (the price check and the charge see the same price)', lossR.rows[0].n, 0)
    console.log(`  ${rR.ok.filter((o) => o.startsWith('order:')).length} orders went through before the drop, ${rR.errors.length} were refused after it`)
    check('the price drop itself committed', rR.ok.includes('price-drop'), true)

    // ---- whole-wallet balance ---------------------------------------------------------------------
    const allOrders = [...ordersH, ...ordersI, ...ordersJ, orderK]
    const charged = allOrders.length * ORDER_CHARGE
    check('wallet = funding - charges + refunds (no unit created or lost)', Math.round((await walletOf()) * 10_000) / 10_000, Math.round((100_000 - charged + num(await sumRefunds(allOrders))) * 10_000) / 10_000)
    check('wallet = sum of its ledger', await ledgerConsistent(admin, [uR]), true)
  } finally {
    await pool.end().catch(() => {})
    await sampler.end().catch(() => {})
    await admin.end().catch(() => {})
    await db.stop()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('concurrency test crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})
