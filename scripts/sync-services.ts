// Registers the premium panels (Secsers, MoreThanPanel) on your Supabase project and imports their catalogues through sync-catalog, the dripfeed flag
// of each service included. A panel with routing off is only ever synced by id: the scheduled rotation skips it until routing is on.
//
//   npm run sync-services                     # create what is missing, import the catalogue of every panel that has a key
//   npm run sync-services -- --register-only  # create what is missing, import nothing
//
// The order for a new panel: its API key (admin panel, or npm run secrets:rotate -- provider-key --provider <name> --store db --apply), this script
// (imports the catalogue), routing on in the admin panel, this script again: with routing on a run also publishes the panel's services as cards. A
// run publishes a bounded number of them, so the script repeats it until nothing is left.
// Reads SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and CRON_SECRET from .env.local. Never prints a value.

import { existsSync, readFileSync } from 'node:fs'
import { parseEnvFile } from './lib/env-checks.ts'
import { ensurePanelsSql, PREMIUM_PANELS, readSyncAnswer, type PanelRow, type SyncAnswer } from './lib/sync-services.ts'

const file = '.env.local'
if (!existsSync(file)) {
  console.error(`sync-services: ${file} not found.`)
  process.exit(1)
}
const env = parseEnvFile(readFileSync(file, 'utf8'))
const registerOnly = process.argv.includes('--register-only')
const { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: ref, CRON_SECRET: cron } = env
if (!token || !ref || (!registerOnly && !cron)) {
  console.error('sync-services: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and CRON_SECRET must be set in .env.local.')
  process.exit(1)
}

const BUSY_RETRIES = 10
const BUSY_WAIT_MS = 30_000
/** A catalogue can be tens of thousands of services; the function gives up by itself well before this. */
const SYNC_TIMEOUT_MS = 170_000

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: ensurePanelsSql(PREMIUM_PANELS) }),
})
if (!res.ok) {
  console.error(`sync-services: could not register the panels (HTTP ${res.status}). Has the migration 20261225000000 been applied?`)
  process.exit(1)
}
const panels = (await res.json()) as PanelRow[]
for (const p of panels) console.log(`${p.name}: registered, key ${p.has_key ? 'set' : 'not set'}, routing ${p.routing_enabled ? 'on' : 'off'}`)
if (registerOnly) process.exit(0)

async function syncOnce(providerId: string): Promise<{ status: number; body: SyncAnswer | null }> {
  const r = await fetch(`https://${ref}.supabase.co/functions/v1/sync-catalog`, {
    method: 'POST',
    headers: { 'x-cron-secret': cron!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as SyncAnswer | null }
}

let failed = 0
for (const panel of panels) {
  let busy = 0
  let lastBacklog = Number.POSITIVE_INFINITY
  for (;;) {
    const { status, body } = await syncOnce(panel.id)
    const outcome = readSyncAnswer(panel.name, status, body)
    if (outcome.kind === 'busy') {
      if (++busy > BUSY_RETRIES) {
        console.log(`${panel.name}: FAILED (another catalogue run did not finish in time; run this again)`)
        failed++
        break
      }
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
      continue
    }
    console.log(outcome.line)
    if (outcome.kind === 'failed') failed++
    // what is left of the catalogue goes in the next run, as long as a run gets anywhere
    if (outcome.kind !== 'ok' || outcome.backlog === 0 || outcome.backlog >= lastBacklog) break
    lastBacklog = outcome.backlog
  }
}
if (failed > 0) process.exitCode = 1
