import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import * as srcTypes from '../src/types/provider'
import type { IProviderServiceOffer } from '../src/types/provider'

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations')
const OFFERS = '20261013000000_provider_offers.sql'

const files = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
async function newDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  return db
}
const apply = async (db: PGlite, list: string[]) => {
  for (const f of list) await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
}
const before = () => files().filter((f) => f < OFFERS)

type Row = Record<string, unknown>

/** Two providers, three provider services, three services (primary only / primary+fallback / none-mapped extra). */
const SEED = `
  insert into providers(id, name, api_url) values
    ('00000000-0000-0000-0000-0000000000a1', 'A', 'https://a'), ('00000000-0000-0000-0000-0000000000b1', 'B', 'https://b');
  -- these fixtures also run against schemas from before the platform registry, so the category is written for either one
  do $cat$ begin
    if exists (select 1 from information_schema.columns where table_name = 'categories' and column_name = 'platform_id') then
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', (select id from platforms where slug = 'telegram'), 'Views', 'views');
    else
      execute $q$insert into categories(id, platform, name, slug) values ('00000000-0000-0000-0000-0000000000c1', 'telegram', 'Views', 'views')$q$;
    end if;
  end $cat$;
  insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported) values
    ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000000a1', '1', 'A views', 0.1000, 100, 50000, true,  false),
    ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-0000000000b1', '9', 'B views', 0.0700, 50,  20000, false, true),
    ('00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-0000000000a1', '2', 'A solo',  0.5000, 10,  1000,  false, false);
  insert into services(id, category_id, name, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values
    ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', 'Views',
      '00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-000000000b01', 0.4000, 100, 20000),
    ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1', 'Solo',
      '00000000-0000-0000-0000-000000000a02', null, 2.0000, 10, 1000);`

describe('migration 20261013: provider_service_offers', () => {
  it('is part of the history and applies on top of everything before it', async () => {
    expect(files()).toContain(OFFERS)
    const db = await newDb()
    await apply(db, files())
  }, 120_000)

  it('backfills primary and fallback as active offers with the provider\'s own cost, limits and flags', async () => {
    const db = await newDb()
    await apply(db, before())
    await db.exec(SEED)
    await apply(db, [OFFERS])
    const rows = (await db.query<Row>(`
      select s.name svc, p.name prov, o.cost_per_1000::text cost, o.min_quantity, o.max_quantity,
             o.refill_supported, o.cancel_supported, o.is_active, o.routing_score
        from provider_service_offers o join services s on s.id = o.service_id join providers p on p.id = o.provider_id
       order by s.name, o.routing_score desc`)).rows
    expect(rows).toEqual([
      { svc: 'Solo', prov: 'A', cost: '0.5000', min_quantity: 10, max_quantity: 1000, refill_supported: false, cancel_supported: false, is_active: true, routing_score: 100 },
      { svc: 'Views', prov: 'A', cost: '0.1000', min_quantity: 100, max_quantity: 50000, refill_supported: true, cancel_supported: false, is_active: true, routing_score: 100 },
      { svc: 'Views', prov: 'B', cost: '0.0700', min_quantity: 50, max_quantity: 20000, refill_supported: false, cancel_supported: true, is_active: true, routing_score: 0 },
    ])
  }, 120_000)

  it('leaves services untouched: primary and fallback columns are still there and unchanged', async () => {
    const db = await newDb()
    await apply(db, before())
    await db.exec(SEED)
    const snapshot = async () => (await db.query<Row>(`select * from services order by id`)).rows
    const pre = await snapshot()
    await apply(db, [OFFERS])
    expect(await snapshot()).toEqual(pre)
  }, 120_000)

  it('backfills nothing on an empty catalogue', async () => {
    const db = await newDb()
    await apply(db, files())
    expect((await db.query(`select 1 from provider_service_offers`)).rows).toHaveLength(0)
  }, 120_000)

  it('is idempotent in its data: a second identical offer is refused, a different provider service is allowed', async () => {
    const db = await newDb()
    await apply(db, before())
    await db.exec(SEED)
    await apply(db, [OFFERS])
    const dup = `insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity)
      values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a02', 1, 1, 10)`
    await expect(db.exec(dup)).rejects.toThrow(/pso_unique|duplicate/)
    await db.exec(`insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity)
      values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000b01', 0.3, 1, 10)`)
    const d = (await db.query<Row>(`select refill_supported, cancel_supported, is_active, routing_score from provider_service_offers where cost_per_1000 = 0.3`)).rows[0]
    expect(d).toEqual({ refill_supported: false, cancel_supported: false, is_active: true, routing_score: 0 }) // column defaults
  }, 120_000)
})

describe('integrity', () => {
  async function seeded() {
    const db = await newDb()
    await apply(db, before())
    await db.exec(SEED)
    await apply(db, [OFFERS])
    return db
  }
  const ins = (cols: string, vals: string) => `insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity${cols}) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a02', ${vals})`

  it('rejects an offer whose provider is not the owner of the provider service', async () => {
    const db = await seeded()
    await expect(db.exec(`insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity)
      values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000a02', 1, 1, 10)`)).rejects.toThrow(/foreign key/i)
  }, 120_000)

  it('validates cost and quantity range, and the references', async () => {
    const db = await seeded()
    await expect(db.exec(ins('', '-1, 1, 10'))).rejects.toThrow(/pso_cost_nonneg/)
    await expect(db.exec(ins('', '1, 0, 10'))).rejects.toThrow(/pso_min_positive/)
    await expect(db.exec(ins('', '1, 10, 5'))).rejects.toThrow(/pso_qty_range/)
    await expect(db.exec(`insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity)
      values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a02', 1, 1, 10)`)).rejects.toThrow(/foreign key/i)
    await db.exec(ins('', '1, 1, 10'))
  }, 120_000)

  it('cascades: deleting a service, a provider service or a provider removes its offers', async () => {
    const db = await seeded()
    const count = async () => Number((await db.query<{ n: number }>(`select count(*)::int n from provider_service_offers`)).rows[0].n)
    expect(await count()).toBe(3)
    await db.exec(`delete from services where id = '00000000-0000-0000-0000-0000000000f2'`)
    expect(await count()).toBe(2)
    await db.exec(`update services set fallback_provider_service_id = null where id = '00000000-0000-0000-0000-0000000000f1'`)
    await db.exec(`delete from provider_services where id = '00000000-0000-0000-0000-000000000b01'`)
    expect(await count()).toBe(1)
    await db.exec(`update services set primary_provider_service_id = primary_provider_service_id`) // untouched columns still usable
    await db.exec(`delete from services`)
    await db.exec(`delete from providers`)
    expect(await count()).toBe(0)
  }, 120_000)

  it('stamps updated_at on change', async () => {
    const db = await seeded()
    await db.exec(`update provider_service_offers set routing_score = 7`)
    const r = (await db.query<Row>(`select bool_and(updated_at >= created_at) ok, bool_and(routing_score = 7) seven from provider_service_offers`)).rows[0]
    expect(r).toEqual({ ok: true, seven: true })
  }, 120_000)
})

describe('access: offers are invisible to clients', () => {
  it('RLS is on, no policies, and anon/authenticated hold no privilege', async () => {
    const db = await newDb()
    await apply(db, files())
    const rls = (await db.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = 'provider_service_offers'`)).rows
    expect(rls).toEqual([{ relrowsecurity: true }])
    expect((await db.query(`select 1 from pg_policies where tablename = 'provider_service_offers'`)).rows).toEqual([])
    for (const role of ['anon', 'authenticated'])
      for (const priv of ['select', 'insert', 'update', 'delete']) {
        const r = await db.query<{ ok: boolean }>(`select has_table_privilege($1, 'public.provider_service_offers', $2) ok`, [role, priv])
        expect(r.rows[0].ok, `${role} ${priv}`).toBe(false)
      }
  }, 120_000)

  it('clients get "permission denied" even with Supabase-style default grants emulated', async () => {
    const db = await newDb()
    await db.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`)
    await apply(db, files())
    await db.exec(SEED)
    for (const role of ['authenticated', 'anon']) {
      await db.exec(`reset role; set role ${role}; select set_config('request.jwt.sub', gen_random_uuid()::text, false)`)
      for (const sql of [
        `select * from provider_service_offers`, `select cost_per_1000 from provider_service_offers`,
        `insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 1, 1)`,
        `update provider_service_offers set cost_per_1000 = 0`, `delete from provider_service_offers`,
      ]) await expect(db.query(sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/)
    }
    await db.exec(`reset role`)
    // the storefront's own table is still readable (nothing was broken by the new constraint on provider_services)
    await db.exec(`set role authenticated`)
    expect((await db.query(`select 1 from services`)).rows.length).toBeGreaterThanOrEqual(0)
    await db.exec(`reset role`)
  }, 120_000)
})

describe('TypeScript surface', () => {
  it('IProviderServiceOffer is exported next to the other provider types and mirrors the table', () => {
    const offer: IProviderServiceOffer = {
      id: 'o', serviceId: 's', providerId: 'p', providerServiceId: 'ps', costPer1000: 0.07,
      minQuantity: 50, maxQuantity: 20000, refillSupported: false, cancelSupported: true, isActive: true,
      routingScore: 0, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
    }
    expect(Object.keys(offer)).toHaveLength(13)
    expect(srcTypes).toBeDefined()
  })
})
