// Live readiness check for the staged rollout (docs/LAUNCH_PLAN.md). STRICTLY READ-ONLY.
//
//   npm run smoke:live                 # judge production against stage 5 (full production)
//   npm run smoke:live -- --stage 2    # only what stage 2 needs FAILs; later-stage gaps are WARNs
//   npm run smoke:live -- --json       # machine-readable result
//
// What it touches, and nothing else:
//   * single SELECT statements through the Management API (each one passes assertReadOnly: no write is even sendable);
//   * the list of Edge Function secret NAMES (values are never fetched in clear: the API returns digests, never printed);
//   * one unauthenticated POST {} per Edge Function: each must refuse it (401 / 400), which proves it booted. Nothing is written.
// Exit code: 0 ready for the stage, 1 something the stage needs is missing, 2 the check itself could not run.
// Needs in .env.local: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { existsSync, readFileSync } from 'node:fs'
import { parseEnvFile } from './lib/env-checks.ts'
import { EDGE_FUNCTIONS, QUERIES, assertReadOnly, evaluate, formatReport, summarize, type Snapshot, type Stage } from './lib/live-smoke.ts'
import { registerSecret, sanitizeText } from '../supabase/functions/_shared/logger.ts'

const args = process.argv.slice(2)
const stageArg = args.includes('--stage') ? Number(args[args.indexOf('--stage') + 1]) : 5
const json = args.includes('--json')

function bail(message: string): never {
  console.error(`[FAIL] setup                      ${sanitizeText(message)}`)
  console.error('\nThe live smoke test could not run. Nothing was checked, nothing was changed.')
  process.exit(2)
}

async function main() {
  if (![0, 1, 2, 3, 4, 5].includes(stageArg)) bail('--stage must be 0, 1, 2, 3, 4 or 5.')
  const stage = stageArg as Stage
  if (!existsSync('.env.local')) bail('.env.local not found (it must hold SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).')
  const env = parseEnvFile(readFileSync('.env.local', 'utf8'))
  const missing = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter((k) => !env[k])
  if (missing.length > 0) bail(`missing in .env.local: ${missing.join(', ')}.`)
  registerSecret(env.SUPABASE_ACCESS_TOKEN, env.VITE_SUPABASE_ANON_KEY)
  const ref = env.SUPABASE_PROJECT_REF
  const api = `https://api.supabase.com/v1/projects/${ref}`
  const auth = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }

  const select = async <T,>(sql: string): Promise<T[]> => {
    const res = await fetch(`${api}/database/query`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: assertReadOnly(sql) }), signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${sanitizeText(text).slice(0, 200)}`)
    return JSON.parse(text) as T[]
  }
  const optional = async <T,>(sql: string): Promise<T[] | null> => select<T>(sql).catch(() => null)

  // 1. database (one round trip timed), then everything else in parallel
  const snapshot: Snapshot = { now: Date.now(), db: { ok: false, latencyMs: null }, settings: null, treasuryBalance: null, secrets: null, providers: [], heartbeats: [], cronJobs: null, functions: {} }
  const t0 = Date.now()
  try {
    snapshot.settings = (await select<NonNullable<Snapshot['settings']>>(QUERIES.settings))[0] ?? null
    snapshot.db = { ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    snapshot.db = { ok: false, latencyMs: null, error: e instanceof Error ? e.message : String(e) }
  }

  const [treasury, providers, heartbeats, cronAvailable, secrets] = await Promise.all([
    optional<{ balance: number }>(QUERIES.treasury),
    optional<Snapshot['providers'][number]>(QUERIES.providers),
    optional<Snapshot['heartbeats'][number]>(QUERIES.heartbeats),
    optional<{ available: boolean }>(QUERIES.cronAvailable),
    fetch(`${api}/secrets`, { headers: auth, signal: AbortSignal.timeout(30_000) })
      .then(async (r) => (r.ok ? ((await r.json()) as { name: string; value: string }[]) : null))
      .catch(() => null),
  ])
  snapshot.treasuryBalance = treasury?.[0]?.balance ?? null
  snapshot.providers = providers ?? []
  snapshot.heartbeats = heartbeats ?? []
  snapshot.cronJobs = cronAvailable?.[0]?.available ? await optional<NonNullable<Snapshot['cronJobs']>[number]>(QUERIES.cron) : null
  snapshot.secrets = secrets ? { names: secrets.map((s) => s.name), digests: Object.fromEntries(secrets.map((s) => [s.name, s.value])) } : null

  // Edge Functions: an unauthenticated POST {} must be REFUSED by the function itself (it booted, it checks auth).
  const base = env.VITE_SUPABASE_URL.replace(/\/$/, '')
  await Promise.all(EDGE_FUNCTIONS.map(async (fn) => {
    try {
      const res = await fetch(`${base}/functions/v1/${fn}`, {
        method: 'POST', headers: { apikey: env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000),
      })
      await res.body?.cancel()
      snapshot.functions[fn] = res.status
    } catch {
      snapshot.functions[fn] = null
    }
  }))

  const results = evaluate(snapshot, stage)
  if (json) console.log(JSON.stringify({ stage, project: ref, ...summarize(results), results }, null, 2))
  else console.log(formatReport(results, stage, ref))
  process.exit(summarize(results).ready ? 0 : 1)
}

main().catch((e) => bail(e instanceof Error ? e.message : String(e)))
