import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261031000000_provider_slug_partial.sql'
const ROOT = path.resolve(__dirname, '..')
const BOOT = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;`

async function dbBefore(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(BOOT)
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && x < MIGRATION).sort()) await db.exec(fs.readFileSync(path.join(DIR, f), 'utf8'))
  return db
}
const apply = (db: PGlite) => db.exec(fs.readFileSync(path.join(DIR, MIGRATION), 'utf8'))
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows

describe('migration 20261031000000_provider_slug_partial.sql', () => {
  it('gives every existing provider a unique, well-formed slug; clashes get a suffix; ids and offers are untouched', async () => {
    const db = await dbBefore()
    await db.exec(`
      insert into providers(name, api_url, created_at) values
        ('Secsers Mock', 'https://a', now() - interval '3 days'), ('secsers  mock!', 'https://b', now() - interval '2 days'), ('  --JAP (Main)--  ', 'https://c', now()), ('!!!', 'https://d', now()), ('Панель', 'https://e', now() + interval '1 second'),
        ('${'x'.repeat(60)}', 'https://f', now());
      insert into categories(platform_id, name, slug) select id, 'C', 'c' from platforms where slug = 'telegram';
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) select id, '1', 's', 1, 1, 100 from providers where name = 'Secsers Mock';
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id, 'Svc', ps.id, 2, 1, 100 from categories c, provider_services ps;`)
    const ids = await rows<{ id: string }>(db, `select id from providers order by name`)
    const offers = await rows(db, `select id, cost_per_1000 from provider_service_offers`)

    await apply(db)

    const slugs = Object.fromEntries((await rows<{ name: string; slug: string }>(db, `select name, slug from providers`)).map((r) => [r.name, r.slug]))
    expect(slugs['Secsers Mock']).toBe('secsers-mock')
    expect(slugs['secsers  mock!']).toBe('secsers-mock-2') // same base, the older row keeps the plain slug
    expect(slugs['  --JAP (Main)--  ']).toBe('jap-main')
    expect(slugs['!!!']).toBe('provider')
    expect(slugs['Панель']).toBe('provider-2')
    expect(slugs['x'.repeat(60)]).toBe('x'.repeat(40))
    for (const s of Object.values(slugs)) expect(s).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/)
    expect(new Set(Object.values(slugs)).size).toBe(6)
    expect(await rows<{ id: string }>(db, `select id from providers order by name`)).toEqual(ids)
    expect(await rows(db, `select id, cost_per_1000 from provider_service_offers`)).toEqual(offers)
    expect(await rows(db, `select supports_partial from provider_service_offers`)).toEqual([{ supports_partial: false }])
    expect(await rows<{ n: string }>(db, `select is_nullable n from information_schema.columns where table_name = 'providers' and column_name = 'slug'`)).toEqual([{ n: 'NO' }])
  }, 120_000)

  describe('after the migration', () => {
    const setup = async () => {
      const db = await dbBefore()
      await apply(db)
      return db
    }

    it('inserts that omit the slug keep working (seed, SQL console, old scripts) and never collide', async () => {
      const db = await setup()
      await db.exec(`insert into providers(name, api_url) values ('Secsers Mock', 'https://a'), ('secsers mock', 'https://b'), ('Secsers  Mock!', 'https://c')`)
      expect((await rows<{ slug: string }>(db, `select slug from providers order by created_at, slug`)).map((r) => r.slug).sort()).toEqual(['secsers-mock', 'secsers-mock-2', 'secsers-mock-3'])
      await db.exec(`insert into providers(name, api_url, slug) values ('Explicit', 'https://d', 'my-slug')`)
      expect((await rows(db, `select 1 from providers where slug = 'my-slug'`))).toHaveLength(1)
    }, 120_000)

    it('a duplicate or malformed explicit slug is refused', async () => {
      const db = await setup()
      await db.exec(`insert into providers(name, api_url, slug) values ('A', 'https://a', 'alpha')`)
      await expect(db.exec(`insert into providers(name, api_url, slug) values ('B', 'https://b', 'alpha')`)).rejects.toThrow(/unique|duplicate/i)
      for (const bad of ['Alpha', '-x', 'has space', '']) await expect(db.query(`insert into providers(name, api_url, slug) values ('C' || $1, 'https://c', $1)`, [bad]), bad).rejects.toThrow()
      await expect(db.exec(`update providers set slug = null where slug = 'alpha'`)).rejects.toThrow(/not-null|null value/i)
    }, 120_000)

    it('offers created by the bridge trigger default to supports_partial = false; it can be set', async () => {
      const db = await setup()
      await db.exec(`
        insert into providers(name, api_url) values ('P', 'https://p');
        insert into categories(platform_id, name, slug) select id, 'C', 'c' from platforms where slug = 'telegram';
        insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) select id, '1', 's', 1, 1, 100 from providers;
        insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
          select c.id, 'Svc', ps.id, 2, 1, 100 from categories c, provider_services ps;`)
      expect(await rows(db, `select supports_partial from provider_service_offers`)).toEqual([{ supports_partial: false }])
      await db.exec(`update provider_service_offers set supports_partial = true`)
      expect(await rows(db, `select supports_partial from provider_service_offers`)).toEqual([{ supports_partial: true }])
    }, 120_000)

    it('the helpers are not callable by clients, the legacy columns are still there, and access is unchanged', async () => {
      const db = await setup()
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`reset role; set role ${role}`)
        await expect(db.query(`select slugify_provider_name('x')`)).rejects.toThrow(/permission denied/)
        await expect(db.query(`select slug from providers`)).rejects.toThrow(/permission denied/)
        await expect(db.query(`select supports_partial from provider_service_offers`)).rejects.toThrow(/permission denied/)
      }
      await db.exec('reset role')
      expect(await rows(db, `select column_name from information_schema.columns where table_name = 'services' and column_name in ('primary_provider_service_id', 'fallback_provider_service_id')`)).toHaveLength(2)
    }, 120_000)
  })
})

describe('documentation', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/architecture/smm-catalog-routing.md'), 'utf8')

  it('describes the real chain and flags the primary/fallback columns as legacy', () => {
    expect(doc).toMatch(/platforms .*categories .*services .*provider_service_offers .*providers/)
    for (const t of ['platforms', 'categories', 'services', 'provider_services', 'provider_service_offers', 'providers', 'orders']) expect(doc).toContain(`### ${t}`)
    expect(doc).toMatch(/Legacy: `services\.primary_provider_service_id` and `fallback_provider_service_id`/)
    expect(doc).toContain('must not be dropped yet')
  })

  it('every table and column it names exists in the migrated schema', async () => {
    const db = new PGlite()
    await db.exec(BOOT)
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(DIR, f), 'utf8'))
    const cols = new Set((await rows<{ t: string; c: string }>(db, `select table_name t, column_name c from information_schema.columns where table_schema = 'public'`)).map((r) => `${r.t}.${r.c}`))
    for (const ref of ['categories.platform_id', 'services.customer_rate_per_1000', 'services.min_quantity', 'services.refill_supported', 'provider_services.external_service_id',
      'provider_service_offers.cost_per_1000', 'provider_service_offers.supports_partial', 'provider_service_offers.routing_score', 'providers.slug', 'providers.provider_balance',
      'providers.reliability_penalty_multiplier', 'orders.provider_offer_id', 'orders.provider_order_id', 'orders.provider_reservation', 'orders.cost_amount',
      'orders.routing_score_snapshot', 'orders.profit_amount', 'services.primary_provider_service_id', 'services.fallback_provider_service_id']) {
      expect(cols.has(ref), ref).toBe(true)
    }
    expect(cols.has('providers.reserved_balance')).toBe(false) // the doc says there is none, on purpose
    for (const trig of ['trg_services_sync_offers', 'trg_provider_services_sync_offers']) expect(doc).toContain(trig)
  }, 120_000)
})
