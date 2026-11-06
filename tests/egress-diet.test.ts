// The egress diet (docs/proposals/egress-diet.sql). Why: the free plan of Supabase allows 5 GB of egress a month; on 2026-11-06 the project was restricted
// (HTTP 402 exceed_egress_quota). pg_stat_statements showed 1.58 million REST requests since 2026-10-06 and ~95% of them were the project's own scheduled
// workers (the app of the customers: under 1%). The proposal slows the health monitor and lets the order sync and the notifier fire every minute only when
// they have work. What is fixed here: a skipped run is a run that would have found nothing (the gates test what the workers look for), the System Health
// screen is not made to cry "late" by the slower cadence, and the proposal can be undone.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPECTED_JOBS } from '../supabase/functions/_shared/observability'

const root = path.resolve(import.meta.dirname, '..')
const proposal = fs.readFileSync(path.join(root, 'docs/proposals/egress-diet.sql'), 'utf8')
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).sort().map((f) => ({ f, sql: fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8') }))

/** The text of the LAST migration that defines this function (a later one replaces an earlier one). */
const lastDefinition = (name: string): string => {
  const defs = migrations.filter((m) => new RegExp(`function\\s+public\\.${name}\\s*\\(`, 'i').test(m.sql))
  const sql = defs[defs.length - 1]!.sql
  const at = sql.search(new RegExp(`function\\s+public\\.${name}\\s*\\(`, 'i'))
  return sql.slice(at, at + 3000)
}

/** The part of the proposal before its optional and rollback blocks: what would really be applied. */
const applied = proposal.slice(0, proposal.indexOf('-- check:'))

describe('1. a skipped run would have found nothing: the gates test what the workers look for', () => {
  it('the order sync fires when an order is in flight, paid, or owes a refund: the states get_order_sync_batch, unfunded_orders_summary and expire_stale_paid_orders read', () => {
    const batch = lastDefinition('get_order_sync_batch')
    for (const status of ['submitted', 'in_progress', 'processing']) {
      expect(batch, status).toContain(`'${status}'`)
      expect(applied, status).toContain(`'${status}'`)
    }
    expect(batch).toContain("'needs_refund")
    expect(applied).toContain("o.error_message like 'needs_refund%'")
    // the hub (unfunded orders) and the one-hour expiry both read status = 'paid'
    expect(applied).toContain("'paid'")
    expect(applied).toContain("o.status in ('canceled', 'failed')")
  })

  it('the notifier fires when claim_notification_batch would find a due row: the same two conditions', () => {
    const claim = lastDefinition('claim_notification_batch')
    expect(claim).toMatch(/status\s*=\s*'pending'/)
    expect(claim).toMatch(/next_attempt_at\s*<=\s*now\(\)/)
    expect(applied).toContain("status = 'pending' and next_attempt_at <= now()")
  })

  it('both still run on every 10th minute whatever the state: that run is their heartbeat and the hub / stale-order stages', () => {
    expect(applied.match(/extract\(minute from now\(\)\)::int % 10 = 0/g)).toHaveLength(2)
  })

  it('the health monitor is every 5 minutes; nothing else about it changes', () => {
    expect(applied).toMatch(/jobname = 'provider-health-monitor'\),\s*schedule => '\*\/5 \* \* \* \*'/)
  })

  it('the commands keep the call they made: the same functions, the secret from the vault, the same timeouts', () => {
    expect(applied).toContain("functions/v1/sync-order-status', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{}'::jsonb, timeout_milliseconds := 120000)")
    expect(applied).toContain("functions/v1/telegram-notifier', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{}'::jsonb, timeout_milliseconds := 60000)")
    expect(proposal).not.toMatch(/x-cron-secret['"]\s*,\s*'[A-Za-z0-9_-]{16,}'/) // no secret written in the file
  })
})

describe('2. System Health does not call the slower workers late', () => {
  const job = (name: string) => EXPECTED_JOBS.find((j) => j.name === name)!

  it('the health monitor: every 5 minutes, late after 15 (three missed runs)', () => {
    expect(job('provider-health-monitor')).toMatchObject({ everyMinutes: 5, lateAfterMinutes: 15 })
  })
  it('the order sync and the notifier: the idle gap is 10 minutes, so "late" comes well after it (and the order sync stays critical)', () => {
    expect(job('sync-order-status')).toMatchObject({ everyMinutes: 10, lateAfterMinutes: 15, critical: true })
    expect(job('telegram-notifier')).toMatchObject({ everyMinutes: 10, lateAfterMinutes: 25, critical: false })
    for (const name of ['provider-health-monitor', 'sync-order-status', 'telegram-notifier']) {
      expect(job(name).lateAfterMinutes, name).toBeGreaterThan(job(name).everyMinutes)
    }
  })
  it('the catalog sync: every 15 minutes (the owner\'s decision), late only after five runs of silence', () => {
    expect(job('sync-catalog')).toMatchObject({ everyMinutes: 15, lateAfterMinutes: 75, critical: false })
  })
  it('the jobs that did not change keep their thresholds', () => {
    expect(job('sync-reconciliation-cases')).toMatchObject({ everyMinutes: 5, lateAfterMinutes: 12 })
    expect(job('notify-admin-anomalies')).toMatchObject({ everyMinutes: 5, lateAfterMinutes: 12 })
  })
})

describe('3. it can be undone, and nothing is applied by this file being in the repository', () => {
  it('the rollback block restores the every-minute commands and the old schedules', () => {
    const rollback = proposal.slice(proposal.lastIndexOf('-- ROLLBACK (back to'))
    expect(rollback).toContain("schedule => '* * * * *'")
    expect(rollback).toContain('functions/v1/sync-order-status')
    expect(rollback).toContain('functions/v1/telegram-notifier')
    expect(rollback).not.toContain('extract(minute from now())') // the rollback has no gate
    expect(rollback).toContain("schedule => '*/5 * * * *'") // sync-catalog
  })
  it('it is one transaction; the catalog sync is every 15 minutes (the owner\'s decision) and fill-storefront-gaps is left as it was', () => {
    expect(applied).toMatch(/^begin;$/m)
    expect(applied).toMatch(/^commit;$/m)
    expect(applied).toMatch(/jobname = 'sync-catalog'\),\s*schedule => '\*\/15 \* \* \* \*'/)
    expect(applied).not.toContain("jobname = 'fill-storefront-gaps'")
    expect(proposal).toContain("-- select cron.alter_job((select jobid from cron.job where jobname = 'fill-storefront-gaps'), schedule => '2-59/30 * * * *');")
  })
  it('the rotation hands a provider out when it was last synced over 50 minutes ago: every 15 minutes is enough to keep every provider within ~75 minutes', () => {
    expect(lastDefinition('claim_catalog_sync_provider')).toContain('p_due_minutes integer default 50')
  })
  it('the proposal is not a migration: a push does not apply it, the owner says when (it changes how the live order sync is woken)', () => {
    expect(fs.existsSync(path.join(root, 'docs/proposals/egress-diet.sql'))).toBe(true)
    expect(migrations.some((m) => m.sql.includes("extract(minute from now())::int % 10 = 0"))).toBe(false)
  })
})
