// Publishing an English donor catalogue (providers.publish_mapping = 'canonical', migration 20261205000000): one storefront category per
// platform and action, an existing one when the storefront already has exactly that.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCanonicalPublishRows, detectAction, genericLabel, type PublishCandidate } from '../supabase/functions/_shared/catalog-publish.ts'
import { syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run.ts'
import { silentLogger } from '../supabase/functions/_shared/logger.ts'

const SLUGS = new Set(['telegram', 'instagram', 'twitter', 'spotify', 'website', 'other'])
const cand = (id: string, categoryRaw: string, name: string, o: Partial<PublishCandidate> = {}): PublishCandidate =>
  ({ id, name, categoryRaw, serviceType: 'Default', rate: 1, min: 10, max: 1000, ...o })

describe('canonical mapping', () => {
  it('the action comes from the category, then the name; the specific one wins', () => {
    expect(detectAction('Instagram Followers [Guaranteed]').key).toBe('followers')
    expect(detectAction('Instagram Story Views').key).toBe('story')
    expect(detectAction('YouTube Live Stream Views').key).toBe('live')
    expect(detectAction('Youtube Comment Likes').key).toBe('comment-likes')
    expect(detectAction('Telegram', 'Telegram Post Reactions [Positive]').key).toBe('reactions')
    expect(detectAction('Telegram Premium', 'Something').key).toBe('other')
  })

  it('a storefront category matches only when it is exactly the platform and the action', () => {
    expect(genericLabel('Twitter (X) Followers', ['Twitter (X)', 'Twitter'])).toBe('followers')
    expect(genericLabel('Instagram Likes', ['Instagram'])).toBe('likes')
    expect(genericLabel('Telegram AI Members', ['Telegram'])).toBe('ai members')
    expect(genericLabel('Instagram Followers [Flag OFF]', ['Instagram'])).toBeNull()
    expect(genericLabel('Комментарии Instagram', ['Instagram'])).toBeNull()
  })

  it('existing exact categories are reused; anything else gets one category per platform and action, in both languages', () => {
    const existing = [
      { id: 'cat-ig-likes', platform: 'instagram', name: 'Instagram Likes' },
      { id: 'cat-tg-ai', platform: 'telegram', name: 'Telegram AI Members' },
      { id: 'cat-x', platform: 'twitter', name: 'Twitter (X) Followers' },
    ]
    const b = buildCanonicalPublishRows([
      cand('1', 'Instagram Likes [Real]', 'Instagram Likes [Refill: 30D]'),
      cand('2', 'X - Twitter Followers', 'Twitter Followers [Max: 10K]'),
      cand('3', 'Telegram Members', 'Telegram Members [Refill: 30D]'),
      cand('4', 'Telegram Channel Members [Country]', 'Telegram Members [Iran]'),
      cand('5', 'Website Traffic from Google', 'Website Traffic [USA]'),
      cand('6', 'Rumble.com Views - Targeted', 'Rumble Views [USA]'),
      cand('7', 'Instagram Likes', 'Custom', { serviceType: 'Custom Comments' }),
    ], SLUGS, existing)
    const by = Object.fromEntries(b.rows.map((r) => [r.ps, r]))
    expect(by['1']).toMatchObject({ cat_id: 'cat-ig-likes', platform: 'instagram' })
    expect(by['2']).toMatchObject({ cat_id: 'cat-x', platform: 'twitter' })
    // "AI members" is another product: never the home of plain members
    expect(by['3']).not.toHaveProperty('cat_id')
    expect(by['3']).toMatchObject({ cat_key: 'canonical:telegram:members', cat_name: 'Telegram Members', cat_name_ru: 'Участники Telegram' })
    expect(by['4'].cat_key).toBe(by['3'].cat_key) // two panel categories, one storefront category
    expect(by['5']).toMatchObject({ platform: 'website', cat_name: 'Website Traffic', cat_name_ru: 'Трафик Website' })
    // a platform the storefront has no section for: under "other", still named after the platform
    expect(by['6']).toMatchObject({ platform: 'other', cat_name: 'Rumble Views', cat_name_ru: 'Просмотры Rumble' })
    expect(b.skipped).toBe(1)
    const unknown = buildCanonicalPublishRows([cand('8', 'Some Site Views', 'Some Site Views [USA]')], SLUGS, existing).rows[0]
    expect(unknown).toMatchObject({ platform: 'other', cat_name: 'Views (Other platforms)', cat_name_ru: 'Просмотры (Другие площадки)' })
  })
})

describe('publish_provider_services with an existing category', () => {
  let db: PGlite
  const PROV = '00000000-0000-4000-8000-0000000b0001'
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into providers (id, name, api_url, routing_enabled, catalog_mode, publish_mapping) values ('${PROV}', 'JAP', 'https://j', true, 'publish', 'canonical')`)
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('puts the service into the named category without renaming it; a new key makes one new category', async () => {
    const cat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug, name_i18n) values ((select id from platforms where slug='instagram'), 'Instagram Likes', 'ig-likes', '{"ru":"Лайки Instagram"}') returning id`)).rows[0].id
    const ps = async (ext: string) => (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('${PROV}', $1, $1, 1, 10, 1000) returning id`, [ext])).rows[0].id
    const [a, b, c] = [await ps('a'), await ps('b'), await ps('c')]
    const row = (id: string, o: Record<string, unknown>) => ({ ps: id, platform: 'instagram', cat_key: 'canonical:instagram:likes', cat_name: 'Instagram Likes', cat_name_ru: 'Лайки Instagram', cat_sort: 1000, name: `S ${id}`, name_ru: `S ${id}`, attributes: {}, description: null, ...o })
    const r = (await db.query<{ r: Record<string, number> }>(`select publish_provider_services($1, $2) r`, [PROV, JSON.stringify([
      row(a, { cat_id: cat, cat_name: 'Something else' }),
      row(b, { cat_key: 'canonical:instagram:followers', cat_name: 'Instagram Followers', cat_name_ru: 'Подписчики Instagram' }),
      row(c, { cat_key: 'canonical:instagram:followers', cat_name: 'Instagram Followers', cat_name_ru: 'Подписчики Instagram' }),
    ])])).rows[0].r
    expect(r).toMatchObject({ categories_changed: 1, services_created: 3 })
    const svc = async (id: string) => (await db.query<{ cat: string; name: string }>(`select c.name cat, s.name from services s join categories c on c.id = s.category_id where s.primary_provider_service_id = $1`, [id])).rows[0]
    expect(await svc(a)).toEqual({ cat: 'Instagram Likes', name: `S ${a}` })
    expect(await svc(b)).toMatchObject({ cat: 'Instagram Followers' })
    expect((await svc(c)).cat).toBe('Instagram Followers')
    expect((await db.query<{ n: number }>(`select count(*)::int n from categories where name = 'Instagram Followers'`)).rows[0].n).toBe(1)
    expect((await db.query<{ name: string }>(`select name from categories where id = $1`, [cat])).rows[0].name).toBe('Instagram Likes')
  })

  it('a category of another platform is never used', async () => {
    const tg = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'Telegram X', 'tg-x') returning id`)).rows[0].id
    const ps = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('${PROV}', 'd', 'd', 1, 10, 1000) returning id`)).rows[0].id
    await db.query(`select publish_provider_services($1, $2)`, [PROV, JSON.stringify([{ ps, platform: 'instagram', cat_key: 'canonical:instagram:views', cat_name: 'Instagram Views', cat_name_ru: 'Просмотры Instagram', cat_sort: 1001, name: 'V', name_ru: 'V', attributes: {}, description: null, cat_id: tg }])])
    expect((await db.query<{ cat: string }>(`select c.name cat from services s join categories c on c.id = s.category_id where s.primary_provider_service_id = $1`, [ps])).rows[0].cat).toBe('Instagram Views')
  })
})

describe('the sync picks the mapping of the provider', () => {
  it('canonical providers go through the canonical mapping with the storefront categories', async () => {
    const published: unknown[][] = []
    const store = {
      loadProviderServices: async () => [], touchProviderServices: async () => {},
      upsertProviderServices: async (rows: { external_service_id: string }[]) => rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })),
      flagAnomaly: async () => {}, loadOffers: async () => [], updateOffers: async () => {}, deactivateProviderServices: async () => {},
      loadLinkedServices: async () => [], loadServiceOffers: async () => [], updateServices: async () => {}, saveBalance: async () => {},
      loadPlatformSlugs: async () => ['instagram', 'other'],
      loadCategories: async () => [{ id: 'cat-ig-likes', platform: 'instagram', name: 'Instagram Likes' }],
      publishServices: async (_p: string, rows: unknown[]) => { published.push(rows); return { categories_changed: 0, services_created: rows.length, services_updated: 0 } },
    } as unknown as CatalogStore
    const one = { externalServiceId: '1', name: 'Instagram Likes [Refill: 30D]', type: 'Default', categoryRaw: 'Instagram Likes', ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false }
    const adapter = { getServices: async () => [one], getBalance: async () => ({ balance: 1, currency: 'USD' }) }
    await syncProviderCatalog({ provider: { id: 'p', name: 'JAP', routing_enabled: true, catalog_mode: 'publish', publish_mapping: 'canonical' }, adapter, store, rules: [], log: silentLogger })
    expect(published[0]).toEqual([expect.objectContaining({ ps: 'ps-1', cat_id: 'cat-ig-likes' })])
    published.length = 0
    await syncProviderCatalog({ provider: { id: 'p', name: 'Center', routing_enabled: true, catalog_mode: 'publish' }, adapter, store, rules: [], log: silentLogger })
    expect(published[0]).toEqual([expect.not.objectContaining({ cat_id: expect.anything() })])
  })
})
