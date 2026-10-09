// Live smoke test, pure part: judges a read-only snapshot of production against a rollout stage (docs/LAUNCH_PLAN.md).
// No I/O here: scripts/live-smoke-test.ts collects the snapshot, this decides PASS / WARN / FAIL and what is missing.
//
// A check that the target stage NEEDS fails; a check that only matters for a later stage warns.

import { createHash } from 'node:crypto'
import { providerKeyEnvName } from '../../supabase/functions/_shared/secrets.ts'

export type Stage = 0 | 1 | 2 | 3 | 4 | 5
export type CheckStatus = 'PASS' | 'WARN' | 'FAIL'
export type CheckGroup = 'infra' | 'secrets' | 'provider' | 'treasury' | 'cron'

export interface CheckResult {
  group: CheckGroup
  id: string
  status: CheckStatus
  message: string
  /** What to do, shown for WARN / FAIL. */
  fix?: string
}

export const STAGES: Record<Stage, string> = {
  0: 'Internal MOCK',
  1: 'Real provider connected, no real deposits',
  2: 'Real micro-deposit',
  3: 'One real micro-order',
  4: 'Provider payments with $1 limits',
  5: 'Full production',
}

/** Stage 4 caps a single provider payment at this many USD (the plan's "strict $1 limits"). */
export const STAGE4_MAX_TOPUP = 1
export const HEARTBEAT_MAX_AGE_MIN = 15
export const QUARANTINE_RESERVE = 999_999_999

export interface ProviderRow {
  name: string
  is_active: boolean
  routing_enabled: boolean
  health_status: string
  last_health_check: string | null
  has_db_key: boolean
  has_wallet: boolean
  max_topup_per_tx: number | string | null
  max_daily_topup: number | string | null
}

export interface Snapshot {
  now: number
  db: { ok: boolean; latencyMs: number | null; error?: string }
  settings: { global_orders_enabled: boolean; global_payments_enabled: boolean; maintenance_mode: boolean; minimum_treasury_reserve: number | string } | null
  treasuryBalance: number | string | null
  /** Edge Function secret names, and the SHA-256 digests the Management API reports (used only to recognise MOCK_MODE=true). */
  secrets: { names: string[]; digests: Record<string, string> } | null
  providers: ProviderRow[]
  heartbeats: { worker: string; last_success_at: string | null; last_error_at: string | null; last_error: string | null }[]
  /** pg_cron jobs with their last successful run (null: pg_cron not readable). */
  cronJobs: { name: string; active: boolean; last_success_at: string | null }[] | null
  /** HTTP status of an unauthenticated POST to each Edge Function (null: no answer). */
  functions: Record<string, number | null>
}

export const EDGE_FUNCTIONS = [
  'telegram-auth', 'place-order', 'create-deposit', 'verify-deposit', 'sync-catalog', 'sync-order-status', 'provider-health-monitor',
  'admin-pricing', 'admin-treasury', 'admin-analytics', 'admin-settings', 'admin-reconciliation', 'admin-observability',
] as const
const DEPOSIT_FUNCTIONS = ['create-deposit', 'verify-deposit']
/** An unauthenticated POST must be refused by the function itself: proof it booted and checks auth (nothing is written). */
const ALIVE = new Set([400, 401, 403, 405])

// ---------------------------------------------------------------------------
// Read-only guard for every SQL statement the tool runs
// ---------------------------------------------------------------------------

const WRITE_WORDS = /\b(insert|update|delete|merge|upsert|alter|drop|create|grant|revoke|truncate|call|copy|vacuum|reindex|cluster|lock|comment|security|refresh|nextval|setval|set_config|pg_sleep|dblink|cron\.schedule|cron\.unschedule|vault\.)\b|\bdo\s*\$|;/i

/** Throws unless the statement is one plain SELECT (or WITH ... SELECT) without any writing construct. */
export function assertReadOnly(sql: string): string {
  const s = sql.trim()
  if (!/^(select|with)\b/i.test(s) || WRITE_WORDS.test(s)) throw new Error(`refused: not a single read-only SELECT: ${s.slice(0, 60)}`)
  return s
}

/** The only statements the tool runs. All are covered by assertReadOnly and executed against the real schema in tests. */
export const QUERIES = {
  settings: `select global_orders_enabled, global_payments_enabled, maintenance_mode, minimum_treasury_reserve from public.platform_settings where id = 1`,
  treasury: `select balance from public.treasury_state where id = 1`,
  providers: `select name, is_active, routing_enabled, health_status::text as health_status, last_health_check,
                     api_key_encrypted is not null as has_db_key, allowed_destination_wallet is not null as has_wallet,
                     max_topup_per_tx, max_daily_topup
                from public.providers order by priority desc, name`,
  heartbeats: `select worker, last_success_at, last_error_at, last_error from public.worker_heartbeats order by worker`,
  cronAvailable: `select to_regclass('cron.job_run_details') is not null as available`,
  cron: `select j.jobname as name, j.active,
                (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'succeeded'
                    and d.start_time > now() - interval '2 days') as last_success_at
           from cron.job j order by j.jobname`,
} as const

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')
const minutesAgo = (iso: string | null, now: number) => (iso ? Math.floor((now - Date.parse(iso)) / 60_000) : null)
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export function evaluate(s: Snapshot, stage: Stage): CheckResult[] {
  const out: CheckResult[] = []
  const need = (minStage: Stage) => stage >= minStage
  const add = (group: CheckGroup, id: string, ok: boolean, requiredFrom: Stage, pass: string, problem: string, fix: string) =>
    out.push(ok ? { group, id, status: 'PASS', message: pass } : { group, id, status: need(requiredFrom) ? 'FAIL' : 'WARN', message: problem, fix })

  // ---- 1. Infra ------------------------------------------------------------------------------------
  add('infra', 'db', s.db.ok, 0, `Database reachable${s.db.latencyMs !== null ? ` (${s.db.latencyMs} ms)` : ''}`,
    `Database not reachable${s.db.error ? `: ${s.db.error}` : ''}`, 'Check SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF and the project status in the dashboard.')
  const core = EDGE_FUNCTIONS.filter((f) => !DEPOSIT_FUNCTIONS.includes(f))
  const down = core.filter((f) => !ALIVE.has(s.functions[f] ?? -1))
  add('infra', 'functions', down.length === 0, 0, `${core.length} Edge Functions answer and refuse unauthenticated calls`,
    `Not answering correctly: ${down.map((f) => `${f} (${s.functions[f] ?? 'no answer'})`).join(', ')}`, 'Redeploy: npx supabase functions deploy (then check the function logs).')
  const depDown = DEPOSIT_FUNCTIONS.filter((f) => !ALIVE.has(s.functions[f] ?? -1))
  add('infra', 'deposit-functions', depDown.length === 0, 2, 'Deposit functions are configured (create-deposit / verify-deposit)',
    `Deposits are switched off at the server: ${depDown.map((f) => `${f} (${s.functions[f] ?? 'no answer'})`).join(', ')}`,
    'Upload TON_RECIPIENT_ADDRESS and TON_NETWORK: npm run secrets:push (see LAUNCH_PLAN stage 2).')

  const st = s.settings
  if (!st) {
    out.push({ group: 'infra', id: 'switches', status: 'FAIL', message: 'platform_settings cannot be read', fix: 'Apply the migrations: npx supabase db push.' })
  } else {
    const quarantined = Number(st.minimum_treasury_reserve) >= QUARANTINE_RESERVE
    if (quarantined) {
      out.push({ group: 'infra', id: 'quarantine', status: 'FAIL', message: 'The emergency quarantine is active (treasury reserve at 999999999)', fix: 'Lift it only when the incident is closed: docs/RUNBOOK.md, "Lifting the quarantine".' })
    }
    add('infra', 'maintenance', !st.maintenance_mode, 2, 'Maintenance mode is off', 'Maintenance mode is ON: every order and deposit is refused', 'Admin -> Controls -> Maintenance Mode off.')
    add('infra', 'payments-switch', st.global_payments_enabled, 2, 'Global payments (deposits) enabled', 'Global payments are OFF: deposits are refused', 'Admin -> Controls -> Global Payments on.')
    add('infra', 'orders-switch', st.global_orders_enabled, 3, 'Global orders enabled', 'Global orders are OFF: orders are refused', 'Admin -> Controls -> Global Orders on.')
  }

  // ---- 2. Secrets (names only) ---------------------------------------------------------------------
  if (!s.secrets) {
    out.push({ group: 'secrets', id: 'list', status: 'FAIL', message: 'The Edge Function secrets cannot be listed', fix: 'The access token needs the project\'s secrets read permission.' })
  } else {
    const has = (n: string) => s.secrets!.names.includes(n)
    const missing = ['JWT_SECRET', 'TELEGRAM_BOT_TOKEN', 'CRON_SECRET'].filter((n) => !has(n))
    add('secrets', 'core', missing.length === 0, 0, 'JWT_SECRET, TELEGRAM_BOT_TOKEN, CRON_SECRET are set', `Missing: ${missing.join(', ')}`, 'Fill .env.local, then npm run secrets:push.')
    const encrypted = s.providers.some((p) => p.has_db_key)
    add('secrets', 'provider-key-secret', has('PROVIDER_KEY_SECRET'), encrypted ? 1 : 5, 'PROVIDER_KEY_SECRET is set',
      `PROVIDER_KEY_SECRET is missing${encrypted ? ': stored provider keys cannot be decrypted' : ''}`, 'Generate 32 random bytes (base64) into .env.local, then npm run secrets:push.')
    const mock = s.secrets.digests.MOCK_MODE === sha256('true')
    if (stage === 0) out.push({ group: 'secrets', id: 'mock-mode', status: 'PASS', message: mock ? 'MOCK_MODE=true (expected in stage 0)' : 'MOCK_MODE is not true: functions talk to real providers' })
    else add('secrets', 'mock-mode', !mock, 1, 'MOCK_MODE is off: real providers are called', 'MOCK_MODE=true: providers are simulated', 'npx supabase secrets unset MOCK_MODE (or set it to false).')
    const ton = ['TON_RECIPIENT_ADDRESS', 'TON_NETWORK'].filter((n) => !has(n))
    add('secrets', 'ton', ton.length === 0, 2, 'TON_RECIPIENT_ADDRESS and TON_NETWORK are set', `Missing: ${ton.join(', ')} (deposits disabled)`, 'Set them in .env.local, then npm run secrets:push.')
    add('secrets', 'toncenter', has('TONCENTER_API_KEY'), 5, 'TONCENTER_API_KEY is set', 'TONCENTER_API_KEY is missing: deposit checks are throttled to about 1 request/s', 'Get a free key from @tonapibot, then npm run secrets:push.')
    add('secrets', 'origin', has('ALLOWED_ORIGIN'), 5, 'ALLOWED_ORIGIN is set (CORS restricted to the app)', 'ALLOWED_ORIGIN is missing: functions accept any origin', 'Set ALLOWED_ORIGIN to the Vercel URL, then npm run secrets:push.')
  }

  // ---- 3. Provider -----------------------------------------------------------------------------------
  const keyOf = (p: ProviderRow) => p.has_db_key || (s.secrets?.names.includes(providerKeyEnvName(p.name)) ?? false)
  const live = s.providers.filter((p) => p.is_active && p.routing_enabled)
  const ready = live.filter((p) => p.health_status === 'healthy' && keyOf(p) && (minutesAgo(p.last_health_check, s.now) ?? Infinity) <= HEARTBEAT_MAX_AGE_MIN)
  add('provider', 'routing', ready.length > 0, 1, `${ready.length} provider(s) active, routing, healthy and keyed: ${ready.map((p) => p.name).join(', ')}`,
    s.providers.length === 0 ? 'No provider is configured'
      : live.length === 0 ? 'No provider is active with routing enabled'
        : `No routing provider is ready: ${live.map((p) => `${p.name} (${[p.health_status !== 'healthy' && p.health_status, !keyOf(p) && 'no API key', (minutesAgo(p.last_health_check, s.now) ?? Infinity) > HEARTBEAT_MAX_AGE_MIN && 'not checked in 15 min'].filter(Boolean).join(', ')})`).join('; ')}`,
    'Admin -> Providers: add the provider, its API key (npm run secrets:rotate -- provider-key ...), enable routing; the health monitor marks it healthy within a minute.')
  const payout = ready.filter((p) => p.has_wallet && num(p.max_topup_per_tx) !== null && num(p.max_daily_topup) !== null)
  add('provider', 'payout-limits', payout.length > 0, 4, `Payout wallet and both limits set: ${payout.map((p) => `${p.name} ($${num(p.max_topup_per_tx)}/tx, $${num(p.max_daily_topup)}/day)`).join(', ')}`,
    'No ready provider has a payout wallet and both limits (top-ups are refused)', 'Admin -> Providers -> Edit Config -> Payouts.')
  if (stage === 4) {
    const loose = payout.filter((p) => Number(p.max_topup_per_tx) > STAGE4_MAX_TOPUP || Number(p.max_daily_topup) > STAGE4_MAX_TOPUP)
    add('provider', 'stage4-limits', loose.length === 0, 4, `Every payout limit is at most $${STAGE4_MAX_TOPUP} (stage 4)`,
      `Limits above $${STAGE4_MAX_TOPUP} in stage 4: ${loose.map((p) => p.name).join(', ')}`, `Set max per top-up and max per day to ${STAGE4_MAX_TOPUP} until stage 5.`)
  }

  // ---- 4. Treasury -----------------------------------------------------------------------------------
  const reserve = st ? Number(st.minimum_treasury_reserve) : 0
  const balance = num(s.treasuryBalance) ?? 0
  add('treasury', 'reserve', reserve > 0, 4, `Minimum treasury reserve set ($${reserve})`, 'The minimum treasury reserve is 0 (nothing protects the last dollars)', 'Admin -> Treasury -> Set reserve.')
  add('treasury', 'balance', balance > reserve && reserve < QUARANTINE_RESERVE, 4, `Treasury balance $${balance} is above the reserve`,
    `Treasury balance $${balance} does not exceed the reserve $${reserve}: every provider top-up is refused`, 'Fund the treasury: Admin -> Treasury -> Manual Adjustment.')

  // ---- 5. Cron -----------------------------------------------------------------------------------------
  for (const w of ['provider-health-monitor', 'sync-order-status']) {
    const hb = s.heartbeats.find((h) => h.worker === w)
    const age = minutesAgo(hb?.last_success_at ?? null, s.now)
    const failing = hb?.last_error_at && (!hb.last_success_at || Date.parse(hb.last_error_at) > Date.parse(hb.last_success_at))
    add('cron', w, age !== null && age <= HEARTBEAT_MAX_AGE_MIN && !failing, 1, `${w} completed ${age === 0 ? 'this minute' : `${age} min ago`}`,
      !hb ? `${w} has never reported a heartbeat` : failing ? `${w} is failing: ${hb.last_error ?? 'unknown error'}` : `${w} has not completed for ${age} min`,
      'Check cron.job and the function logs (docs/RUNBOOK.md, C3).')
  }
  if (s.cronJobs === null) {
    out.push({ group: 'cron', id: 'sync-reconciliation-cases', status: 'WARN', message: 'pg_cron cannot be read: the reconciliation detector cannot be checked', fix: 'Run the check with an owner token, or look at cron.job_run_details in the SQL editor.' })
  } else {
    const job = s.cronJobs.find((j) => j.name === 'sync-reconciliation-cases')
    const age = minutesAgo(job?.last_success_at ?? null, s.now)
    add('cron', 'sync-reconciliation-cases', !!job && job.active && age !== null && age <= HEARTBEAT_MAX_AGE_MIN, 1,
      `Reconciliation detector ran ${age} min ago`, !job ? 'The sync-reconciliation-cases job does not exist' : !job.active ? 'The sync-reconciliation-cases job is disabled' : `The reconciliation detector has not succeeded for ${age ?? 'ever'} min`,
      'npx supabase db push (migration 20261027000000 creates it), then check cron.job_run_details.')
  }
  const catalog = s.heartbeats.find((h) => h.worker === 'sync-catalog')
  const catAge = minutesAgo(catalog?.last_success_at ?? null, s.now)
  add('cron', 'sync-catalog', catAge !== null && catAge <= 90, 5, `sync-catalog completed ${catAge} min ago`,
    catalog ? `sync-catalog has not completed for ${catAge} min` : 'sync-catalog has not reported yet (it runs every hour)', 'Trigger it once (DEPLOYMENT.md 1.6) or wait for the next hourly run.')

  return out
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function summarize(results: CheckResult[]): { pass: number; warn: number; fail: number; ready: boolean } {
  const count = (st: CheckStatus) => results.filter((r) => r.status === st).length
  return { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), ready: count('FAIL') === 0 }
}

export function formatReport(results: CheckResult[], stage: Stage, project: string): string {
  const lines = [`GTHE PR live smoke test: project ${project}, target stage ${stage} (${STAGES[stage]}), read-only`, '']
  let group = ''
  for (const r of results) {
    if (r.group !== group) {
      group = r.group
      lines.push(`  ${group.toUpperCase()}`)
    }
    lines.push(`  [${r.status}] ${r.id.padEnd(26)} ${r.message}`)
    if (r.fix && r.status !== 'PASS') lines.push(`  ${''.padEnd(34)}-> ${r.fix}`)
  }
  const sum = summarize(results)
  lines.push('', `Summary: ${sum.pass} pass, ${sum.warn} warn, ${sum.fail} fail.`)
  if (sum.ready) lines.push(`READY for stage ${stage}.${sum.warn > 0 ? ' Warnings concern later stages.' : ''}`)
  else {
    lines.push(`NOT READY for stage ${stage}. Missing:`)
    for (const r of results.filter((x) => x.status === 'FAIL')) lines.push(`  - ${r.message}${r.fix ? `  ->  ${r.fix}` : ''}`)
  }
  return lines.join('\n')
}
