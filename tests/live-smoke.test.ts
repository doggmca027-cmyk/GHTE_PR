import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import {
  EDGE_FUNCTIONS,
  QUERIES,
  STAGE4_MAX_TOPUP,
  assertReadOnly,
  evaluate,
  formatReport,
  summarize,
  type CheckResult,
  type Snapshot,
  type Stage,
} from '../scripts/lib/live-smoke.ts'

const ROOT = path.resolve(__dirname, '..')
const NOW = Date.parse('2026-10-08T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const digest = (v: string) => createHash('sha256').update(v).digest('hex')

/** Production today: live and healthy, but no provider, no TON secrets, empty treasury. */
function prodToday(): Snapshot {
  const names = ['JWT_SECRET', 'TELEGRAM_BOT_TOKEN', 'CRON_SECRET', 'PROVIDER_KEY_SECRET', 'TONCENTER_API_KEY', 'ALLOWED_ORIGIN']
  return {
    now: NOW,
    db: { ok: true, latencyMs: 120 },
    settings: { global_orders_enabled: true, global_payments_enabled: true, maintenance_mode: false, minimum_treasury_reserve: '0.0000' },
    treasuryBalance: '0.0000',
    secrets: { names, digests: Object.fromEntries(names.map((n) => [n, digest(n)])) },
    providers: [],
    heartbeats: [
      { worker: 'provider-health-monitor', last_success_at: ago(0), last_error_at: null, last_error: null },
      { worker: 'sync-order-status', last_success_at: ago(0), last_error_at: null, last_error: null },
    ],
    cronJobs: [{ name: 'sync-reconciliation-cases', active: true, last_success_at: ago(3) }],
    functions: Object.fromEntries(EDGE_FUNCTIONS.map((f) => [f, f === 'create-deposit' ? 503 : f === 'verify-deposit' ? 500 : 401])),
  }
}

/** Everything a full launch needs. */
function fullyReady(): Snapshot {
  const s = prodToday()
  const names = [...s.secrets!.names, 'TON_RECIPIENT_ADDRESS', 'TON_NETWORK']
  s.secrets = { names, digests: Object.fromEntries(names.map((n) => [n, digest(n)])) }
  s.functions = Object.fromEntries(EDGE_FUNCTIONS.map((f) => [f, 401]))
  s.providers = [{ name: 'Panel', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: ago(1), has_db_key: true, has_wallet: true, max_topup_per_tx: '50.0000', max_daily_topup: '200.0000' }]
  s.settings = { ...s.settings!, minimum_treasury_reserve: '25.0000' }
  s.treasuryBalance = '500.0000'
  s.heartbeats.push({ worker: 'sync-catalog', last_success_at: ago(120), last_error_at: null, last_error: null })
  return s
}

const byId = (r: CheckResult[]) => Object.fromEntries(r.map((x) => [`${x.group}.${x.id}`, x.status]))
const fails = (s: Snapshot, stage: Stage) => evaluate(s, stage).filter((r) => r.status === 'FAIL').map((r) => `${r.group}.${r.id}`)

describe('read-only guard', () => {
  it('every query the tool runs is a single read-only SELECT', () => {
    for (const [name, sql] of Object.entries(QUERIES)) expect(() => assertReadOnly(sql), name).not.toThrow()
  })

  it('anything that could write, lock, wait or run a second statement is refused before it is sent', () => {
    for (const bad of [
      'insert into users default values', 'update platform_settings set maintenance_mode = true', 'delete from orders',
      'select 1; drop table users', 'with x as (update providers set name = name returning 1) select * from x',
      "select set_config('a', 'b', false)", 'select pg_sleep(10)', "select cron.schedule('x', '* * * * *', 'select 1')",
      'do $$ begin end $$', 'create table t (a int)', 'truncate orders', 'select nextval(\'s\')', "select vault.create_secret('x')",
      'copy users to stdout', 'explain analyze delete from users', 'lock table users',
    ]) expect(() => assertReadOnly(bad), bad).toThrow(/refused/)
  })

  it('the CLI sends SQL only through the guard and no other write path exists in it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/live-smoke-test.ts'), 'utf8')
    expect(src).toContain('JSON.stringify({ query: assertReadOnly(sql) })')
    expect(src.match(/database\/query/g)).toHaveLength(1)
    expect(src).not.toMatch(/method: '(PUT|PATCH|DELETE)'/)
    expect(src).not.toMatch(/\/secrets`, \{[^}]*method/) // the secrets endpoint is only read (GET)
  })
})

describe('the queries run against the real schema', () => {
  it('settings, treasury, providers, heartbeats; cron is reported unavailable without pg_cron and readable with it', async () => {
    const db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into providers(name, api_url, routing_enabled, health_status, allowed_destination_wallet, max_topup_per_tx, max_daily_topup)
                   values ('Panel', 'https://p', true, 'healthy', '0:${'ab'.repeat(32)}', 1, 1);
                   select record_worker_heartbeat('sync-order-status', true, null, 10);`)
    const run = async (sql: string) => (await db.query<Record<string, unknown>>(assertReadOnly(sql))).rows
    expect((await run(QUERIES.settings))[0]).toMatchObject({ global_orders_enabled: true, maintenance_mode: false })
    expect(await run(QUERIES.treasury)).toHaveLength(1)
    expect((await run(QUERIES.providers))[0]).toMatchObject({ name: 'Panel', has_db_key: false, has_wallet: true, health_status: 'healthy' })
    expect((await run(QUERIES.heartbeats))[0]).toMatchObject({ worker: 'sync-order-status' })
    expect((await run(QUERIES.cronAvailable))[0]).toEqual({ available: false })
    await db.exec(`create schema cron;
      create table cron.job (jobid bigserial primary key, jobname text, active boolean default true);
      create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, start_time timestamptz);
      insert into cron.job(jobname) values ('sync-reconciliation-cases');
      insert into cron.job_run_details(jobid, status, start_time) values (1, 'succeeded', now() - interval '3 minutes'), (1, 'failed', now());`)
    expect((await run(QUERIES.cronAvailable))[0]).toEqual({ available: true })
    const cron = await run(QUERIES.cron)
    expect(cron[0]).toMatchObject({ name: 'sync-reconciliation-cases', active: true })
    expect(cron[0].last_success_at).toBeTruthy() // the later failed run is not a success
  }, 120_000)
})

describe('stage gates', () => {
  it('production today: ready for stage 0; stage 1 is blocked only by the missing provider', () => {
    expect(fails(prodToday(), 0)).toEqual([])
    expect(fails(prodToday(), 1)).toEqual(['provider.routing'])
    const warn = evaluate(prodToday(), 1).filter((r) => r.status === 'WARN').map((r) => `${r.group}.${r.id}`)
    expect(warn).toEqual(expect.arrayContaining(['infra.deposit-functions', 'secrets.ton', 'treasury.reserve', 'treasury.balance', 'cron.sync-catalog']))
  })

  it('stage 2 needs the deposit secrets and the deposit functions configured', () => {
    const s = prodToday()
    s.providers = fullyReady().providers
    expect(fails(s, 2)).toEqual(['infra.deposit-functions', 'secrets.ton'])
  })

  it('a fully configured production is ready for stage 5 with nothing left to warn about', () => {
    const r = evaluate(fullyReady(), 5)
    expect(r.filter((x) => x.status !== 'PASS')).toEqual([])
    expect(summarize(r).ready).toBe(true)
  })

  it('stage 4 refuses payout limits above $1; stage 5 accepts normal ones', () => {
    expect(byId(evaluate(fullyReady(), 4))['provider.stage4-limits']).toBe('FAIL')
    const s = fullyReady()
    s.providers[0].max_topup_per_tx = STAGE4_MAX_TOPUP
    s.providers[0].max_daily_topup = '1.0000'
    expect(fails(s, 4)).toEqual([])
    expect(byId(evaluate(fullyReady(), 5))).not.toHaveProperty('provider.stage4-limits')
  })

  it('the switches gate the stages that need them', () => {
    const s = fullyReady()
    s.settings = { ...s.settings!, global_orders_enabled: false }
    expect(fails(s, 2)).toEqual([])
    expect(fails(s, 3)).toEqual(['infra.orders-switch'])
    s.settings = { ...s.settings, maintenance_mode: true }
    expect(fails(s, 2)).toEqual(['infra.maintenance'])
  })

  it('recognises MOCK_MODE=true from its digest alone, and the active quarantine', () => {
    const s = fullyReady()
    s.secrets!.names.push('MOCK_MODE')
    s.secrets!.digests.MOCK_MODE = digest('true')
    expect(fails(s, 1)).toEqual(['secrets.mock-mode'])
    expect(fails(s, 0)).toEqual([]) // expected in stage 0
    s.secrets!.digests.MOCK_MODE = digest('false')
    expect(fails(s, 1)).toEqual([])
    const q = fullyReady()
    q.settings = { ...q.settings!, minimum_treasury_reserve: '999999999.0000', maintenance_mode: true, global_orders_enabled: false, global_payments_enabled: false }
    expect(fails(q, 1)).toContain('infra.quarantine')
  })

  it('a provider must be healthy, keyed and recently checked; a key in a function secret counts', () => {
    const s = fullyReady()
    s.providers[0].health_status = 'unavailable'
    expect(evaluate(s, 1).find((r) => r.id === 'routing')!.message).toMatch(/Panel \(unavailable\)/)
    const k = fullyReady()
    k.providers[0].has_db_key = false
    expect(evaluate(k, 1).find((r) => r.id === 'routing')!.message).toMatch(/no API key/)
    k.secrets!.names.push('PROVIDER_PANEL_API_KEY')
    expect(fails(k, 1)).toEqual([])
    const old = fullyReady()
    old.providers[0].last_health_check = ago(40)
    expect(evaluate(old, 1).find((r) => r.id === 'routing')!.message).toMatch(/not checked in 15 min/)
  })

  it('stale or failing heartbeats, a missing detector job and dead functions fail', () => {
    const s = fullyReady()
    s.heartbeats[0] = { worker: 'provider-health-monitor', last_success_at: ago(20), last_error_at: null, last_error: null }
    s.heartbeats[1] = { worker: 'sync-order-status', last_success_at: ago(2), last_error_at: ago(0), last_error: 'batch query failed' }
    s.cronJobs = []
    s.functions['place-order'] = 500
    s.functions['admin-treasury'] = null
    const f = fails(s, 1)
    expect(f).toEqual(['infra.functions', 'cron.provider-health-monitor', 'cron.sync-order-status', 'cron.sync-reconciliation-cases'])
    const msg = evaluate(s, 1).map((r) => r.message).join('\n')
    expect(msg).toContain('place-order (500), admin-treasury (no answer)')
    expect(msg).toContain('sync-order-status is failing: batch query failed')
  })

  it('an unreachable database fails everything it can, and still reports', () => {
    const s = prodToday()
    s.db = { ok: false, latencyMs: null, error: 'HTTP 401' }
    s.settings = null
    expect(fails(s, 0)).toEqual(expect.arrayContaining(['infra.db', 'infra.switches']))
  })
})

describe('report', () => {
  it('prints [PASS] / [WARN] / [FAIL] lines, the fix for each problem and what is missing for the stage', () => {
    const out = formatReport(evaluate(prodToday(), 1), 1, 'abcdefghijklmnopqrst')
    expect(out).toMatch(/^GTHE PR live smoke test: project abcdefghijklmnopqrst, target stage 1 \(Real provider connected, no real deposits\), read-only/)
    expect(out).toMatch(/\[PASS\] db\s+Database reachable \(120 ms\)/)
    expect(out).toMatch(/\[FAIL\] routing\s+No provider is configured/)
    expect(out).toMatch(/\[WARN\] ton/)
    expect(out).toContain('-> Admin -> Providers')
    expect(out).toContain('NOT READY for stage 1. Missing:')
    expect(formatReport(evaluate(fullyReady(), 5), 5, 'x')).toContain('READY for stage 5.')
  })

  it('never prints a secret digest', () => {
    const s = fullyReady()
    const out = formatReport(evaluate(s, 5), 5, 'x')
    for (const d of Object.values(s.secrets!.digests)) expect(out).not.toContain(d)
  })
})

describe('live-smoke-test CLI fails safely', () => {
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts/live-smoke-test.ts'), ...args], { cwd, encoding: 'utf8', timeout: 30_000 })
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-'))

  it('without .env.local: exit 2, a [FAIL] setup line, nothing checked', () => {
    const r = run(dir())
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/\[FAIL\] setup\s+\.env\.local not found/)
    expect(r.stderr).toContain('Nothing was checked, nothing was changed.')
  })

  it('names exactly the variables that are missing', () => {
    const d = dir()
    fs.writeFileSync(path.join(d, '.env.local'), 'SUPABASE_PROJECT_REF=abcdefghijklmnopqrst\n')
    const r = run(d)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('missing in .env.local: SUPABASE_ACCESS_TOKEN, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY')
  })

  it('refuses an unknown stage', () => {
    expect(run(dir(), '--stage', '9').stderr).toMatch(/--stage must be 0, 1, 2, 3, 4 or 5/)
  })

  it('is wired as npm run smoke:live', () => {
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['smoke:live']).toContain('scripts/live-smoke-test.ts')
  })
})

describe('LAUNCH_PLAN.md', () => {
  const plan = fs.readFileSync(path.join(ROOT, 'docs/LAUNCH_PLAN.md'), 'utf8')
  const sections = plan.split(/^## /m).filter((s) => /^STAGE \d/.test(s))

  it('defines stages 0 to 5, each with entry criteria, verification, exit criteria and rollback', () => {
    expect(sections.map((s) => s.slice(0, 7))).toEqual(['STAGE 0', 'STAGE 1', 'STAGE 2', 'STAGE 3', 'STAGE 4', 'STAGE 5'])
    for (const s of sections) for (const part of ['**Entry criteria:**', '**Verification:**', '**Exit criteria:**', '**Rollback:**']) expect(s, `${s.slice(0, 7)} ${part}`).toContain(part)
  })

  it('every gate uses the live smoke test for its own stage', () => {
    for (const [i, s] of sections.entries()) {
      if (i === 5) expect(s).toContain('npm run smoke:live')
      else expect(s).toContain(`npm run smoke:live -- --stage ${i}`)
    }
  })

  it('every npm script and file it refers to exists', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>
    for (const m of plan.matchAll(/npm run ([a-z:]+)/g)) expect(scripts, m[1]).toHaveProperty(m[1])
    for (const m of plan.matchAll(/\(([A-Z_]+\.md)\)/g)) expect(fs.existsSync(path.join(ROOT, 'docs', m[1])), m[1]).toBe(true)
    expect(fs.existsSync(path.join(ROOT, 'supabase/scripts/emergency_quarantine.sql'))).toBe(true)
  })

  it('stage 4 is capped at the same $1 the smoke test enforces', () => {
    expect(sections[4]).toContain('**max per top-up = 1**')
    expect(sections[4]).toContain('**max per day = 1**')
    expect(STAGE4_MAX_TOPUP).toBe(1)
  })
})
