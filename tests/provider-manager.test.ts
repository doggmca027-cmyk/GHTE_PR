import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { DEFAULT_SMM_V2_CAPABILITIES, HEALTH_STATUSES, type IProvider, type ISMMProviderAdapter, type ProviderCapabilities } from '../supabase/functions/_shared/types.ts'
import * as srcTypes from '../src/types/provider'

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations')
const NEW_MIGRATION = '20261012000000_provider_manager_upgrade.sql'

async function newDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  return db
}
const files = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
const apply = async (db: PGlite, list: string[]) => {
  for (const f of list) await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
}
async function fullDb() {
  const db = await newDb()
  await apply(db, files())
  return db
}

type Row = Record<string, unknown>

describe('migration 20261012: the new provider columns', () => {
  it('is the newest migration and applies on top of the full history', async () => {
    expect(files().at(-1)).toBe(NEW_MIGRATION)
    await expect(fullDb()).resolves.toBeDefined()
  }, 120_000)

  it('gives a new provider safe defaults: off for routing, health "disabled", USD, API v2', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url) values ('fresh', 'https://x')`)
    const p = (await db.query<Row>(`select api_version, routing_enabled, health_status, last_health_check, last_balance_sync, provider_balance::text pb, currency from providers`)).rows[0]
    expect(p).toEqual({ api_version: 'v2', routing_enabled: false, health_status: 'disabled', last_health_check: null, last_balance_sync: null, pb: '0.0000', currency: 'USD' })
  }, 120_000)

  it('the health enum matches the TypeScript list exactly', async () => {
    const db = await fullDb()
    const range = (await db.query<{ v: string }>(`select unnest(enum_range(null::provider_health_enum))::text v`)).rows.map((r) => r.v)
    expect(range).toEqual([...HEALTH_STATUSES])
    await expect(db.exec(`insert into providers(name, api_url, health_status) values ('x','u','sleepy')`)).rejects.toThrow()
    for (const status of HEALTH_STATUSES) await db.query(`insert into providers(name, api_url, health_status) values ($1::text, 'u', $2::provider_health_enum)`, [`p-${status}`, status])
  }, 120_000)

  it('validates what it stores', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url, is_active) values ('off','u', false), ('on','u', true)`)
    // routing needs an active provider
    await expect(db.exec(`update providers set routing_enabled = true where name = 'off'`)).rejects.toThrow(/routing_needs_active/)
    await db.exec(`update providers set routing_enabled = true where name = 'on'`)
    await expect(db.exec(`update providers set is_active = false where name = 'on'`)).rejects.toThrow(/routing_needs_active/) // cannot deactivate while routed
    await expect(db.exec(`update providers set api_version = 'two' where name = 'on'`)).rejects.toThrow(/api_version_format/)
    await expect(db.exec(`update providers set currency = 'usd' where name = 'on'`)).rejects.toThrow(/currency_format/)
    await db.exec(`update providers set api_version = 'v3', currency = 'USDT' where name = 'on'`)
  }, 120_000)
})

describe('upgrade path: existing providers survive', () => {
  it('keeps live data, applies the safe defaults, mirrors the balance and backfills capabilities', async () => {
    const db = await newDb()
    const all = files()
    await apply(db, all.filter((f) => f < NEW_MIGRATION)) // the database as it is in production today
    await db.exec(`
      insert into providers(name, api_url, is_active, balance, balance_updated_at, priority)
        values ('Live Panel', 'https://panel.example/api/v2', true, 842.17, '2026-10-06T10:00:00Z', 10),
               ('Dormant', 'https://old.example/api/v2', false, 0, null, 0);
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported)
        select id, '1', 'a', 1, 1, 10, true,  false from providers where name = 'Live Panel';
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported)
        select id, '2', 'b', 1, 1, 10, false, false from providers where name = 'Live Panel';`)

    await apply(db, [NEW_MIGRATION])

    const live = (await db.query<Row>(`select name, api_url, is_active, balance::text b, priority, routing_enabled, health_status, provider_balance::text pb, last_balance_sync, currency, api_version from providers where name = 'Live Panel'`)).rows[0]
    expect(live).toMatchObject({ name: 'Live Panel', api_url: 'https://panel.example/api/v2', is_active: true, b: '842.1700', priority: 10, routing_enabled: false, health_status: 'disabled', pb: '842.1700', currency: 'USD', api_version: 'v2' })
    expect(new Date(live.last_balance_sync as string).toISOString()).toBe('2026-10-06T10:00:00.000Z')

    const caps = (await db.query<Row>(`select p.name, c.supports_refill, c.supports_cancel, c.supports_drip_feed, c.supports_partial, c.supports_balance_api from providers p join provider_capabilities c on c.provider_id = p.id order by p.name`)).rows
    expect(caps).toEqual([
      { name: 'Dormant', supports_refill: false, supports_cancel: false, supports_drip_feed: false, supports_partial: true, supports_balance_api: true },
      { name: 'Live Panel', supports_refill: true, supports_cancel: false, supports_drip_feed: false, supports_partial: true, supports_balance_api: true }, // refill inferred from its catalogue
    ])
  }, 180_000)
})

describe('capabilities: strictly 1-to-1', () => {
  it('a row appears automatically for every new provider, with nothing optional switched on', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url) values ('a','u'), ('b','u')`)
    const rows = (await db.query<Row>(`select supports_refill, supports_cancel, supports_drip_feed, supports_partial, supports_balance_api from provider_capabilities`)).rows
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(Object.values(r)).toEqual([false, false, false, false, false])
  }, 120_000)

  it('cannot have two rows per provider, cannot exist without a provider, and goes away with it', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url) values ('solo','u')`)
    const id = (await db.query<{ id: string }>(`select id from providers`)).rows[0].id
    await expect(db.query(`insert into provider_capabilities(provider_id) values ($1)`, [id])).rejects.toThrow(/duplicate|unique|pkey/i)
    await expect(db.query(`insert into provider_capabilities(provider_id) values (gen_random_uuid())`)).rejects.toThrow(/foreign key/i)
    await db.query(`delete from providers where id = $1`, [id])
    expect((await db.query(`select 1 from provider_capabilities`)).rows).toHaveLength(0)
  }, 120_000)

  it('flags can be updated and are timestamped', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url) values ('p','u')`)
    await db.exec(`update provider_capabilities set supports_refill = true, supports_drip_feed = true`)
    const r = (await db.query<Row>(`select supports_refill, supports_drip_feed, updated_at >= created_at as stamped from provider_capabilities`)).rows[0]
    expect(r).toEqual({ supports_refill: true, supports_drip_feed: true, stamped: true })
  }, 120_000)
})

describe('balance columns never disagree', () => {
  const state = async (db: PGlite) => (await db.query<Row>(`select balance::text b, provider_balance::text pb, balance_updated_at::text bu, last_balance_sync::text ls from providers`)).rows[0]

  it('writes by the existing sync-catalog (balance, balance_updated_at) are mirrored', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url) values ('p','u')`)
    await db.exec(`update providers set balance = 55.5, balance_updated_at = '2026-10-12T00:00:00Z'`)
    const s = await state(db)
    expect(s.pb).toBe('55.5000')
    expect(s.bu).toBe(s.ls)
  }, 120_000)

  it('writes to the new columns are mirrored back', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url) values ('p','u')`)
    await db.exec(`update providers set provider_balance = 7.25, last_balance_sync = '2026-10-13T00:00:00Z'`)
    const s = await state(db)
    expect(s.b).toBe('7.2500')
    expect(s.bu).toBe(s.ls)
    expect(s.ls).toContain('2026-10-13')
  }, 120_000)

  it('inserting with only one pair filled in fills the other', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url, provider_balance, last_balance_sync) values ('a','u', 3, '2026-10-01T00:00:00Z')`)
    await db.exec(`insert into providers(name, api_url, balance, balance_updated_at) values ('b','u', 4, '2026-10-02T00:00:00Z')`)
    const rows = (await db.query<Row>(`select name, balance::text b, provider_balance::text pb, balance_updated_at is not null bu, last_balance_sync is not null ls from providers order by name`)).rows
    expect(rows).toEqual([{ name: 'a', b: '3.0000', pb: '3.0000', bu: true, ls: true }, { name: 'b', b: '4.0000', pb: '4.0000', bu: true, ls: true }])
  }, 120_000)

  it('unrelated updates leave both pairs alone', async () => {
    const db = await fullDb()
    await db.exec(`insert into providers(name, api_url, balance) values ('p','u', 9)`)
    await db.exec(`update providers set priority = 5, health_status = 'healthy', last_health_check = now()`)
    expect((await state(db)).pb).toBe('9.0000')
  }, 120_000)
})

describe('access: provider configuration is service-role only', () => {
  it('RLS is on and no client role holds any privilege on providers or provider_capabilities', async () => {
    const db = await fullDb()
    const rls = (await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('providers','provider_capabilities')`)).rows
    expect(rls.every((r) => r.relrowsecurity)).toBe(true)
    expect(rls).toHaveLength(2)
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['providers', 'provider_capabilities']) {
        for (const priv of ['select', 'insert', 'update', 'delete']) {
          const r = await db.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) ok`, [role, `public.${table}`, priv])
          expect(r.rows[0].ok, `${role} ${priv} ${table}`).toBe(false)
        }
      }
    }
    expect((await db.query(`select policyname from pg_policies where tablename in ('providers','provider_capabilities')`)).rows).toEqual([]) // no client policies at all
  }, 120_000)

  it('a signed-in client really gets "permission denied" (even with Supabase-style default grants emulated)', async () => {
    const db = await newDb()
    await db.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`)
    await apply(db, files())
    await db.exec(`insert into providers(name, api_url) values ('p','u')`)
    await db.exec(`set role authenticated; select set_config('request.jwt.sub', gen_random_uuid()::text, false)`)
    for (const sql of [
      `select * from provider_capabilities`, `select * from providers`,
      `update provider_capabilities set supports_refill = true`, `insert into provider_capabilities(provider_id) values (gen_random_uuid())`,
      `update providers set routing_enabled = true`, `delete from provider_capabilities`,
    ]) await expect(db.query(sql), sql).rejects.toThrow(/permission denied/)
    await db.exec(`reset role; set role anon`)
    await expect(db.query(`select * from provider_capabilities`)).rejects.toThrow(/permission denied/)
    await db.exec(`reset role`)
  }, 120_000)
})

describe('nothing that exists today changed behaviour', () => {
  it('place_order still pays and creates an order against a provider with the new defaults', async () => {
    const db = await fullDb()
    await db.exec(`
      insert into providers(name, api_url) values ('p','u');
      insert into categories(platform, name, slug) values ('telegram','c','c');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        select id,'1','s',1,1,100000 from providers;
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id,'s',ps.id,2.5,1,100000 from categories c, provider_services ps;
      insert into users(telegram_id) values (42);`)
    const user = (await db.query<{ id: string }>(`select id from users`)).rows[0].id
    const svc = (await db.query<{ id: string }>(`select id from services`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100,null,'fund','fund-1')`, [user])
    const o = (await db.query<{ status: string; charge_amount: string }>(`select * from place_order($1::uuid,$2::uuid,'https://t.me/x',1000,'key-1')`, [user, svc])).rows[0]
    expect(o).toMatchObject({ status: 'paid', charge_amount: '2.5000' })
    expect(Number((await db.query<{ b: string }>(`select balance::text b from wallets`)).rows[0].b)).toBe(97.5)
  }, 120_000)

  it('the admin provider card still works and does not expose the new internals', async () => {
    const db = await fullDb()
    await db.exec(`insert into users(telegram_id, is_admin) values (1, true); insert into providers(name, api_url, balance) values ('p','u', 12.5)`)
    const admin = (await db.query<{ id: string }>(`select id from users`)).rows[0].id
    await db.exec(`set role authenticated; select set_config('request.jwt.sub','${admin}',false)`)
    const r = (await db.query<{ r: Row[] }>(`select admin_provider_status() r`)).rows[0].r
    await db.exec(`reset role`)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ name: 'p', balance: 12.5 })
  }, 120_000)
})

describe('TypeScript domain model', () => {
  it('exposes the health list and default capabilities from src/types', () => {
    expect([...srcTypes.HEALTH_STATUSES]).toEqual(['healthy', 'degraded', 'unavailable', 'disabled'])
    expect(srcTypes.DEFAULT_SMM_V2_CAPABILITIES).toEqual({ supportsRefill: false, supportsCancel: false, supportsDripFeed: false, supportsPartial: true, supportsBalanceApi: true })
    expect(Object.isFrozen(DEFAULT_SMM_V2_CAPABILITIES)).toBe(true)
  })

  it('an IProvider has no credentials by construction', () => {
    const provider: IProvider = {
      id: 'p1', name: 'Panel', apiUrl: 'https://x', apiVersion: 'v2', isActive: true, routingEnabled: false, healthStatus: 'disabled',
      lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0,
    }
    expect(Object.keys(provider)).not.toContain('apiKey')
    // @ts-expect-error the domain object must not be able to carry the API key
    const withKey: IProvider = { ...provider, apiKey: 'secret' }
    expect(withKey).toBeDefined()
  })

  it('the SMM v2 adapter satisfies the interface and reports capabilities (copy, overridable)', async () => {
    const adapter: ISMMProviderAdapter = new SMMv2Adapter({ id: 'a', name: 'A', apiUrl: 'https://x' })
    const caps = await adapter.getCapabilities()
    expect(caps).toEqual(DEFAULT_SMM_V2_CAPABILITIES)
    ;(caps as ProviderCapabilities).supportsRefill = true // mutating the answer must not leak into the next one
    expect(await adapter.getCapabilities()).toEqual(DEFAULT_SMM_V2_CAPABILITIES)

    const refilling = new SMMv2Adapter({ id: 'b', name: 'B', apiUrl: 'https://x', apiKey: 'k', capabilities: { supportsRefill: true, supportsDripFeed: true } })
    expect(await refilling.getCapabilities()).toEqual({ ...DEFAULT_SMM_V2_CAPABILITIES, supportsRefill: true, supportsDripFeed: true })
  })

  it('asking for capabilities never touches the network', async () => {
    const boom = (async () => { throw new Error('network used') }) as unknown as typeof fetch
    const adapter = new SMMv2Adapter({ id: 'a', name: 'A', apiUrl: 'https://x', apiKey: 'k', fetchImpl: boom })
    await expect(adapter.getCapabilities()).resolves.toBeDefined()
  })
})
