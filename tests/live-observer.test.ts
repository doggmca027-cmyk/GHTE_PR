import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  FINAL, IN_FLIGHT, REFUND_PENDING, assess, diff, parseSnapshot, runObserver, snapshotQuery, statusLine, verdict,
  type HeartbeatRow, type ObserverDeps, type OrderRow, type ProviderRow, type Snapshot,
} from '../scripts/lib/live-observer'
import { assertReadOnly } from '../scripts/lib/live-smoke'

const ROOT = path.resolve(__dirname, '..')
const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ago = (ms: number) => iso(NOW - ms)
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const PROVIDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const provider = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: PROVIDER_ID, name: 'Flight Panel', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: ago(20_000),
  provider_balance: 4.99, currency: 'USD', last_balance_sync: ago(20_000), sync_backoff_until: null, sync_failure_count: 0, ...over,
})
const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: ORDER_ID, status: 'submitted', provider_order_id: 'P-1', error_message: null, quantity: 100, remains: null, start_count: null,
  charge_amount: 0.015, cost_amount: 0.005, profit_amount: 0.01, partial_refund_amount: null, effective_provider_id: PROVIDER_ID,
  created_at: ago(120_000), updated_at: ago(30_000), ...over,
})
const beat = (worker: string, successAgo: number | null, over: Partial<HeartbeatRow> = {}): HeartbeatRow => ({
  worker, last_run_at: successAgo === null ? null : ago(successAgo), last_success_at: successAgo === null ? null : ago(successAgo),
  last_error_at: null, last_error: null, runs: 100, failures: 0, ...over,
})
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: iso(NOW), order: order(), history: [], wallet: [], providers: [provider()],
  heartbeats: [beat('sync-order-status', 20_000), beat('provider-health-monitor', 15_000), beat('telegram-notifier', 25_000)],
  lock: { held: false, locked_until: ago(30_000), acquired_at: ago(40_000) }, openCases: 0, outbox: [], ...over,
})
const codes = (s: Snapshot) => assess(s).map((f) => `${f.severity}:${f.code}`)

describe('the observer\'s query', () => {
  it('is one plain SELECT in both modes: it passes the read-only guard the smoke test uses', () => {
    expect(() => assertReadOnly(snapshotQuery({ orderId: ORDER_ID }))).not.toThrow()
    expect(() => assertReadOnly(snapshotQuery({ since: '2026-10-09T12:00:00Z' }))).not.toThrow()
  })

  it('only accepts a real UUID or an ISO UTC timestamp, so nothing typed on the command line can reach the SQL', () => {
    for (const bad of ["x'; drop table orders; --", '1', '', ORDER_ID + "' or '1'='1", 'not-a-uuid']) expect(() => snapshotQuery({ orderId: bad }), bad).toThrow()
    for (const bad of ["2026-10-09'; drop table orders; --", 'yesterday', '2026-10-09T12:00:00+02:00', '']) expect(() => snapshotQuery({ since: bad }), bad).toThrow()
  })

  it('never selects a secret: no API key, no lease token, no wildcard on the orders table', () => {
    const sql = snapshotQuery({ orderId: ORDER_ID })
    expect(sql).not.toMatch(/api_key|\btoken\b|secret|password|idempotency_key|target_url/i)
    expect(sql).not.toMatch(/select\s+\*/i)
    expect(sql).not.toMatch(/\bo\.\*/)
  })

  it('refuses writing statements: the guard is what the observer relies on', () => {
    for (const sql of ['update orders set status = \'completed\'', 'select 1; select 2', 'select pg_sleep(1)', 'with x as (delete from orders returning 1) select 1', 'select set_config(\'a\',\'b\',false)']) {
      expect(() => assertReadOnly(sql), sql).toThrow(/refused/)
    }
  })
})

describe('parseSnapshot', () => {
  it('accepts the document as an object or as text, and turns numbers that arrive as strings into numbers', () => {
    const raw = { now: iso(NOW), order: { ...order(), charge_amount: '0.0150', cost_amount: '0.0050', remains: '100' }, history: [], wallet: [{ type: 'purchase', status: 'completed', amount: '-0.0150', balance_after: '0.985', at: iso(NOW) }],
      providers: [{ ...provider(), provider_balance: '4.99' }], heartbeats: [], lease: null, open_cases: '0', outbox: [] }
    for (const rows of [[{ snapshot: raw }], [{ snapshot: JSON.stringify(raw) }]]) {
      const s = parseSnapshot(rows)
      expect(s.order).toMatchObject({ charge_amount: 0.015, cost_amount: 0.005, remains: 100 })
      expect(s.wallet[0]).toMatchObject({ amount: -0.015, balance_after: 0.985 })
      expect(s.providers[0].provider_balance).toBe(4.99)
      expect(s.openCases).toBe(0)
      expect(s.lock).toBeNull()
    }
  })

  it('rejects anything that is not the snapshot document', () => {
    for (const bad of [null, [], [{}], [{ snapshot: null }], [{ snapshot: { order: null } }], 'x', [{ snapshot: '{"a":1}' }]]) expect(() => parseSnapshot(bad), JSON.stringify(bad)).toThrow(/unexpected answer/)
  })
})

describe('assess: what is wrong right now', () => {
  it('a healthy order on a healthy system has no findings', () => {
    expect(codes(snap())).toEqual([])
  })

  it('the circuit breaker open on an in-flight order is critical, with the time it ends; on a finished order it is a warning', () => {
    const open = provider({ sync_backoff_until: iso(NOW + 4 * 60_000), sync_failure_count: 3 })
    const f = assess(snap({ providers: [open] })).find((x) => x.code === 'breaker_open')!
    expect(f.severity).toBe('critical')
    expect(f.message).toContain('12:04:00')
    expect(f.message).toContain('NOT being polled')
    expect(codes(snap({ providers: [open], order: order({ status: 'completed' }) }))).toContain('warn:breaker_open')
  })

  it('failed polls with the breaker still closed are a warning, an expired pause is not a finding at all', () => {
    expect(codes(snap({ providers: [provider({ sync_failure_count: 2 })] }))).toEqual(['warn:breaker_failures'])
    expect(codes(snap({ providers: [provider({ sync_backoff_until: ago(1000) })] }))).toEqual([])
  })

  it('a stale or missing sync worker is critical while an order depends on it', () => {
    expect(codes(snap({ heartbeats: [beat('sync-order-status', 200_000), beat('provider-health-monitor', 10_000)] }))).toContain('critical:sync_stale')
    expect(codes(snap({ heartbeats: [beat('provider-health-monitor', 10_000)] }))).toContain('critical:sync_never_ran')
    expect(codes(snap({ order: order({ status: 'completed' }), heartbeats: [beat('sync-order-status', 200_000), beat('provider-health-monitor', 10_000)] }))).toContain('warn:sync_stale')
    expect(codes(snap({ heartbeats: [beat('sync-order-status', 149_000), beat('provider-health-monitor', 10_000)] }))).toEqual([])
  })

  it('a failed run newer than the last success is reported with its message', () => {
    const f = assess(snap({ heartbeats: [beat('sync-order-status', 90_000, { last_error_at: ago(30_000), last_error: 'HTTP 502 from panel' }), beat('provider-health-monitor', 10_000)] })).find((x) => x.code === 'sync_error')!
    expect(f).toMatchObject({ severity: 'warn' })
    expect(f.message).toContain('HTTP 502 from panel')
    // an old error followed by a success is history, not a finding
    expect(codes(snap({ heartbeats: [beat('sync-order-status', 10_000, { last_error_at: ago(300_000), last_error: 'old' }), beat('provider-health-monitor', 10_000)] }))).toEqual([])
  })

  it('a silent health monitor and an overrunning lease are warnings', () => {
    expect(codes(snap({ heartbeats: [beat('sync-order-status', 10_000), beat('provider-health-monitor', 400_000)] }))).toContain('warn:monitor_stale')
    expect(codes(snap({ lock: { held: true, locked_until: iso(NOW - 10_000), acquired_at: ago(160_000) } }))).toContain('warn:lock_overrun')
    expect(codes(snap({ lock: { held: true, locked_until: iso(NOW + 100_000), acquired_at: ago(30_000) } }))).toEqual([])
  })

  it('an unhealthy provider is a warning; a provider that cannot be identified is a warning', () => {
    expect(codes(snap({ providers: [provider({ health_status: 'unavailable' })] }))).toEqual(['warn:provider_health'])
    expect(codes(snap({ providers: [provider(), provider({ id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Other' })], order: order({ effective_provider_id: null }) }))).toContain('warn:provider_unknown')
  })

  it('an order held for a human or with an open case is critical; a refund that is owed is a warning', () => {
    expect(codes(snap({ order: order({ status: 'processing', provider_order_id: null, error_message: 'needs_reconciliation: timeout: add' }) }))).toContain('critical:held_for_human')
    expect(codes(snap({ order: order({ status: 'canceled', error_message: 'needs_refund: provider canceled order' }) }))).toContain('warn:refund_owed')
    expect(codes(snap({ openCases: 1 }))).toContain('critical:open_case')
  })

  it('no progress for a long time and a refund that is slow are warnings, a dead notification too', () => {
    expect(codes(snap({ order: order({ updated_at: ago(16 * 60_000) }) }))).toContain('warn:no_progress')
    expect(assess(snap({ order: order({ updated_at: ago(16 * 60_000) }) }), { stuckAfterMs: 60 * 60_000 }).map((f) => f.code)).not.toContain('no_progress')
    expect(codes(snap({ order: order({ status: 'canceled', updated_at: ago(4 * 60_000) }) }))).toContain('warn:refund_slow')
    expect(codes(snap({ outbox: [{ kind: 'completed', status: 'dead', attempts: 8, last_error: 'x' }] }))).toContain('warn:notification_dead')
  })

  it('ages are measured on the database clock, not the laptop\'s', () => {
    // the laptop could be hours off; only snapshot.now matters
    const s = snap()
    expect(assess({ ...s, now: iso(NOW + 3 * 3600_000) }).map((f) => f.code)).toContain('sync_stale')
  })
})

describe('diff: what is new since the last poll', () => {
  const hist = (a: string | null, b: string, at = NOW, comment: string | null = null) => ({ old_status: a, new_status: b, comment, created_at: iso(at) })

  it('the first sighting shows the order and its whole history once', () => {
    const lines = diff(null, snap({ history: [hist(null, 'draft'), hist('draft', 'awaiting_payment')] }))
    expect(lines[0]).toMatch(/^ORDER {3}found 11111111-.* 100 units, charge \$0\.015, cost \$0\.005, status submitted/)
    expect(lines.filter((l) => l.startsWith('STATUS'))).toHaveLength(2)
    expect(lines.join('\n')).toContain('(new) -> draft')
    expect(lines.join('\n')).toContain('ORDER   provider_order_id: P-1')
  })

  it('later polls show only what changed: new history rows, the provider order id, remains, errors, wallet entries', () => {
    const before = snap({ order: order({ status: 'processing', provider_order_id: null }), history: [hist(null, 'draft')], providers: [provider()] })
    const after = snap({
      order: order({ status: 'in_progress', provider_order_id: 'P-9', start_count: 12, remains: 80, error_message: 'slow' }),
      history: [hist(null, 'draft'), hist('draft', 'processing', NOW, 'queued')],
      wallet: [{ type: 'purchase', status: 'completed', amount: -0.015, balance_after: 0.985, at: iso(NOW) }],
    })
    const lines = diff(before, after)
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/STATUS {2}12:00:00 draft -> processing \(queued\)/),
      'ORDER   provider_order_id: - -> P-9',
      'ORDER   start_count: - -> 12',
      'ORDER   remains: - -> 80',
      'ORDER   error_message: - -> slow',
      expect.stringMatching(/WALLET {2}12:00:00 purchase -\$0\.015 \(completed\), balance after \$0\.985/),
    ]))
    expect(lines.filter((l) => l.startsWith('STATUS'))).toHaveLength(1)
  })

  it('nothing is printed when nothing changed', () => {
    expect(diff(snap(), snap())).toEqual([])
  })

  it('provider changes: health, routing, balance and the circuit breaker opening, counting and closing', () => {
    const before = snap()
    const lines = diff(before, snap({ providers: [provider({ health_status: 'unavailable', routing_enabled: false, provider_balance: 4.5, sync_failure_count: 1, sync_backoff_until: iso(NOW + 60_000) })] }))
    expect(lines).toEqual(expect.arrayContaining([
      'PROVIDER Flight Panel: health healthy -> unavailable',
      'PROVIDER Flight Panel: routing on -> off',
      'PROVIDER Flight Panel: balance $4.99 -> $4.50',
      'BREAKER Flight Panel: failed polls in a row 0 -> 1',
      'BREAKER Flight Panel: OPEN until 12:01:00 UTC',
    ]))
    const closed = diff(snap({ providers: [provider({ sync_failure_count: 1, sync_backoff_until: iso(NOW + 60_000) })] }), snap())
    expect(closed).toEqual(expect.arrayContaining(['BREAKER Flight Panel: closed', 'BREAKER Flight Panel: failed polls in a row 1 -> 0']))
  })

  it('a worker\'s new error is reported, and open cases and notifications when they change', () => {
    const lines = diff(snap(), snap({
      heartbeats: [beat('sync-order-status', 10_000, { last_error_at: ago(5_000), last_error: 'boom' }), beat('provider-health-monitor', 10_000)],
      openCases: 1, outbox: [{ kind: 'completed', status: 'pending', attempts: 1, last_error: null }],
    }))
    expect(lines).toEqual(expect.arrayContaining([
      'WORKER  sync-order-status reported an error: boom',
      'RECON   open reconciliation cases for this order: 0 -> 1',
      'NOTIFY  completed pending (attempt 1)',
    ]))
  })

  it('providers are listed once, on the first poll only', () => {
    expect(diff(null, snap({ order: null })).filter((l) => l.startsWith('PROVIDER'))).toEqual(['PROVIDER Flight Panel: healthy, routing on, balance $4.99 USD'])
    expect(diff(snap({ order: null }), snap({ order: null }))).toEqual([])
  })
})

describe('statusLine', () => {
  it('shows the order, the sync worker\'s age, the health monitor, the breaker and the provider on one line', () => {
    const line = statusLine(snap({ order: order({ remains: 40 }) }))
    expect(line).toBe('12:00:00 | order submitted #P-1 remains 40 | sync 20s ago | health 15s ago | breaker closed (fails 0) | Flight Panel: healthy, $4.99')
  })

  it('makes an open breaker and a running lease impossible to miss', () => {
    const line = statusLine(snap({ providers: [provider({ sync_backoff_until: iso(NOW + 60_000), sync_failure_count: 2 })], lock: { held: true, locked_until: iso(NOW + 100_000), acquired_at: ago(1_000) } }))
    expect(line).toContain('BREAKER OPEN until 12:01:00')
    expect(line).toContain('(running)')
  })

  it('works before an order exists', () => {
    expect(statusLine(snap({ order: null, providers: [], heartbeats: [] }))).toBe('12:00:00 | no order yet | sync never ago | health never ago | breaker ? | provider ?')
  })
})

describe('verdict: did it complete and does the money add up', () => {
  const purchase = { type: 'purchase', status: 'completed', amount: -0.015, balance_after: 0.985, at: iso(NOW) }
  const done = (over: Partial<Snapshot> = {}) => snap({ order: order({ status: 'completed', remains: 0 }), wallet: [purchase], ...over })
  const failed = (v: ReturnType<typeof verdict>) => v.lines.filter((l) => l.startsWith('[FAIL]'))

  it('a completed order with one purchase of its charge, a consistent profit and no incident is clean', () => {
    const v = verdict(done(), [])
    expect(v.ok).toBe(true)
    expect(v.lines.every((l) => l.startsWith('[PASS]'))).toBe(true)
  })

  it('every way the money can be wrong fails the verdict', () => {
    expect(failed(verdict(done({ wallet: [] }), []))[0]).toContain('exactly one purchase')
    expect(failed(verdict(done({ wallet: [{ ...purchase, amount: -0.02 }] }), []))[0]).toContain('exactly one purchase')
    expect(failed(verdict(done({ wallet: [purchase, purchase] }), []))[0]).toContain('exactly one purchase')
    expect(failed(verdict(done({ wallet: [purchase, { ...purchase, type: 'refund', amount: 0.015 }] }), [])).join()).toContain('no refund booked on a completed order')
    expect(failed(verdict(done({ order: order({ status: 'completed', profit_amount: 0.5 }) }), [])).join()).toContain('profit = charge - cost')
    expect(failed(verdict(done({ order: order({ status: 'completed', cost_amount: 0.02, profit_amount: -0.005 }) }), [])).join()).toContain('not sold at a loss')
    expect(failed(verdict(done({ order: order({ status: 'completed', provider_order_id: null }) }), [])).join()).toContain('provider order id')
    expect(failed(verdict(done({ openCases: 2 }), [])).join()).toContain('2 reconciliation case(s) open')
  })

  it('a pending ledger entry does not count as money moved', () => {
    expect(failed(verdict(done({ wallet: [{ ...purchase, status: 'pending' }] }), [])).join()).toContain('exactly one purchase')
  })

  it('a critical finding seen at any time during the run fails it, even if it cleared (the breaker must never trip)', () => {
    const v = verdict(done(), ['breaker_open', 'breaker_open'])
    expect(v.ok).toBe(false)
    expect(failed(v)).toEqual(['[FAIL] critical finding(s) during the run: breaker_open'])
  })

  it('a refunded order fails the verdict (it did not complete) but its refunds are still checked against the charge', () => {
    const v = verdict(snap({ order: order({ status: 'refunded' }), wallet: [purchase, { ...purchase, type: 'refund', amount: 0.015 }] }), [])
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toContain('[FAIL] final status is "refunded"')
    expect(v.lines.join('\n')).toContain('[PASS] refunds add up to the charge')
    expect(failed(verdict(snap({ order: order({ status: 'refunded' }), wallet: [purchase, { ...purchase, type: 'refund', amount: 0.01 }] }), [])).join()).toContain('refunds add up to the charge')
  })

  it('a partial order is judged against its partial refund', () => {
    const partial = order({ status: 'partial', partial_refund_amount: 0.006 })
    const ok = verdict(snap({ order: partial, wallet: [purchase, { ...purchase, type: 'refund', amount: 0.006 }] }), [])
    expect(ok.lines.join('\n')).toContain('[PASS] refunds equal the partial refund')
    expect(verdict(snap({ order: partial, wallet: [purchase, { ...purchase, type: 'refund', amount: 0.01 }] }), []).lines.join('\n')).toContain('[FAIL] refunds equal the partial refund')
  })

  it('no order, no verdict', () => {
    expect(verdict(snap({ order: null }), [])).toEqual({ ok: false, lines: ['[FAIL] no order was observed'] })
  })

  it('the state sets agree with the order lifecycle', () => {
    expect([...FINAL].sort()).toEqual(['completed', 'partial', 'refunded'])
    expect([...REFUND_PENDING].sort()).toEqual(['canceled', 'failed'])
    expect([...IN_FLIGHT].sort()).toEqual(['in_progress', 'paid', 'processing', 'submitted'])
  })
})

describe('the loop, with scripted dependencies', () => {
  const script = (query: ObserverDeps['query'], steps: Array<() => void | Promise<void>> = []) => {
    let clock = NOW
    const outLines: string[] = []
    const ticks: string[] = []
    let sleeps = 0
    const deps: ObserverDeps = {
      query,
      sleep: async (ms) => { clock += ms; const step = steps[sleeps++]; if (step) await step() },
      now: () => clock,
      out: (l) => outLines.push(l),
      tick: (l) => ticks.push(l),
    }
    return { deps, outLines, ticks, sleeps: () => sleeps }
  }
  const opts = { intervalMs: 5000, timeoutMs: 60_000 }

  it('needs an order id or a start time', async () => {
    await expect(runObserver(script(async () => []).deps, opts)).rejects.toThrow(/order id or a watch start/)
  })

  it('stops after five failed polls in a row with exit code 2, and a success in between resets the count', async () => {
    const down = script(async () => { throw new Error('HTTP 502') })
    const r = await runObserver(down.deps, { ...opts, orderId: ORDER_ID })
    expect(r).toMatchObject({ exitCode: 2, reason: 'the database could not be read' })
    expect(down.outLines.filter((l) => l.includes('POLL    failed'))).toHaveLength(5)
    expect(down.sleeps()).toBe(4)

    let calls = 0
    const flaky = script(async () => {
      calls++
      if (calls % 2 === 1) throw new Error('timeout')
      return [{ snapshot: { ...JSON.parse(JSON.stringify({ now: iso(NOW), order: order({ status: 'completed' }), history: [], wallet: [], providers: [provider()], heartbeats: [], lease: null, open_cases: 0, outbox: [] })) } }]
    })
    const r2 = await runObserver(flaky.deps, { ...opts, orderId: ORDER_ID })
    expect(r2.exitCode).toBe(1) // reached a final state (the money checks fail on this synthetic order), the failures did not stop it
    expect(flaky.outLines.some((l) => l.includes('failed (1/5)'))).toBe(true)
  })

  it('a refusal from the read-only guard is fatal at once: no retries', async () => {
    const t = script(async () => { throw new Error('refused: not a single read-only SELECT: with o as (') })
    const r = await runObserver(t.deps, { ...opts, orderId: ORDER_ID })
    expect(r).toMatchObject({ exitCode: 2, reason: 'the read-only guard refused the statement' })
    expect(t.sleeps()).toBe(0)
  })

  it('gives up at the timeout and says what state the order was in; it never reports success without a final state', async () => {
    const t = script(async () => [{ snapshot: { now: iso(NOW), order: order(), history: [], wallet: [], providers: [provider()], heartbeats: [], lease: null, open_cases: 0, outbox: [] } }])
    const r = await runObserver(t.deps, { intervalMs: 5000, timeoutMs: 20_000, orderId: ORDER_ID })
    expect(r).toMatchObject({ exitCode: 2, reason: 'timeout' })
    expect(t.outLines.join('\n')).toMatch(/TIMEOUT after 20s: the order is still "submitted"\. Nothing was changed by this tool\./)
  })

  it('--once prints one snapshot and stops, with or without an order', async () => {
    const t = script(async () => [{ snapshot: { now: iso(NOW), order: null, history: [], wallet: [], providers: [provider()], heartbeats: [], lease: null, open_cases: 0, outbox: [] } }])
    const r = await runObserver(t.deps, { ...opts, since: '2026-10-09T11:59:30Z', once: true })
    expect(r).toMatchObject({ exitCode: 0, reason: 'single snapshot' })
    expect(t.sleeps()).toBe(0)
    expect(t.ticks).toHaveLength(1)
  })

  it('every statement it sends is a single read-only SELECT', async () => {
    const sent: string[] = []
    const t = script(async (sql) => { sent.push(sql); return [{ snapshot: { now: iso(NOW), order: null, history: [], wallet: [], providers: [], heartbeats: [], lease: null, open_cases: 0, outbox: [] } }] })
    await runObserver(t.deps, { intervalMs: 5000, timeoutMs: 15_000, since: '2026-10-09T11:59:30Z' })
    expect(sent.length).toBeGreaterThan(2)
    for (const sql of sent) expect(() => assertReadOnly(sql)).not.toThrow()
  })
})

describe('against the real schema: a whole flight test, observed', () => {
  let db: PGlite
  let user: string, providerId: string, serviceId: string
  let offer: { id: string; provider_id: string; provider_service_id: string }
  let n = 0
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, any>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    user = await one<string>(`insert into users(telegram_id, is_admin) values (4242, true) returning id v`)
    await db.query(`select process_wallet_transaction($1::uuid, 'manual_adjustment', 10, null, 'fund', 'fund-1')`, [user])
    providerId = await one<string>(`insert into providers(name, api_url, is_active, routing_enabled, health_status, provider_balance, last_balance_sync, last_health_check)
                                    values ('Flight Panel', 'https://p.invalid', true, true, 'healthy', 5, now(), now()) returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'Views', 0.05, 1, 100000) returning id v`, [providerId])
    serviceId = await one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'Views', $2, 0.15, 1, 100000) returning id v`, [cat, ps])
    offer = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [serviceId]))[0] as typeof offer
  }, 180_000)

  const beat = async () => {
    await db.query(`select record_worker_heartbeat('sync-order-status', true, null, 100)`)
    await db.query(`select record_worker_heartbeat('provider-health-monitor', true, null, 80)`)
  }
  const place = async () => one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/ch/1', 100, $3::uuid, $4::uuid, $5::uuid, 0.005::numeric, $6)`,
    [user, serviceId, offer.id, offer.provider_id, offer.provider_service_id, `obs-${++n}`])
  const set = (id: string, sql: string) => db.query(`update orders set ${sql} where id = $1`, [id])

  /** The transport the CLI has, with the database enforcing what the guard promises: every poll runs in a READ ONLY transaction. */
  const readOnlyQuery = async (sql: string) => {
    await db.exec('begin read only')
    try { return (await db.query(sql)).rows } finally { await db.exec('rollback') }
  }
  const harness = (steps: Array<() => void | Promise<void>>, timeoutMs = 10 * 60_000) => {
    let clock = Date.now()
    const outLines: string[] = []
    let i = 0
    const deps: ObserverDeps = {
      query: readOnlyQuery,
      sleep: async (ms) => { clock += ms; const s = steps[i++]; if (s) await s() },
      now: () => clock,
      out: (l) => outLines.push(l),
      tick: () => {},
    }
    return { deps, outLines, text: () => outLines.join('\n'), timeoutMs }
  }

  it('the snapshot query runs on the real schema and returns the whole picture in one row', async () => {
    await beat()
    const id = await place()
    await set(id, `status = 'processing'`)
    await set(id, `status = 'submitted', provider_order_id = 'P-77'`)
    const rowsOut = await readOnlyQuery(snapshotQuery({ orderId: id }))
    expect(rowsOut).toHaveLength(1)
    const s = parseSnapshot(rowsOut)
    expect(s.order).toMatchObject({ id, status: 'submitted', provider_order_id: 'P-77', quantity: 100, effective_provider_id: providerId })
    expect([s.order!.charge_amount, s.order!.cost_amount, s.order!.profit_amount]).toEqual([0.015, 0.005, 0.01])
    expect(s.history.map((h) => h.new_status)).toEqual(['draft', 'awaiting_payment', 'paid', 'processing', 'submitted'])
    expect(s.wallet).toHaveLength(1)
    expect(s.wallet[0]).toMatchObject({ type: 'purchase', status: 'completed', amount: -0.015 })
    expect(s.providers.map((p) => p.name)).toEqual(['Flight Panel'])
    expect(s.heartbeats.map((h) => h.worker)).toEqual(['provider-health-monitor', 'sync-order-status'])
    expect(s.heartbeats.every((h) => h.last_success_at !== null)).toBe(true)
    expect(JSON.stringify(rowsOut)).not.toMatch(/api_key|token/i)
    // no order matches: the order is null but the system is still reported
    const none = parseSnapshot(await readOnlyQuery(snapshotQuery({ orderId: '99999999-9999-4999-8999-999999999999' })))
    expect(none.order).toBeNull()
    expect(none.providers).toHaveLength(1)
    expect(none.history).toEqual([])
  })

  it('watch mode finds the first order created after the start time and ignores older ones', async () => {
    const old = await place()
    const future = new Date(Date.now() + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
    expect(parseSnapshot(await readOnlyQuery(snapshotQuery({ since: future }))).order).toBeNull()
    const past = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z')
    expect(parseSnapshot(await readOnlyQuery(snapshotQuery({ since: past }))).order).not.toBeNull()
    expect(old).toBeTruthy()
  })

  it('a clean flight: waits for the order, locks on, follows it to completed, exits 0 with a clean verdict', async () => {
    await beat()
    let id = ''
    const h = harness([
      async () => { id = await place(); await beat() },
      async () => { await set(id, `status = 'processing'`); await set(id, `status = 'submitted', provider_order_id = 'P-100'`); await beat() },
      async () => { await set(id, `status = 'in_progress', start_count = 5, remains = 100`); await beat() },
      async () => { await set(id, `status = 'completed', remains = 0`); await beat() },
    ])
    const r = await runObserver(h.deps, { intervalMs: 5000, timeoutMs: h.timeoutMs, since: new Date().toISOString() })
    const text = h.text()
    expect(r.exitCode, text).toBe(0)
    expect(text).toContain('waiting for a new order')
    expect(text).toContain(`locked on order ${id}`)
    expect(text).toContain('draft -> awaiting_payment')
    expect(text).toContain('submitted -> in_progress')
    expect(text).toContain('in_progress -> completed')
    expect(text).toContain('provider_order_id: - -> P-100')
    expect(text).toMatch(/WALLET {2}\S+ purchase -\$0\.015 \(completed\)/)
    expect(text).toContain('[PASS] exactly one purchase entry of -$0.015')
    expect(text).toContain('RESULT  CLEAN: the flight test passed')
    expect(text).not.toContain('[CRIT]')
    expect(r.verdict!.ok).toBe(true)
  })

  it('the circuit breaker tripping on an in-flight order is caught as critical, shown closing, and fails the verdict', async () => {
    await beat()
    const id = await place()
    await set(id, `status = 'processing'`)
    await set(id, `status = 'submitted', provider_order_id = 'P-200'`)
    const h = harness([
      async () => { await db.query(`select record_provider_sync_result($1::uuid, false)`, [providerId]); await beat() },
      async () => { await db.query(`select record_provider_sync_result($1::uuid, true)`, [providerId]); await beat() },
      async () => { await set(id, `status = 'completed', remains = 0`); await beat() },
    ])
    const r = await runObserver(h.deps, { intervalMs: 5000, timeoutMs: h.timeoutMs, orderId: id })
    const text = h.text()
    expect(r.exitCode, text).toBe(1)
    expect(text).toMatch(/BREAKER Flight Panel: failed polls in a row 0 -> 1/)
    expect(text).toMatch(/BREAKER Flight Panel: OPEN until \d\d:\d\d:\d\d UTC/)
    expect(text).toMatch(/\[CRIT\] circuit breaker OPEN for Flight Panel until \d\d:\d\d:\d\d UTC \(1 failed polls in a row\): the order is NOT being polled meanwhile/)
    expect(text).toContain('BREAKER Flight Panel: closed')
    expect(text).toContain('[OK]   cleared: breaker_open')
    expect(text).toContain('[FAIL] critical finding(s) during the run: breaker_open')
    expect(text).toContain('RESULT  ATTENTION')
  })

  it('a stale sync worker is flagged critical while the order waits', async () => {
    const id = await place()
    await set(id, `status = 'processing'`)
    await set(id, `status = 'submitted', provider_order_id = 'P-300'`)
    await db.exec(`update worker_heartbeats set last_success_at = now() - interval '10 minutes' where worker = 'sync-order-status'`)
    const h = harness([
      async () => { await beat() },
      async () => { await set(id, `status = 'completed', remains = 0`) },
    ])
    const r = await runObserver(h.deps, { intervalMs: 5000, timeoutMs: h.timeoutMs, orderId: id })
    const text = h.text()
    expect(text).toMatch(/\[CRIT\] sync-order-status last succeeded 10m ago/)
    expect(text).toContain('[OK]   cleared: sync_stale')
    expect(r.exitCode).toBe(1)
  })

  it('an order the provider cancels is followed through the refund; the money checks pass but the verdict says it did not complete', async () => {
    await beat()
    const id = await place()
    await set(id, `status = 'processing'`)
    await set(id, `status = 'submitted', provider_order_id = 'P-400'`)
    const h = harness([
      async () => { await set(id, `status = 'canceled', error_message = 'needs_refund: provider canceled order'`); await beat() },
      async () => { await db.query(`select refund_order($1::uuid, null, 'provider canceled')`, [id]); await beat() },
    ])
    const r = await runObserver(h.deps, { intervalMs: 5000, timeoutMs: h.timeoutMs, orderId: id })
    const text = h.text()
    expect(r.exitCode, text).toBe(1)
    expect(text).toContain('submitted -> canceled')
    expect(text).toContain('[WARN] a refund is owed and the sync worker will book it')
    expect(text).toMatch(/WALLET {2}\S+ refund \+\$0\.015 \(completed\)/)
    expect(text).toContain('canceled -> refunded')
    expect(text).toContain('[FAIL] final status is "refunded"')
    expect(text).toContain('[PASS] refunds add up to the charge ($0.015 of $0.015)')
    expect(text).not.toContain('[FAIL] exactly one purchase')
  })

  it('an order held for reconciliation is critical and the observer waits (it does not decide anything)', async () => {
    await beat()
    const id = await place()
    await set(id, `status = 'processing', error_message = 'needs_reconciliation: timeout: add: no response within 10000ms'`)
    const h = harness([])
    const r = await runObserver(h.deps, { intervalMs: 60_000, timeoutMs: 120_000, orderId: id })
    expect(r.exitCode).toBe(2)
    expect(h.text()).toMatch(/\[CRIT\] the order is held for a human: needs_reconciliation: timeout/)
    expect(h.text()).toContain('TIMEOUT after 2m: the order is still "processing"')
  })

  it('the observer changed nothing: every poll ran in a READ ONLY transaction (the database would have refused a write)', async () => {
    await db.exec('begin read only')
    await expect(db.query(`update orders set status = 'completed'`)).rejects.toThrow(/read-only transaction/)
    await db.exec('rollback')
  })
})

describe('the command-line tool', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/observe-live-test.ts'), 'utf8')
  const lib = fs.readFileSync(path.join(ROOT, 'scripts/lib/live-observer.ts'), 'utf8')

  it('has exactly one network call: the Management API SQL endpoint, behind the read-only guard', () => {
    expect(src.match(/\bfetch\(/g)).toHaveLength(1)
    expect(src).toContain('/database/query')
    expect(src).toContain('assertReadOnly(sql)')
    expect(src.match(/method: '/g)).toEqual(["method: '"])
    expect(src).toContain("method: 'POST'") // the SQL endpoint takes the statement in a POST body; there is no other request
    expect(src).not.toMatch(/\/secrets|\/api-keys|service_role|SERVICE_ROLE|\/functions\/v1|\/rest\/v1|\.rpc\(/)
  })

  it('keeps the access token out of the output', () => {
    expect(src).toContain('registerSecret(env.SUPABASE_ACCESS_TOKEN)')
    expect(src).not.toMatch(/console\.(log|error)\([^)]*(ACCESS_TOKEN|env\b)/)
    expect(src).toContain('sanitizeText(')
  })

  it('exits through process.exitCode (process.exit aborts inside libuv on Windows while fetch\'s socket closes)', () => {
    expect(src).toContain('process.exitCode = result.exitCode')
  })

  it('the pure library has no I/O of its own', () => {
    expect(lib).not.toMatch(/\bfetch\(|node:fs|node:child_process|process\.env|process\.stdout|console\./)
    expect(lib).toContain("import { assertReadOnly } from './live-smoke.ts'")
  })

  it('refuses bad arguments before it reads any file or opens any connection (exit code 2)', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/observe-live-test.ts', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
    for (const [args, message] of [
      [['--order', 'not-a-uuid'], /--order must be the order's UUID/],
      [['--interval', '1'], /--interval must be a number >= 2/],
      [['--timeout', 'abc'], /--timeout must be a number >= 1/],
      [['--stuck-after', '0'], /--stuck-after must be a number >= 1/],
    ] as const) {
      const r = run(...args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stderr).toMatch(message)
      expect(r.stderr).toContain('Nothing was observed and nothing was changed.')
    }
  })
})
