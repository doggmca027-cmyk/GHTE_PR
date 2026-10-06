import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  alertFor,
  balanceAction,
  classifyPingError,
  isBalanceParseError,
  sanitizeBalance,
  runHealthChecks,
  type AlertKind,
  type HealthLogEntry,
  type HealthPorts,
  type MonitoredProvider,
} from '../supabase/functions/_shared/health-monitor.ts'
import { ServiceUnavailableError, selectBestOffer } from '../supabase/functions/_shared/routing.ts'
import { SMMProviderError } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { buildMessage } from '../supabase/functions/_shared/telegram-notify.ts'
import type { HealthStatus, IProvider, IProviderServiceOffer } from '../supabase/functions/_shared/types.ts'

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('alertFor', () => {
  it('alerts only on healthy/degraded -> unavailable and unavailable -> healthy', () => {
    expect(alertFor('healthy', 'unavailable')).toBe('down')
    expect(alertFor('degraded', 'unavailable')).toBe('down')
    expect(alertFor('unavailable', 'healthy')).toBe('recovered')
  })
  it('is silent for the first promotion, no change and other moves', () => {
    expect(alertFor('disabled', 'healthy')).toBeNull()
    expect(alertFor('disabled', 'unavailable')).toBeNull()
    expect(alertFor('healthy', 'healthy')).toBeNull()
    expect(alertFor('unavailable', 'unavailable')).toBeNull()
    expect(alertFor('degraded', 'healthy')).toBeNull()
  })
})

describe('classifyPingError', () => {
  it('treats timeouts, network, 5xx, bad keys and garbage as unavailable', () => {
    expect(classifyPingError(new SMMProviderError('timeout', 'x'))).toEqual({ status: 'unavailable', label: 'timeout' })
    expect(classifyPingError(new SMMProviderError('network', 'x'))).toEqual({ status: 'unavailable', label: 'network' })
    expect(classifyPingError(new SMMProviderError('http', 'x', { httpStatus: 503 }))).toEqual({ status: 'unavailable', label: 'http 503' })
    expect(classifyPingError(new SMMProviderError('api', 'x', { code: 'invalid_api_key' })).status).toBe('unavailable')
    expect(classifyPingError(new Error('boom'))).toEqual({ status: 'unavailable', label: 'unexpected' })
  })
  it('does not count rate limiting as an outage', () => {
    expect(classifyPingError(new SMMProviderError('http', 'x', { code: 'rate_limited', httpStatus: 429 })).status).toBe('inconclusive')
  })
  it('never puts the provider message into the label', () => {
    expect(classifyPingError(new SMMProviderError('api', 'secret-key-abc leaked')).label).toBe('api')
  })
})

describe('balance alert rules (pure)', () => {
  it('alerts at or below the threshold only when the lock is open, resets above it', () => {
    expect(balanceAction(10, 10, false)).toBe('alert')
    expect(balanceAction(3, 10, false)).toBe('alert')
    expect(balanceAction(3, 10, true)).toBe('none')
    expect(balanceAction(10.0001, 10, true)).toBe('reset')
    expect(balanceAction(500, 10, false)).toBe('none')
  })
  it('sanitizes readings', () => {
    expect(sanitizeBalance({ balance: 12.345678, currency: ' usd ' })).toEqual({ balance: 12.3457, currency: 'USD' })
    expect(sanitizeBalance({ balance: 5, currency: '??' })).toEqual({ balance: 5, currency: null })
    for (const bad of [Number.NaN, Infinity, 1e12, '5', null, undefined]) expect(sanitizeBalance({ balance: bad })).toBeNull()
  })
  it('only an unreadable balance field is a parse error, not a real outage', () => {
    expect(isBalanceParseError(new SMMProviderError('invalid_response', 'Field "balance" is not a number'))).toBe(true)
    expect(isBalanceParseError(new SMMProviderError('invalid_response', 'balance: expected an object'))).toBe(true)
    expect(isBalanceParseError(new SMMProviderError('invalid_response', 'balance: response is not valid JSON'))).toBe(false)
    expect(isBalanceParseError(new SMMProviderError('timeout', 'balance: no response'))).toBe(false)
    expect(isBalanceParseError(new Error('x'))).toBe(false)
  })
  it('low-balance text', () => {
    expect(buildMessage({ type: 'provider_low_balance', providerName: 'Panel A', balance: 4.5, currency: 'USD' }, 'en')).toBe('⚠️ <b>Provider Panel A balance is critically low:</b> 4.50 USD.')
    expect(buildMessage({ type: 'provider_low_balance', providerName: 'A', balance: 4.5, currency: 'USD' }, 'uk')).toContain('критично низький')
    expect(buildMessage({ type: 'provider_low_balance', providerName: '<i>x</i>', balance: 1, currency: 'USD' }, 'en')).not.toContain('<i>')
  })
})

describe('alert text', () => {
  it('matches the agreed wording in English and Ukrainian, and escapes the name', () => {
    expect(buildMessage({ type: 'provider_health', providerName: 'Panel A', status: 'unavailable' }, 'en')).toBe('🚨 <b>Provider Panel A is UNAVAILABLE</b>\nTraffic is routed to fallback.')
    expect(buildMessage({ type: 'provider_health', providerName: 'Panel A', status: 'healthy' }, 'en')).toBe('✅ <b>Provider Panel A is back ONLINE</b>\nRouting restored.')
    expect(buildMessage({ type: 'provider_health', providerName: 'A', status: 'unavailable' }, 'uk')).toContain('НЕДОСТУПНИЙ')
    expect(buildMessage({ type: 'provider_health', providerName: '<b>x</b>', status: 'healthy' }, 'en')).not.toContain('<b>x</b>')
  })
})

// ---------------------------------------------------------------------------
// Worker against a real schema (PGlite): status updates, dedup and failover
// ---------------------------------------------------------------------------

const A = '00000000-0000-0000-0000-0000000000a2'
const B = '00000000-0000-0000-0000-0000000000b2'
const C = '00000000-0000-0000-0000-0000000000c2'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const PS = { [A]: '00000000-0000-0000-0000-000000000a01', [B]: '00000000-0000-0000-0000-000000000b01' } as Record<string, string>

async function world() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  await db.exec(`
    insert into providers(id, name, api_url, is_active, routing_enabled, health_status) values
      ('${A}', 'A', 'https://a', true, true, 'healthy'),
      ('${B}', 'B', 'https://b', true, true, 'healthy'),
      ('${C}', 'C', 'https://c', true, false, 'disabled');   -- routing off: never monitored
    insert into categories(id, platform, name, slug) values ('00000000-0000-0000-0000-0000000000c1', 'telegram', 'Views', 'views');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
      ('${PS[A]}', '${A}', '1', 'A views', 0.1, 100, 50000),
      ('${PS[B]}', '${B}', '9', 'B views', 0.07, 100, 50000);
    insert into services(id, category_id, name, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      values ('${SVC}', '00000000-0000-0000-0000-0000000000c1', 'Views', '${PS[A]}', '${PS[B]}', 0.4, 100, 50000);
    delete from provider_service_offers;
    insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
      ('${SVC}', '${A}', '${PS[A]}', 0.1, 100, 50000, 100),
      ('${SVC}', '${B}', '${PS[B]}', 0.07, 100, 50000, 0);`)
  return db
}

interface Row extends MonitoredProvider { }

/** Ports backed by the real database; ping outcome and notifications are scripted by the test. */
interface Script {
  down: Set<string>
  throwing?: Set<string>
  hang?: Set<string>
  /** Balance each provider reports (default 500 USD); NaN simulates an unreadable balance field. */
  balance?: Record<string, number>
  /** Telegram could not deliver the low-balance alert to anyone. */
  undelivered?: boolean
}

function portsFor(db: PGlite, script: Script) {
  const lowBalance: { name: string; balance: number; currency: string }[] = []
  const alerts: { name: string; kind: AlertKind }[] = []
  const pings: string[] = []
  const ports: HealthPorts<Row> = {
    async listProviders() {
      return (await db.query<{ id: string; name: string; health_status: HealthStatus }>(`select id, name, health_status from providers where is_active and routing_enabled order by name`)).rows
        .map((r) => ({ id: r.id, name: r.name, healthStatus: r.health_status }))
    },
    async ping(p) {
      pings.push(p.id)
      if (script.hang?.has(p.id)) return new Promise<void>(() => {})
      if (script.throwing?.has(p.id)) throw new Error('unhandled boom')
      if (script.down.has(p.id)) throw new SMMProviderError('http', 'x', { httpStatus: 503 })
      const balance = script.balance?.[p.id] ?? 500
      return { balance, currency: 'usd' }
    },
    async saveBalance(p, r, at) {
      const rows = (await db.query<{ t: string; a: boolean; c: string }>(
        `update providers set provider_balance = $2, last_balance_sync = $3, currency = coalesce($4, currency) where id = $1 returning low_balance_threshold::text t, balance_alert_sent a, currency c`,
        [p.id, r.balance, at, r.currency])).rows[0]
      return { threshold: Number(rows.t), alertSent: rows.a, currency: rows.c }
    },
    async setBalanceAlertSent(p, from, to) {
      return (await db.query(`update providers set balance_alert_sent = $3 where id = $1 and balance_alert_sent = $2 returning id`, [p.id, from, to])).rows.length > 0
    },
    async notifyLowBalance(p, r) {
      if (script.undelivered) return false
      lowBalance.push({ name: p.name, balance: r.balance, currency: r.currency })
      return true
    },
    async applyCheck(p, from, to, at) {
      if (from === to) {
        await db.query(`update providers set last_health_check = $2 where id = $1`, [p.id, at])
        return 'unchanged'
      }
      const r = await db.query(`update providers set health_status = $3, last_health_check = $4 where id = $1 and health_status = $2 returning id`, [p.id, from, to, at])
      return r.rows.length > 0 ? 'changed' : 'lost_race'
    },
    async appendLog(e: HealthLogEntry) {
      await db.query(`insert into provider_health_log(provider_id, status, previous_status, latency_ms, error_kind, checked_at) values ($1,$2,$3,$4,$5,$6)`,
        [e.providerId, e.status, e.previousStatus, e.latencyMs, e.errorKind, e.checkedAt])
    },
    async notify(p, kind) { alerts.push({ name: p.name, kind }) },
    pingTimeoutMs: 50,
  }
  return { ports, alerts, pings, lowBalance }
}

const statusOf = async (db: PGlite, id: string) => (await db.query<{ s: string }>(`select health_status::text s from providers where id = $1`, [id])).rows[0].s

/** What place-order does: load offers + providers from the DB, then select. */
async function routeNow(db: PGlite): Promise<IProviderServiceOffer> {
  const offers = (await db.query<Record<string, unknown>>(`select * from provider_service_offers where service_id = '${SVC}'`)).rows.map((r): IProviderServiceOffer => ({
    id: String(r.id), serviceId: String(r.service_id), providerId: String(r.provider_id), providerServiceId: String(r.provider_service_id),
    costPer1000: Number(r.cost_per_1000), minQuantity: Number(r.min_quantity), maxQuantity: Number(r.max_quantity),
    refillSupported: false, cancelSupported: false, isActive: r.is_active === true, routingScore: Number(r.routing_score), createdAt: 't', updatedAt: 't',
  }))
  const providers = (await db.query<Record<string, unknown>>(`select * from providers`)).rows.map((p): IProvider => ({
    id: String(p.id), name: String(p.name), apiUrl: String(p.api_url), apiVersion: 'v2', isActive: p.is_active === true, routingEnabled: p.routing_enabled === true,
    healthStatus: p.health_status as HealthStatus, lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0,
  }))
  return selectBestOffer(offers, providers, { quantity: 1000 })
}

describe('provider-health-monitor core', () => {
  let db: PGlite
  beforeEach(async () => { db = await world() }, 120_000)

  it('keeps healthy providers healthy, stamps last_health_check, never alerts', async () => {
    const { ports, alerts } = portsFor(db, { down: new Set() })
    const report = await runHealthChecks(ports)
    expect(report).toMatchObject({ checked: 2, healthy: 2, unavailable: 0, alerts: 0, errors: 0 })
    expect(alerts).toEqual([])
    const r = (await db.query<{ n: number }>(`select count(*)::int n from providers where last_health_check is not null and id in ('${A}','${B}')`)).rows[0]
    expect(r.n).toBe(2)
  })

  it('only monitors active, routing-enabled providers', async () => {
    const { ports, pings } = portsFor(db, { down: new Set() })
    await runHealthChecks(ports)
    expect(pings.sort()).toEqual([A, B])
    expect(await statusOf(db, C)).toBe('disabled')
  })

  it('marks a failing provider unavailable and alerts exactly once across repeated ticks', async () => {
    const { ports, alerts } = portsFor(db, { down: new Set([A]) })
    await runHealthChecks(ports)
    expect(await statusOf(db, A)).toBe('unavailable')
    expect(await statusOf(db, B)).toBe('healthy')
    expect(alerts).toEqual([{ name: 'A', kind: 'down' }])

    // next cron ticks: still down, nothing new to say
    for (let i = 0; i < 3; i++) {
      const r = await runHealthChecks(ports)
      expect(r.alerts).toBe(0)
    }
    expect(alerts).toHaveLength(1)
  })

  it('alerts once on recovery and restores the status', async () => {
    const script = { down: new Set([A]) }
    const { ports, alerts } = portsFor(db, script)
    await runHealthChecks(ports)
    script.down.clear()
    await runHealthChecks(ports)
    await runHealthChecks(ports)
    expect(await statusOf(db, A)).toBe('healthy')
    expect(alerts).toEqual([{ name: 'A', kind: 'down' }, { name: 'A', kind: 'recovered' }])
  })

  it('promotes a never-checked provider silently', async () => {
    await db.exec(`update providers set health_status = 'disabled' where id = '${A}'`)
    const { ports, alerts } = portsFor(db, { down: new Set() })
    await runHealthChecks(ports)
    expect(await statusOf(db, A)).toBe('healthy')
    expect(alerts).toEqual([])
  })

  it('two overlapping runs produce a single alert (compare-and-set)', async () => {
    const { ports, alerts } = portsFor(db, { down: new Set([A]) })
    await Promise.all([runHealthChecks(ports), runHealthChecks(ports)])
    expect(await statusOf(db, A)).toBe('unavailable')
    expect(alerts).toHaveLength(1)
  })

  it('a provider that throws or hangs does not stop the batch', async () => {
    const { ports, alerts } = portsFor(db, { down: new Set(), throwing: new Set([A]), hang: new Set([B]) })
    const report = await runHealthChecks(ports)
    expect(report.checked).toBe(2)
    expect(report.unavailable).toBe(2)
    expect(report.errors).toBe(0)
    expect(report.providers.find((p) => p.name === 'B')?.errorKind).toBe('timeout') // bounded by the monitor even when the ping hangs
    expect(alerts.map((a) => a.name).sort()).toEqual(['A', 'B'])
  })

  it('a database failure for one provider is reported and does not affect the others', async () => {
    const { ports } = portsFor(db, { down: new Set() })
    const original = ports.applyCheck
    ports.applyCheck = async (p, from, to, at) => {
      if (p.name === 'A') throw new Error('db down')
      return original(p, from, to, at)
    }
    const report = await runHealthChecks(ports)
    expect(report.errors).toBe(1)
    expect(report.healthy).toBe(1)
  })

  it('rate limiting leaves the status untouched and sends nothing', async () => {
    const { ports, alerts } = portsFor(db, { down: new Set() })
    ports.ping = async () => { throw new SMMProviderError('http', 'x', { code: 'rate_limited', httpStatus: 429 }) }
    const report = await runHealthChecks(ports)
    expect(report.inconclusive).toBe(2)
    expect(await statusOf(db, A)).toBe('healthy')
    expect(alerts).toEqual([])
  })

  it('writes an SLA log row per check with the previous status', async () => {
    const { ports } = portsFor(db, { down: new Set([A]) })
    await runHealthChecks(ports)
    const rows = (await db.query<{ status: string; previous_status: string; error_kind: string | null }>(
      `select status::text, previous_status::text, error_kind from provider_health_log where provider_id = '${A}'`)).rows
    expect(rows).toEqual([{ status: 'unavailable', previous_status: 'healthy', error_kind: 'http 503' }])
  })

  it('the log is not readable by clients', async () => {
    await db.exec(`reset role; set role authenticated`)
    await expect(db.query(`select * from provider_health_log`)).rejects.toThrow()
    await db.exec('reset role')
  })

  describe('balance monitoring', () => {
    const bal = async (id: string) => (await db.query<{ b: string; c: string; sync: boolean; mirrored: string; sent: boolean }>(
      `select provider_balance::text b, currency c, last_balance_sync is not null sync, balance::text mirrored, balance_alert_sent sent from providers where id = $1`, [id])).rows[0]

    it('stores balance, currency and sync time (and the legacy balance column follows)', async () => {
      const { ports } = portsFor(db, { down: new Set(), balance: { [A]: 123.4567 } })
      await runHealthChecks(ports)
      expect(await bal(A)).toMatchObject({ b: '123.4567', c: 'USD', sync: true, mirrored: '123.4567', sent: false })
    })

    it('has sensible defaults: threshold 10, top-up target 100, lock open', async () => {
      const r = (await db.query<{ t: string; u: string; s: boolean }>(`select low_balance_threshold::text t, target_topup_balance::text u, balance_alert_sent s from providers where id = $1`, [A])).rows[0]
      expect(r).toEqual({ t: '10.0000', u: '100.0000', s: false })
    })

    it('alerts once while the balance stays low, resets when it recovers, alerts again on the next dip', async () => {
      const script: Script = { down: new Set(), balance: { [A]: 4 } }
      const { ports, lowBalance } = portsFor(db, script)
      expect((await runHealthChecks(ports)).balanceAlerts).toBe(1)
      for (let i = 0; i < 4; i++) expect((await runHealthChecks(ports)).balanceAlerts).toBe(0) // still low: silent
      expect(lowBalance).toEqual([{ name: 'A', balance: 4, currency: 'USD' }])
      expect((await bal(A)).sent).toBe(true)

      script.balance = { [A]: 50 } // topped up
      await runHealthChecks(ports)
      expect((await bal(A)).sent).toBe(false)
      expect(lowBalance).toHaveLength(1)

      script.balance = { [A]: 9.99 } // second dip
      await runHealthChecks(ports)
      expect(lowBalance).toHaveLength(2)
    })

    it('a balance exactly at the threshold counts as low', async () => {
      const { ports, lowBalance } = portsFor(db, { down: new Set(), balance: { [A]: 10 } })
      await runHealthChecks(ports)
      expect(lowBalance).toHaveLength(1)
    })

    it('honours a per-provider threshold', async () => {
      await db.exec(`update providers set low_balance_threshold = 500, target_topup_balance = 1000 where id = '${A}'`)
      const { ports, lowBalance } = portsFor(db, { down: new Set(), balance: { [A]: 400, [B]: 400 } })
      await runHealthChecks(ports)
      expect(lowBalance.map((l) => l.name)).toEqual(['A']) // B keeps the default threshold of 10
    })

    it('overlapping runs raise a single alert', async () => {
      const { ports, lowBalance } = portsFor(db, { down: new Set(), balance: { [A]: 1 } })
      await Promise.all([runHealthChecks(ports), runHealthChecks(ports)])
      expect(lowBalance).toHaveLength(1)
    })

    it('if nobody could be told, the lock is released so the next tick retries', async () => {
      const script: Script = { down: new Set(), balance: { [A]: 1 }, undelivered: true }
      const { ports, lowBalance } = portsFor(db, script)
      expect((await runHealthChecks(ports)).balanceAlerts).toBe(0)
      expect((await bal(A)).sent).toBe(false)
      script.undelivered = false
      expect((await runHealthChecks(ports)).balanceAlerts).toBe(1)
      expect(lowBalance).toHaveLength(1)
    })

    it('a balance failure never fails the health check', async () => {
      const { ports } = portsFor(db, { down: new Set() })
      ports.saveBalance = async () => { throw new Error('db hiccup') }
      const report = await runHealthChecks(ports)
      expect(report).toMatchObject({ healthy: 2, errors: 0, unavailable: 0 })
      expect(await statusOf(db, A)).toBe('healthy')
    })

    it('an unreadable or absurd balance is skipped and the provider stays healthy', async () => {
      const { ports, lowBalance } = portsFor(db, { down: new Set(), balance: { [A]: Number.NaN, [B]: 1e15 } })
      const report = await runHealthChecks(ports)
      expect(report).toMatchObject({ healthy: 2, errors: 0 })
      expect(lowBalance).toEqual([])
      expect((await bal(A)).b).toBe('0.0000')
    })

    it('a ping with no reading (balance field unreadable) is healthy and writes nothing', async () => {
      const { ports } = portsFor(db, { down: new Set() })
      ports.ping = async () => undefined
      const report = await runHealthChecks(ports)
      expect(report.healthy).toBe(2)
      expect((await bal(A)).sync).toBe(false)
    })

    it('a down provider gets no balance update', async () => {
      const { ports, lowBalance } = portsFor(db, { down: new Set([A]), balance: { [A]: 1 } })
      await runHealthChecks(ports)
      expect((await bal(A)).sync).toBe(false)
      expect(lowBalance).toEqual([])
    })

    it('rejects thresholds that make no sense', async () => {
      await expect(db.exec(`update providers set low_balance_threshold = -1 where id = '${A}'`)).rejects.toThrow()
      await expect(db.exec(`update providers set low_balance_threshold = 200 where id = '${A}'`)).rejects.toThrow() // above the 100 top-up target
    })
  })

  describe('automatic failover', () => {
    it('routes to the best provider while healthy, then to the fallback as soon as it is marked down', async () => {
      expect((await routeNow(db)).providerId).toBe(A)

      const script = { down: new Set([A]) }
      const { ports } = portsFor(db, script)
      await runHealthChecks(ports)
      expect((await routeNow(db)).providerId).toBe(B)

      // A recovers: traffic returns to the higher-scored provider
      script.down.clear()
      await runHealthChecks(ports)
      expect((await routeNow(db)).providerId).toBe(A)
    })

    it('refuses the order (before charging) when every provider is down', async () => {
      const { ports } = portsFor(db, { down: new Set([A, B]) })
      await runHealthChecks(ports)
      await expect(routeNow(db)).rejects.toBeInstanceOf(ServiceUnavailableError)
    })
  })
})
