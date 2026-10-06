import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { balanceState, parseAmount } from '../src/lib/admin-view'
import { AdminApiError } from '../src/services/api/mock-admin'
import { createMockProviders } from '../src/services/api/mock-providers'

describe('balanceState / parseAmount', () => {
  it('flags a balance at or below the threshold, and never-read balances', () => {
    expect(balanceState(10, 10, 't')).toBe('low')
    expect(balanceState(10.01, 10, 't')).toBe('ok')
    expect(balanceState(0, 10, null)).toBe('unknown')
  })
  it('parses amounts strictly', () => {
    expect(parseAmount('10')).toBe(10)
    expect(parseAmount(' 12.3456 ')).toBe(12.3456)
    for (const bad of ['', '-1', '1.23456', 'abc', '1e3', '.5', '1.', '99999999999', '1000000001']) expect(parseAmount(bad)).toBeNull()
  })
})

describe('mock providers (dev mode)', () => {
  it('applies the same rules as the RPC', () => {
    const m = createMockProviders()
    const id = m.list()[0].id
    m.update(id, { lowBalanceThreshold: 20, targetTopupBalance: 200, routingEnabled: false })
    expect(m.list()[0]).toMatchObject({ lowBalanceThreshold: 20, targetTopupBalance: 200, routingEnabled: false })
    expect(() => m.update(id, { lowBalanceThreshold: 500 })).toThrow(AdminApiError) // above the 200 target
    expect(() => m.update(id, { targetTopupBalance: -1 })).toThrow(AdminApiError)
    expect(() => m.update('nope', { routingEnabled: true })).toThrow(AdminApiError)
  })
})

describe('admin provider RPCs (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  let active: string, inactive: string
  const asUser = (id: string) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${id}',false)`)
  const call = async <T,>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    banned = await q(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`)
    active = await q(`insert into providers(name, api_url, api_key_encrypted, is_active, priority) values ('Active', 'https://a', 'SECRET-CIPHERTEXT', true, 2) returning id`)
    inactive = await q(`insert into providers(name, api_url, is_active, priority) values ('Inactive', 'https://i', false, 1) returning id`)
  }, 120_000)

  const update = (id: string, low: number | null, target: number | null, routing: boolean | null) =>
    call(`select admin_update_provider_config($1::uuid, $2::numeric, $3::numeric, $4::boolean) r`, [id, low, target, routing])

  it('lists providers with thresholds and never exposes the API key', async () => {
    await asUser(admin)
    const rows = await call<Record<string, unknown>[]>(`select admin_list_providers() r`)
    expect(rows.map((r) => r.name)).toEqual(['Active', 'Inactive']) // by priority
    expect(rows[0]).toMatchObject({ low_balance_threshold: 10, target_topup_balance: 100, balance_alert_sent: false, routing_enabled: false })
    expect(JSON.stringify(rows)).not.toContain('SECRET-CIPHERTEXT')
    expect(Object.keys(rows[0])).not.toContain('api_key_encrypted')
  })

  it('updates thresholds and routing and writes an audit entry', async () => {
    await asUser(admin)
    const r = await update(active, 25, 250, true) as unknown as Record<string, unknown>
    expect(r).toMatchObject({ low_balance_threshold: 25, target_topup_balance: 250, routing_enabled: true })
    await db.exec('reset role')
    const audit = (await db.query<{ details: Record<string, unknown>; admin_id: string }>(`select details, admin_id from admin_audit_log where action = 'update_provider_config' and target_id = '${active}'`)).rows
    expect(audit).toHaveLength(1)
    expect(audit[0].admin_id).toBe(admin)
    expect(audit[0].details.low_balance_threshold).toEqual([10, 25])
  })

  it('a partial update leaves the other fields alone', async () => {
    await asUser(admin)
    await update(active, null, null, false)
    await db.exec('reset role')
    const p = (await db.query<{ t: string; u: string; r: boolean }>(`select low_balance_threshold::text t, target_topup_balance::text u, routing_enabled r from providers where id = '${active}'`)).rows[0]
    expect(p).toEqual({ t: '25.0000', u: '250.0000', r: false })
  })

  it.each([
    ['nothing to update', null, null, null],
    ['negative threshold', -1, null, null],
    ['absurd target', null, 2_000_000_000, null],
    ['target below the (existing) threshold', null, 5, null],
    ['threshold above the (existing) target', 300, null, null],
  ] as [string, number | null, number | null, boolean | null][])('rejects: %s', async (_n, low, target, routing) => {
    await asUser(admin)
    await expect(update(active, low, target, routing)).rejects.toThrow()
  })

  it('cannot enable routing on an inactive provider', async () => {
    await asUser(admin)
    await expect(update(inactive, null, null, true)).rejects.toThrow(/inactive/)
  })

  it('reports an unknown provider', async () => {
    await asUser(admin)
    await expect(update('00000000-0000-0000-0000-000000000000', 1, null, null)).rejects.toThrow(/not found/)
  })

  it('is admin-only', async () => {
    for (const id of [user, banned, '']) {
      await asUser(id)
      await expect(db.query(`select admin_list_providers()`)).rejects.toThrow(/forbidden/)
      await expect(update(active, 1, null, null)).rejects.toThrow(/forbidden/)
    }
    await db.exec(`reset role; set role anon`)
    await expect(db.query(`select admin_list_providers()`)).rejects.toThrow()
    await db.exec('reset role')
  })
})
