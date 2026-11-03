// Articles of the cards that still carry the code of a provider that is off (migration 20261231000100): each such card takes the article of the panel
// service that serves it today.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261231000100_reissue_retired_skus.sql'
const P = { center: '00000000-0000-4000-8000-0000000d0001', root: '00000000-0000-4000-8000-0000000d0002', sec: '00000000-0000-4000-8000-0000000d0003', jap: '00000000-0000-4000-8000-0000000d0004' }
const QUALITY = 'Instagram Followers [refill: 30 days]'

const freshDb = async (upTo?: string) => {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && (!upTo || x < upTo)).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  return db
}

describe('re-issuing the articles of a provider that is off', () => {
  let db: PGlite
  let category: string
  const id: Record<string, string> = {}
  const panel = async (provider: string, external: string, name: string, rate = 0.5) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 10, 100000) returning id`, [provider, external, name, rate])).rows[0].id
  const card = async (name: string, primary: string, active = true) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 100, 10000, $4) returning id`, [category, name, primary, active])).rows[0].id
  const link = (service: string, provider: string, source: string, cost: number) =>
    db.query(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 10, 100000, true)`, [service, provider, source, cost])
  const sku = async (service: string) => (await db.query<{ sku: string | null }>(`select sku from services where id = $1`, [service])).rows[0].sku
  const panelSku = async (source: string) => (await db.query<{ sku: string }>(`select sku from provider_services where id = $1`, [source])).rows[0].sku

  beforeAll(async () => {
    db = await freshDb(MIGRATION)
    await db.exec(`
      insert into providers (id, name, api_url, is_active, routing_enabled, health_status) values
        ('${P.center}', 'SMM Center', 'https://c', false, false, 'disabled'), ('${P.root}', 'RootPanel', 'https://r', true, true, 'healthy'), ('${P.jap}', 'JAP', 'https://j', true, true, 'healthy');
      insert into providers (id, name, api_url, is_active, routing_enabled, health_status, is_premium) values ('${P.sec}', 'Secsers', 'https://s', true, true, 'healthy', true);`)
    category = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'instagram'), 'Followers', 'followers-reissue') returning id`)).rows[0].id

    const old = { quality: await panel(P.center, '101', QUALITY), plain: await panel(P.center, '102', 'Instagram Likes'), twin: await panel(P.center, '103', 'Instagram Views'), dead: await panel(P.center, '104', 'Instagram Saves'), off: await panel(P.center, '105', 'Instagram Shares') }
    const rootOwn = await panel(P.root, '300', 'Instagram Views')
    const rootQuality = await panel(P.root, '301', QUALITY, 0.5)
    const secQuality = await panel(P.sec, '302', QUALITY, 0.9)
    const rootLikes = await panel(P.root, '303', 'Instagram Likes', 0.4)
    const japLikes = await panel(P.jap, '304', 'Instagram Likes', 0.2)

    id.quality = await card(QUALITY, old.quality) // a quality card: the premium panel's service wins whatever it costs
    await link(id.quality, P.root, rootQuality, 0.5); await link(id.quality, P.sec, secQuality, 0.9)
    id.plain = await card('Instagram Likes', old.plain) // a card that promises nothing: the cheapest wins
    await link(id.plain, P.root, rootLikes, 0.4); await link(id.plain, P.jap, japLikes, 0.2)
    id.own = await card('Instagram Views', rootOwn) // its own article is an active provider's already
    id.twin = await card('Instagram Views', old.twin) // served by the service that is the primary of id.own
    await link(id.twin, P.root, rootOwn, 0.5)
    id.dead = await card('Instagram Saves', old.dead) // no working offer: nothing to take the article from
    id.off = await card('Instagram Shares', old.off, false) // not on the storefront: left alone
    id.rootCard = await card('Instagram Views', await panel(P.root, '306', 'Instagram Views'))
    id.secPanel = secQuality
    id.rootLikes = rootLikes
    id.japLikes = japLikes
    id.rootQuality = rootQuality
    id.rootOwn = rootOwn
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('before: the cards carry the code of the provider that is off', async () => {
    for (const service of [id.quality, id.plain, id.twin, id.dead, id.off]) expect(await sku(service)).toMatch(/-SMMC10\d$/)
  })

  it('after: a card takes the article of the service that serves it today; the choice is the router\'s (quality first, then the cost)', async () => {
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    expect(await sku(id.quality)).toBe(await panelSku(id.secPanel))
    expect(await sku(id.plain)).toBe(await panelSku(id.japLikes))
    expect(await sku(id.quality)).toMatch(/-SEC302$/)
    expect(await sku(id.plain)).toMatch(/-JAP304$/)
  })

  it('an article that is another card\'s own is told apart by four capitals of the id; the other card keeps its plain article', async () => {
    const own = await sku(id.own)
    expect(own).toBe(await panelSku(id.rootOwn))
    expect(await sku(id.twin)).toMatch(new RegExp(`^${own}-[0-9A-F]{4}$`))
  })

  it('a card with no working offer, an inactive card and a card of a provider that is on are not touched', async () => {
    expect(await sku(id.dead)).toMatch(/-SMMC104$/)
    expect(await sku(id.off)).toMatch(/-SMMC105$/)
    expect(await sku(id.rootCard)).toMatch(/-ROOT306$/)
  })

  it('every article is still unique, and running it again changes nothing', async () => {
    const before = (await db.query<{ id: string; sku: string }>(`select id, sku from services order by id`)).rows
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    expect((await db.query<{ id: string; sku: string }>(`select id, sku from services order by id`)).rows).toEqual(before)
    expect(new Set(before.map((r) => r.sku)).size).toBe(before.length)
  })

  it('the cards that come get a suffix in capitals, the way the search looks an article up', async () => {
    const twinOfOwn = await card('Instagram Views', id.rootOwn)
    expect(await sku(twinOfOwn)).toMatch(/^IG-VIEW-STD-ROOT300-[0-9A-F]{4}$/)
  })
})
