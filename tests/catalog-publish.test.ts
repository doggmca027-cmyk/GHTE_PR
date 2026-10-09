import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildPublishRows, type PublishCandidate } from '../supabase/functions/_shared/catalog-publish'
import { PUBLISH_CHUNK, syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run'
import { silentLogger } from '../supabase/functions/_shared/logger'
import type { IProviderService } from '../supabase/functions/_shared/types'

const ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// The database function, on the real schema
// ---------------------------------------------------------------------------
describe('publish_provider_services (real schema)', () => {
  let db: PGlite
  let provider: string, other: string
  const ps: Record<string, string> = {}
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, any>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v

  const SERVICES: Array<{ ext: string; name: string; category: string; rate: number; min: number; max: number; type?: string }> = [
    { ext: '1', name: 'Просмотры постов Telegram [❌ Без восстановления] [⏳ Время старта: Мгновенно]', category: 'Просмотры постов Telegram [один пост]', rate: 0.006, min: 10, max: 300000 },
    { ext: '2', name: 'Просмотры постов Telegram [Дёшево]', category: 'Просмотры постов Telegram [один пост]', rate: 0.001, min: 10, max: 100000 },
    { ext: '3', name: 'Лайки Instagram [♻️ Восстановление: 30 дней]', category: 'Лайки Instagram', rate: 1.2, min: 20, max: 5000 },
    { ext: '4', name: 'Подписчики YouTube', category: 'Подписчики YouTube', rate: 10, min: 50, max: 10000 },
    { ext: '5', name: 'Комментарии Instagram', category: 'Комментарии Instagram', rate: 3, min: 10, max: 1000, type: 'Custom Comments' },
    { ext: '6', name: '______', category: 'Лайки Instagram', rate: 0, min: 1, max: 1 },
  ]
  const candidates = async (): Promise<PublishCandidate[]> =>
    (await rows(`select id, name, category_raw, service_type, rate_per_1000, min_quantity, max_quantity from provider_services where provider_id = $1 and is_active order by external_service_id::int`, [provider]))
      .map((r) => ({ id: r.id, name: r.name, categoryRaw: r.category_raw, serviceType: r.service_type, rate: Number(r.rate_per_1000), min: r.min_quantity, max: r.max_quantity }))
  const known = async () => new Set((await rows(`select slug from platforms`)).map((r) => r.slug))
  const publish = async (over: (r: ReturnType<typeof buildPublishRows>['rows']) => unknown = (r) => r) => {
    const built = buildPublishRows(await candidates(), await known())
    return (await rows(`select publish_provider_services($1::uuid, $2::jsonb) r`, [provider, JSON.stringify(over(built.rows))]))[0].r as { categories_changed: number; services_created: number; services_updated: number }
  }

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    provider = await one<string>(`insert into providers(name, api_url) values ('Panel', 'https://p.invalid') returning id v`)
    other = await one<string>(`insert into providers(name, api_url) values ('Other', 'https://o.invalid') returning id v`)
    for (const s of SERVICES) {
      ps[s.ext] = await one<string>(
        `insert into provider_services(provider_id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity, service_type) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id v`,
        [provider, s.ext, s.name, s.category, s.rate, s.min, s.max, s.type ?? 'Default'])
    }
  }, 180_000)

  it('the new columns exist with safe defaults; the sync stores the panel\'s type of service', async () => {
    expect((await rows(`select service_type from provider_services where id = $1`, [ps['5']]))[0].service_type).toBe('Custom Comments')
    const col = (await rows(`select column_default d from information_schema.columns where table_name = 'provider_services' and column_name = 'service_type'`))[0].d
    expect(col).toContain('Default')
  })

  it('creates the categories and the services of every sellable provider service, with offers, facts and the original names', async () => {
    const r = await publish()
    expect(r).toEqual({ categories_changed: 3, services_created: 4, services_updated: 0 }) // the comments and the separator are left out
    const cats = await rows(`select c.name, c.name_i18n, c.source_key, c.active_service_count, p.slug platform from categories c join platforms p on p.id = c.platform_id order by p.slug`)
    expect(cats.map((c) => [c.platform, c.name, c.active_service_count])).toEqual([['instagram', 'Instagram Likes', 1], ['telegram', 'Telegram Post Views [single post]', 2], ['youtube', 'YouTube Subscribers', 1]])
    expect(cats.map((c) => c.platform).sort()).toEqual(['instagram', 'telegram', 'youtube'])
    const tg = cats.find((c) => c.platform === 'telegram')!
    expect(tg).toMatchObject({ name: 'Telegram Post Views [single post]', name_i18n: { ru: 'Просмотры постов Telegram [один пост]' }, active_service_count: 2 })

    const s = (await rows(`select s.name, s.name_i18n, s.attributes, s.customer_rate_per_1000, s.min_quantity, s.max_quantity, s.is_active, s.auto_published from services s where s.primary_provider_service_id = $1`, [ps['1']]))[0]
    expect(s).toMatchObject({
      name: 'Telegram Post Views [no refill] [start: instant]', is_active: true, auto_published: true, min_quantity: 10, max_quantity: 300000,
      name_i18n: { ru: 'Просмотры постов Telegram [Без восстановления] [Время старта: Мгновенно]' }, attributes: { refill: 'none', startMin: 0, startMax: 0 },
    })
    // the bridge trigger gave it an offer from this provider
    expect(await rows(`select 1 from provider_service_offers where provider_service_id = $1 and provider_id = $2 and is_active`, [ps['1'], provider])).toHaveLength(1)
    expect((await rows(`select name from services where primary_provider_service_id = $1`, [ps['3']]))[0].name).toBe('Instagram Likes [refill: 30 days]')
    expect((await rows(`select name from services where primary_provider_service_id = $1`, [ps['4']]))[0].name).toBe('YouTube Subscribers')
    expect(await rows(`select 1 from services where primary_provider_service_id in ($1, $2)`, [ps['5'], ps['6']])).toHaveLength(0)
  })

  it('the first price is the default markup (+150 %), never less than cost + 0.01 per 1000 (the sync re-prices from the real rules next)', async () => {
    const price = async (ext: string) => Number((await rows(`select customer_rate_per_1000 p from services where primary_provider_service_id = $1`, [ps[ext]]))[0].p)
    expect(await price('4')).toBe(25) // 10 x 2.5
    expect(await price('3')).toBe(3) // 1.2 x 2.5
    expect(await price('1')).toBe(0.016) // 0.006 x 2.5 = 0.015 < cost + 0.01
    expect(await price('2')).toBe(0.011)
  })

  it('running it again creates nothing and changes nothing', async () => {
    expect(await publish()).toEqual({ categories_changed: 0, services_created: 0, services_updated: 0 })
  })

  it('a renamed service, a new translation or a facts change refreshes the service, in place (the same row, the same offer)', async () => {
    const before = (await rows(`select id from services where primary_provider_service_id = $1`, [ps['4']]))[0].id
    const r = await publish((rows) => (rows as Array<{ ps: string; name: string; attributes: object }>).map((x) => (x.ps === ps['4'] ? { ...x, name: 'YouTube Subscribers [lifetime refill]', attributes: { refill: 'lifetime' } } : x)))
    expect(r.services_updated).toBe(1)
    const after = (await rows(`select id, name, attributes from services where primary_provider_service_id = $1`, [ps['4']]))[0]
    expect(after).toMatchObject({ id: before, name: 'YouTube Subscribers [lifetime refill]', attributes: { refill: 'lifetime' } })
    await publish() // and back to what the glossary says
    expect((await rows(`select name from services where primary_provider_service_id = $1`, [ps['4']]))[0].name).toBe('YouTube Subscribers')
  })

  it('a service an admin made by hand is never overwritten or duplicated', async () => {
    const id = await one<string>(`select id v from services where primary_provider_service_id = $1`, [ps['4']])
    await db.query(`update services set auto_published = false, name = 'My own name', customer_rate_per_1000 = 99 where id = $1`, [id])
    expect((await publish()).services_updated).toBe(0)
    expect((await rows(`select name, customer_rate_per_1000 p from services where id = $1`, [id]))[0]).toMatchObject({ name: 'My own name', p: '99.0000' })
    expect(await rows(`select 1 from services where primary_provider_service_id = $1`, [ps['4']])).toHaveLength(1)
    await db.query(`update services set auto_published = true, name = 'YouTube Subscribers', customer_rate_per_1000 = 25 where id = $1`, [id])
  })

  it('only this provider\'s active provider services are published; foreign or inactive ones in the payload are ignored', async () => {
    const foreign = await one<string>(`insert into provider_services(provider_id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity) values ($1, '90', 'Лайки TikTok', 'Лайки TikTok', 1, 10, 100) returning id v`, [other])
    const inactive = await one<string>(`insert into provider_services(provider_id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity, is_active) values ($1, '91', 'Лайки TikTok', 'Лайки TikTok', 1, 10, 100, false) returning id v`, [provider])
    const row = (id: string) => ({ ps: id, platform: 'tiktok', cat_key: 'лайки tiktok', cat_name: 'TikTok Likes', cat_name_ru: 'Лайки TikTok', cat_sort: 9, name: 'TikTok Likes', name_ru: 'Лайки TikTok', attributes: {} })
    const r = (await rows(`select publish_provider_services($1::uuid, $2::jsonb) r`, [provider, JSON.stringify([row(foreign), row(inactive)])]))[0].r
    expect(r).toEqual({ categories_changed: 0, services_created: 0, services_updated: 0 })
    expect(await rows(`select 1 from services where primary_provider_service_id in ($1, $2)`, [foreign, inactive])).toHaveLength(0)
  })

  it('refuses a payload that is not a JSON array', async () => {
    await expect(db.query(`select publish_provider_services($1::uuid, '{"a":1}'::jsonb)`, [provider])).rejects.toThrow(/rows must be a json array/)
    await expect(db.query(`select publish_provider_services($1::uuid, null)`, [provider])).rejects.toThrow(/rows must be a json array/)
  })

  it('active_service_count follows the services: deactivated, reactivated, moved to another category, deleted', async () => {
    const count = async (key: string) => Number((await rows(`select active_service_count n from categories where source_key = $1`, [key]))[0].n)
    const tgKey = 'просмотры постов telegram [один пост]'
    expect(await count(tgKey)).toBe(2)
    await db.query(`update services set is_active = false where primary_provider_service_id = $1`, [ps['2']])
    expect(await count(tgKey)).toBe(1)
    await db.query(`update services set is_active = true where primary_provider_service_id = $1`, [ps['2']])
    expect(await count(tgKey)).toBe(2)
    const igKey = 'лайки instagram'
    const igCat = await one<string>(`select id v from categories where source_key = $1`, [igKey])
    await db.query(`update services set category_id = $1 where primary_provider_service_id = $2`, [igCat, ps['2']])
    expect([await count(tgKey), await count(igKey)]).toEqual([1, 2])
    await db.query(`delete from services where primary_provider_service_id = $1`, [ps['2']])
    expect([await count(tgKey), await count(igKey)]).toEqual([1, 1])
    await publish() // brings the deleted one back (it has no offer left to block it? the offer is gone with the service)
  })

  it('the app reads the two new service columns and not auto_published; the sync function is for the service role only', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const [col, ok] of [['name_i18n', true], ['attributes', true], ['auto_published', false], ['primary_provider_service_id', false]] as const) {
        expect((await rows(`select has_column_privilege('${role}', 'public.services', '${col}', 'select') ok`))[0].ok, `${role}.${col}`).toBe(ok)
      }
      expect((await rows(`select has_function_privilege('${role}', 'public.publish_provider_services(uuid, jsonb)', 'execute') ok`))[0].ok).toBe(false)
      expect((await rows(`select has_function_privilege('${role}', 'public.recount_categories(uuid[])', 'execute') ok`))[0].ok).toBe(false)
    }
    expect((await rows(`select has_function_privilege('service_role', 'public.publish_provider_services(uuid, jsonb)', 'execute') ok`))[0].ok).toBe(true)
  })

  it('the panel\'s own description reaches the storefront service, is refreshed, and never overwrites a service an admin made by hand', async () => {
    const withText = (text: string | null) => (rs: ReturnType<typeof buildPublishRows>['rows']) => rs.map((x) => (x.ps === ps['3'] || x.ps === ps['4'] ? { ...x, description: text } : x))
    const desc = async (ext: string) => (await rows(`select s.description from services s where s.primary_provider_service_id = $1`, [ps[ext]]))[0].description
    await publish(withText('Refill: 30 days\nSupport: yes'))
    expect(await desc('3')).toBe('Refill: 30 days\nSupport: yes')
    await publish(withText('Changed text'))
    expect(await desc('3')).toBe('Changed text')
    await publish(withText(null))
    expect(await desc('3')).toBeNull()

    await db.query(`update services set auto_published = false, description = 'Hand written' where primary_provider_service_id = $1`, [ps['4']])
    await publish(withText('From the panel'))
    expect(await desc('4')).toBe('Hand written')
    await db.query(`update services set auto_published = true, description = null where primary_provider_service_id = $1`, [ps['4']])
  })

  it('a customer reads the published services through the app\'s own query: the English name, the original and the facts', async () => {
    await db.exec(`reset role; set role anon`)
    const r = await rows(`select name, name_i18n, attributes from services where is_active order by customer_rate_per_1000 limit 1`)
    await db.exec(`reset role`)
    expect(r[0].name).toContain('Telegram Post Views')
    expect(r[0].name_i18n.ru).toContain('Просмотры постов')
  })
})

// ---------------------------------------------------------------------------
// The sync run publishing through its store port
// ---------------------------------------------------------------------------
describe('the catalog sync publishes what it just stored', () => {
  const svc = (id: string, o: Partial<IProviderService> = {}): IProviderService => ({
    externalServiceId: id, name: 'Просмотры постов Telegram [Без восстановления]', type: 'Default', categoryRaw: 'Просмотры постов Telegram [один пост]',
    ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false, ...o,
  })

  class Store implements CatalogStore {
    published: Array<{ providerId: string; rows: ReturnType<typeof buildPublishRows>['rows'] }> = []
    failPublish = false
    async loadProviderServices() { return [] }
    async upsertProviderServices(rows: Array<{ external_service_id: string }>) { return rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })) }
    async flagAnomaly() {}
    async loadOffers() { return [] }
    async updateOffers() {}
    async deactivateProviderServices() {}
    async loadLinkedServices() { return [] }
    async loadServiceOffers() { return [] }
    async updateServices() {}
    async saveBalance() {}
    async loadPlatformSlugs() { return ['telegram', 'other'] }
    async publishServices(providerId: string, rows: ReturnType<typeof buildPublishRows>['rows']) {
      if (this.failPublish) throw new Error('rpc down')
      this.published.push({ providerId, rows })
      return { categories_changed: 1, services_created: rows.length, services_updated: 0 }
    }
  }
  const run = (services: IProviderService[], store: CatalogStore) =>
    syncProviderCatalog({ provider: { id: 'prov', name: 'Panel' }, adapter: { getServices: async () => services, getBalance: async () => ({ balance: 1, currency: 'USD' }) }, store, rules: [], log: silentLogger })

  it('hands over a row for every sellable service, with the id the upsert gave it, and reports the totals', async () => {
    const store = new Store()
    const report = await run([svc('1'), svc('2'), svc('3', { type: 'Package' }), svc('4', { ratePer1000: 0, minQuantity: 1, maxQuantity: 1, name: '______' })], store)
    expect(report.status).toBe('ok')
    expect(store.published).toHaveLength(1)
    expect(store.published[0].providerId).toBe('prov')
    expect(store.published[0].rows.map((r) => r.ps)).toEqual(['ps-1', 'ps-2'])
    expect(store.published[0].rows[0]).toMatchObject({ platform: 'telegram', name: 'Telegram Post Views [no refill]' })
    expect(report.published).toEqual({ created: 2, updated: 0, categories: 1, skipped: 2, untranslatedServices: 0, untranslatedCategories: 0 })
  })

  it('sends a big catalogue in chunks', async () => {
    const store = new Store()
    const n = PUBLISH_CHUNK * 2 + 50
    await run(Array.from({ length: n }, (_, i) => svc(String(i + 1))), store)
    expect(store.published.map((p) => p.rows.length)).toEqual([PUBLISH_CHUNK, PUBLISH_CHUNK, 50])
  })

  it('a failed publish is reported as a warning and does not fail or stop the sync', async () => {
    const store = new Store()
    store.failPublish = true
    const report = await run([svc('1')], store)
    expect(report.status).toBe('ok')
    expect(report.warning).toContain('publishing failed: rpc down')
    expect(report.published).toBeUndefined()
  })

  it('a provider with routing switched off is imported and kept current, but nothing of it reaches the storefront', async () => {
    const store = new Store()
    const report = await syncProviderCatalog({
      provider: { id: 'prov', name: 'Panel', routing_enabled: false },
      adapter: { getServices: async () => [svc('1'), svc('2')], getBalance: async () => ({ balance: 1, currency: 'USD' }) },
      store, rules: [], log: silentLogger,
    })
    expect(report.status).toBe('ok')
    expect(report.added).toBe(2)
    expect(store.published).toHaveLength(0)
    expect(report.published).toBeUndefined()
  })

  it('the hourly run only syncs providers that sell; one with routing off is synced when it is asked for by id (source check)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/sync-catalog/index.ts'), 'utf8')
    expect(src).toContain("q = onlyProvider ? q.eq('id', onlyProvider) : q.eq('routing_enabled', true)")
    expect(src).toContain("select('id, name, api_url, api_key_encrypted, routing_enabled')")
  })

  it('a store that cannot publish simply publishes nothing', async () => {
    const store = new Store()
    Object.defineProperty(store, 'publishServices', { value: undefined }) // an instance without the optional method
    const report = await run([svc('1')], store)
    expect(report.status).toBe('ok')
    expect(report.published).toBeUndefined()
  })

  it('the sync sends the panel\'s own text to the database and to the publisher, and a changed text counts as an update', async () => {
    const store = new Store()
    let sent: Array<{ description: string | null }> = []
    store.upsertProviderServices = async (rows) => { sent = rows as unknown as typeof sent; return rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })) }
    await run([svc('1', { description: '  Refill: no  ' }), svc('2')], store)
    expect(sent.map((r) => r.description)).toEqual(['Refill: no', null])
    expect(store.published[0].rows.map((r) => r.description)).toEqual(['Refill: no', null])

    store.loadProviderServices = async () => [
      { id: 'ps-1', external_service_id: '1', name: 'Просмотры постов Telegram [Без восстановления]', category_raw: 'Просмотры постов Telegram [один пост]', rate_per_1000: 1, min_quantity: 10, max_quantity: 1000, refill_supported: false, cancel_supported: false, service_type: 'Default', description: 'Old text', is_active: true },
    ] as never
    const report = await run([svc('1', { description: 'New text' })], store)
    expect(report.updated).toBe(1)
  })

  it('the sync sends the panel\'s type of service to the database (provider_services.service_type)', async () => {
    const store = new Store()
    let sent: Array<{ service_type: string }> = []
    store.upsertProviderServices = async (rows) => { sent = rows as unknown as typeof sent; return rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })) }
    await run([svc('1'), svc('2', { type: 'Custom Comments' }), svc('3', { type: '' })], store)
    expect(sent.map((r) => r.service_type)).toEqual(['Default', 'Custom Comments', 'Default'])
  })
})
