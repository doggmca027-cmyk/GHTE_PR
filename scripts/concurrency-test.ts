// Real-PostgreSQL concurrency test for the money paths (PGlite runs on ONE connection and cannot prove locking).
//
//   npm run test:concurrency
//       Starts a throwaway, real PostgreSQL server (embedded-postgres, no Docker needed), applies every migration and
//       fires the races below through a pool of separate connections. The server is deleted afterwards.
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
  await admin.query(`insert into categories(id, platform, name, slug) values ($1, 'telegram', $2, $2)`, [category, `race-${tag}-${category.slice(0, 8)}`])
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
