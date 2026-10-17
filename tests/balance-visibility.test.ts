// A card is on sale only while a provider that can pay serves it (migration 20261217000000): cards served only by donors at $0 leave the
// storefront (and their empty category with them) and come back by themselves when a donor is topped up.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let db: PGlite
const CENTER = '00000000-0000-4000-8000-0000000c0001'
const DONOR = '00000000-0000-4000-8000-0000000c0002'
let seq = 0
let both: string, donorOnly: string, donorCat: string, mainCat: string

const ps = async (provider: string, rate: number) =>
  (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
    values ($1, $2, $3, $4, 10, 10000) returning id`, [provider, `x${++seq}`, `Svc ${seq}`, rate])).rows[0].id
const card = async (cat: string, primary: string, name: string) =>
  (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
    values ($1, $2, $3, 2, 10, 10000) returning id`, [cat, name, primary])).rows[0].id
const visible = async () => {
  await db.exec(`set role anon`)
  const r = (await db.query<{ id: string }>(`select id from services order by name`)).rows.map((x) => x.id)
  await db.exec(`reset role`)
  return r
}
const count = async (cat: string) => (await db.query<{ n: number }>(`select active_service_count n from categories where id = $1`, [cat])).rows[0].n
const balance = (provider: string, amount: number) => db.query(`update providers set provider_balance = $2, last_balance_sync = now() where id = $1`, [provider, amount])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  await db.exec(`insert into providers (id, name, api_url, routing_enabled, catalog_mode, provider_balance, last_balance_sync) values
    ('${CENTER}', 'Center', 'https://c', true, 'publish', 3, now()), ('${DONOR}', 'Donor', 'https://d', true, 'linked_only', 5, now())`)
  mainCat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'Main', 'main') returning id`)).rows[0].id
  donorCat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='roblox'), 'Roblox Followers', 'rf') returning id`)).rows[0].id
  both = await card(mainCat, await ps(CENTER, 1), 'A both')
  await db.query(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active, routing_score)
    values ($1, $2, $3, 0.5, 10, 10000, true, 0)`, [both, DONOR, await ps(DONOR, 0.5)])
  donorOnly = await card(donorCat, await ps(DONOR, 1), 'B donor only')
}, 180_000)
afterAll(async () => { await db.close() })

describe('on sale while a provider can pay', () => {
  it('with money everywhere, everything is on sale', async () => {
    await db.query(`select refresh_service_funding()`)
    expect(await visible()).toEqual([both, donorOnly])
    expect(await count(donorCat)).toBe(1)
  })

  it('the donor drops under $0.10: its only card leaves the storefront (and its category is empty); a card the primary also serves stays', async () => {
    await balance(DONOR, 0.05) // the trigger recomputes at once
    expect(await visible()).toEqual([both])
    expect(await count(donorCat)).toBe(0)
    expect(await count(mainCat)).toBe(1)
    // nothing is switched off: the catalogue's decision stays
    expect((await db.query<{ a: boolean }>(`select is_active a from services where id = $1`, [donorOnly])).rows[0].a).toBe(true)
  })

  it('a top-up brings it back by itself', async () => {
    await balance(DONOR, 0.1)
    expect(await visible()).toEqual([both, donorOnly])
    expect(await count(donorCat)).toBe(1)
  })

  it('a balance never read is unknown, not empty; the primary at $0 leaves only what nobody can pay for', async () => {
    await db.query(`update providers set provider_balance = 0, last_balance_sync = null where id = $1`, [DONOR])
    await db.query(`select refresh_service_funding()`)
    expect(await visible()).toEqual([both, donorOnly])
    await balance(DONOR, 0)
    await balance(CENTER, 0)
    expect(await visible()).toEqual([])
    await balance(CENTER, 3)
    expect(await visible()).toEqual([both])
  })

  it('pg_cron keeps it current; only the database may run it', async () => {
    const r = (await db.query<{ r: Record<string, number> }>(`select refresh_service_funding() r`)).rows[0].r
    expect(r).toMatchObject({ hidden: 0, restored: 0, on_sale: 1 })
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ p: boolean }>(`select has_function_privilege('${role}', 'public.refresh_service_funding()', 'execute') p`)).rows[0].p).toBe(false)
    }
  })
})
