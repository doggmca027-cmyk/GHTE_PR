import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { categoryFromRow } from '../src/services/api/services'

const DIR = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261030000000_platform_fk.sql'
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

describe('migration 20261030000000_platform_fk.sql', () => {
  it('links every existing category and price rule to the right platform, keeps ids, services and orders, and drops the enum', async () => {
    const db = await dbBefore()
    await db.exec(`
      insert into categories(id, platform, name, slug) values
        ('00000000-0000-4000-8000-0000000000c1', 'telegram', 'TG Views', 'tg-views'),
        ('00000000-0000-4000-8000-0000000000c2', 'instagram', 'IG Followers', 'ig-followers'),
        ('00000000-0000-4000-8000-0000000000c3', 'other', 'Misc', 'misc'),
        ('00000000-0000-4000-8000-0000000000c4', 'youtube', 'YT Views', 'yt-views');
      insert into price_rules(name, type, value, platform, priority) values ('Telegram +200%', 'percentage', 200, 'telegram', 0), ('YT', 'fixed', 1, 'youtube', 0);
      insert into price_rules(name, type, value, priority) values ('Global', 'percentage', 150, 0);
      insert into price_rules(name, type, value, category_id, priority) values ('Cat rule', 'percentage', 10, '00000000-0000-4000-8000-0000000000c2', 0);
      insert into providers(name, api_url) values ('p', 'https://x');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) select id, '1', 's', 1, 1, 1000 from providers;
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select '00000000-0000-4000-8000-0000000000c1', 'Views', id, 5, 1, 1000 from provider_services;
      insert into users(telegram_id) values (7);`)
    const before = await rows<{ id: string; slug: string; platform: string }>(db, `select id, slug, platform::text from categories order by slug`)
    const servicesBefore = await rows(db, `select id, category_id from services`)

    await apply(db)

    const after = await rows<{ id: string; slug: string; pslug: string }>(db, `select c.id, c.slug, p.slug pslug from categories c join platforms p on p.id = c.platform_id order by c.slug`)
    expect(after.map((r) => [r.id, r.slug, r.pslug])).toEqual(before.map((r) => [r.id, r.slug, r.platform]))
    expect(await rows(db, `select id, category_id from services`)).toEqual(servicesBefore)
    const rules = await rows<{ name: string; pslug: string | null }>(db, `select r.name, p.slug pslug from price_rules r left join platforms p on p.id = r.platform_id order by r.name`)
    expect(rules).toEqual([{ name: 'Cat rule', pslug: null }, { name: 'Global', pslug: null }, { name: 'Telegram +200%', pslug: 'telegram' }, { name: 'YT', pslug: 'youtube' }])
    // the enum, its columns and the enum type are gone
    expect(await rows(db, `select 1 from pg_type where typname = 'platform_enum'`)).toHaveLength(0)
    expect(await rows(db, `select 1 from information_schema.columns where table_name in ('categories', 'price_rules') and column_name = 'platform'`)).toHaveLength(0)
    // the columns that exist now
    expect(await rows<{ n: string }>(db, `select is_nullable n from information_schema.columns where table_name = 'categories' and column_name = 'platform_id'`)).toEqual([{ n: 'NO' }])
    expect(await rows<{ n: string }>(db, `select is_nullable n from information_schema.columns where table_name = 'price_rules' and column_name = 'platform_id'`)).toEqual([{ n: 'YES' }])
  }, 120_000)

  it('is all-or-nothing: an unmappable row aborts and leaves the old schema intact', async () => {
    const db = await dbBefore()
    await db.exec(`insert into categories(platform, name, slug) values ('telegram', 'TG', 'tg'); delete from platforms where slug = 'telegram';`)
    await expect(apply(db)).rejects.toThrow(/platform migration aborted: 1 categories/)
    expect(await rows(db, `select 1 from information_schema.columns where table_name = 'categories' and column_name = 'platform'`)).toHaveLength(1)
    expect(await rows(db, `select 1 from pg_type where typname = 'platform_enum'`)).toHaveLength(1)
    expect(await rows(db, `select 1 from information_schema.columns where table_name = 'categories' and column_name = 'platform_id'`)).toHaveLength(0)
  }, 120_000)

  describe('after the migration', () => {
    const setup = async () => {
      const db = await dbBefore()
      await apply(db)
      await db.exec(`insert into users(telegram_id, is_admin) values (1, true)`)
      return db
    }

    it('a category needs a platform, which must exist; a platform in use cannot be deleted', async () => {
      const db = await setup()
      await expect(db.exec(`insert into categories(name, slug) values ('x', 'x')`)).rejects.toThrow(/null value|not-null/)
      await expect(db.exec(`insert into categories(platform_id, name, slug) values (gen_random_uuid(), 'x', 'x')`)).rejects.toThrow(/foreign key/)
      await db.exec(`insert into categories(platform_id, name, slug) select id, 'S', 's' from platforms where slug = 'spotify'`) // a platform the old enum never had
      await expect(db.exec(`delete from platforms where slug = 'spotify'`)).rejects.toThrow(/foreign key/)
    }, 120_000)

    it('a price rule still targets at most one scope (platform | category | service)', async () => {
      const db = await setup()
      await db.exec(`insert into categories(platform_id, name, slug) select id, 'C', 'c' from platforms where slug = 'telegram'`)
      await expect(db.exec(`insert into price_rules(name, type, value, platform_id, category_id) select 'both', 'fixed', 1, p.id, c.id from platforms p, categories c where p.slug = 'telegram'`))
        .rejects.toThrow(/single_scope/)
      await db.exec(`insert into price_rules(name, type, value, platform_id) select 'ok', 'fixed', 1, id from platforms where slug = 'tiktok'`)
    }, 120_000)

    it('the admin RPCs keep their JSON shape: platform is still the slug', async () => {
      const db = await setup()
      const admin = (await rows<{ id: string }>(db, `select id from users where is_admin`))[0].id
      await db.exec(`
        insert into categories(platform_id, name, slug) select id, 'Views', 'v' from platforms where slug = 'youtube';
        insert into price_rules(name, type, value, platform_id) select 'YT +10', 'percentage', 10, id from platforms where slug = 'youtube';
        insert into providers(name, api_url) values ('p', 'https://x');
        insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) select id, '1', 's', 1, 1, 1000 from providers;
        insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
          select c.id, 'Svc', ps.id, 2, 1, 1000 from categories c, provider_services ps;`)
      await db.exec(`set role authenticated; select set_config('request.jwt.sub', '${admin}', false)`)
      const rules = (await rows<{ r: { platform: string | null; platform_id: string | null; scope: string }[] }>(db, `select admin_list_price_rules() r`))[0].r
      const view = (await rows<{ r: { platform: string; name: string }[] }>(db, `select get_admin_pricing_view() r`))[0].r
      await db.exec('reset role')
      expect(rules).toEqual([expect.objectContaining({ platform: 'youtube', scope: 'Platform: youtube', platform_id: expect.any(String) })])
      expect(view).toEqual([expect.objectContaining({ platform: 'youtube', name: 'Svc' })])
    }, 120_000)

    it('the PostgREST-style join the app uses: categories filtered by platform slug, inactive platforms hidden', async () => {
      const db = await setup()
      await db.exec(`
        insert into categories(platform_id, name, slug) select id, 'IG', 'ig' from platforms where slug = 'instagram';
        insert into categories(platform_id, name, slug) select id, 'TG', 'tg' from platforms where slug = 'telegram';
        update platforms set active = false where slug = 'telegram';
        set role anon;`)
      // what `categories?select=...,platforms!inner(slug)` does under the anon role: RLS on both tables
      const visible = await rows<{ slug: string; pslug: string }>(db, `select c.slug, p.slug pslug from categories c join platforms p on p.id = c.platform_id where c.is_active order by c.slug`)
      await db.exec('reset role')
      expect(visible).toEqual([{ slug: 'ig', pslug: 'instagram' }])
    }, 120_000)
  })
})

describe('frontend mapping', () => {
  it('a category row with its joined platform becomes the ICategory the UI filters on', () => {
    expect(categoryFromRow({ id: 'c1', platforms: { slug: 'instagram' }, name: 'Followers', slug: 'ig-f', icon_url: null, sort_order: 30 }))
      .toEqual({ id: 'c1', platform: 'instagram', name: 'Followers', slug: 'ig-f', iconUrl: null, sortOrder: 30 })
  })
})
