// Live flight-test observer (docs/LIVE_TEST_RUNBOOK.md). STRICTLY READ-ONLY: it watches production, it never changes it.
//
//   npm run observe:live                           # waits for the first NEW order, then follows it to the end
//   npm run observe:live -- --order <order-uuid>   # follows one existing order
//   npm run observe:live -- --once                 # one snapshot (providers, workers, breaker) and exit: a pre-flight check
//   options: --interval <seconds>   poll period, default 5 (minimum 2)
//            --timeout <minutes>    give up after this long, default 60
//            --stuck-after <min>    warn when an in-flight order has not changed for this long, default 15
//
// Each poll is ONE SELECT sent to the Management API's SQL endpoint, after assertReadOnly (the guard of `npm run smoke:live`):
// anything that is not a single plain SELECT is refused before it leaves this machine. Every poll shows the order (status,
// provider order id, error), its status history and wallet entries, the sync worker's heartbeat and lease, and the provider's
// circuit breaker (sync_backoff_until, failed polls in a row). The provider's API key is never selected.
//
// Exit code: 0 the order completed and the money adds up; 1 it finished (or was caught) with something to look at;
//            2 the tool could not do its job (database unreadable, timeout, bad arguments).
// Needs in .env.local: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF. Ctrl-C stops it; it prints the last status and exits 130.

import { existsSync, readFileSync } from 'node:fs'
import { parseEnvFile } from './lib/env-checks.ts'
import { assertReadOnly } from './lib/live-smoke.ts'
import { UUID_RE, runObserver, statusLine, type Snapshot } from './lib/live-observer.ts'
import { registerSecret, sanitizeText } from '../supabase/functions/_shared/logger.ts'

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (name: string) => args.includes(name)

function bail(message: string): never {
  console.error(`observe-live-test: ${sanitizeText(message)}`)
  console.error('Nothing was observed and nothing was changed.')
  process.exit(2)
}

const positive = (name: string, fallback: number, min: number): number => {
  const raw = option(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) bail(`${name} must be a number >= ${min}.`)
  return n
}

async function main() {
  const orderId = option('--order')
  if (orderId !== undefined && !UUID_RE.test(orderId)) bail('--order must be the order\'s UUID (Admin -> Orders, or the Orders screen).')
  const intervalMs = positive('--interval', 5, 2) * 1000
  const timeoutMs = positive('--timeout', 60, 1) * 60_000
  const stuckAfterMs = positive('--stuck-after', 15, 1) * 60_000
  const once = flag('--once')

  if (!existsSync('.env.local')) bail('.env.local not found (it must hold SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF).')
  const env = parseEnvFile(readFileSync('.env.local', 'utf8'))
  const missing = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF'].filter((k) => !env[k])
  if (missing.length > 0) bail(`missing in .env.local: ${missing.join(', ')}.`)
  registerSecret(env.SUPABASE_ACCESS_TOKEN)
  const endpoint = `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`

  // The only network call of this tool. assertReadOnly runs on every statement, whatever builds it.
  const query = async (sql: string): Promise<unknown> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: assertReadOnly(sql) }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${sanitizeText(text).slice(0, 160)}`)
    return JSON.parse(text)
  }

  // On a terminal the status line is rewritten in place; in a pipe or a log file it is printed every 30 s.
  const tty = process.stdout.isTTY === true
  let ticks = 0
  let lineOnScreen = false
  const clearLine = () => {
    if (tty && lineOnScreen) process.stdout.write('\r\x1b[K')
    lineOnScreen = false
  }
  let lastTick = ''
  const out = (line: string) => {
    clearLine()
    console.log(sanitizeText(line))
  }
  const tick = (line: string) => {
    lastTick = line
    ticks++
    if (tty) {
      process.stdout.write(`\r\x1b[K${sanitizeText(line.slice(0, Math.max(40, (process.stdout.columns ?? 140) - 1)))}`)
      lineOnScreen = true
    } else if (ticks === 1 || ticks % 6 === 0) {
      console.log(sanitizeText(line))
    }
  }

  process.on('SIGINT', () => {
    clearLine()
    console.log(`\nStopped by you. Last status: ${sanitizeText(lastTick) || '(none yet)'}\nNothing was changed by this tool.`)
    process.exit(130)
  })

  const result = await runObserver(
    { query, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, out, tick },
    // watch mode anchors 30 s before launch: slack for clock skew between this machine and the database
    { orderId, since: orderId ? undefined : new Date(Date.now() - 30_000).toISOString(), intervalMs, timeoutMs, once, stuckAfterMs },
  )
  clearLine()
  if (once && result.snapshot) printSnapshot(result.snapshot)
  // not process.exit(): on Windows it can abort inside libuv while fetch's keep-alive socket is closing
  process.exitCode = result.exitCode
}

function printSnapshot(s: Snapshot) {
  console.log(`\nSnapshot (database clock ${s.now}):`)
  console.log(`  ${sanitizeText(statusLine(s))}`)
  for (const p of s.providers) {
    console.log(`  provider ${sanitizeText(p.name)}: active ${p.is_active}, routing ${p.routing_enabled}, health ${p.health_status}, balance ${p.provider_balance ?? '-'} ${p.currency ?? ''}, breaker until ${p.sync_backoff_until ?? '-'}, failed polls ${p.sync_failure_count}`)
  }
  if (s.providers.length === 0) console.log('  (no provider is configured)')
  for (const h of s.heartbeats) console.log(`  worker ${h.worker}: last success ${h.last_success_at ?? 'never'}, runs ${h.runs}, failures ${h.failures}${h.last_error ? `, last error: ${sanitizeText(h.last_error)}` : ''}`)
}

main().catch((e) => bail(e instanceof Error ? e.message : String(e)))
