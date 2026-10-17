// Donors fill the gaps of the storefront (providers.fill_gaps, migration 20261212000000): which places are empty, which donor services go
// there, how twins are handled, and the sync step that does it.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FILL_PER_CELL, canonicalPlace, chooseGapFillers, isGap, isLinkAndQuantity, isPublishable, nichePlatform, referenceCells, type PublishCandidate,
} from '../supabase/functions/_shared/catalog-publish.ts'
import { FILL_BUDGET, syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run.ts'
import { silentLogger } from '../supabase/functions/_shared/logger.ts'

const SLUGS = new Set(['telegram', 'instagram', 'twitter', 'youtube', 'twitch', 'kick', 'website', 'roblox', 'w-tv', 'tripadvisor', 'trustpilot', 'yandex-music', 'yandex-maps', 'fiverr', 'periscope', 'other'])
let n = 0
const cand = (categoryRaw: string, name: string, o: Partial<PublishCandidate> & { fingerprint?: string | null } = {}) =>
  ({ id: `ps-${++n}`, name, categoryRaw, serviceType: 'Default', rate: 1, min: 10, max: 1000, ...o })

describe('niche platforms and panels that name the action in the type', () => {
  it('a niche platform is told by the CATEGORY, never by a name that merely mentions it', () => {
    expect(nichePlatform('Roblox Followers', SLUGS)?.slug).toBe('roblox')
    expect(nichePlatform('W.TV Live Viewers', SLUGS)?.slug).toBe('w-tv')
    expect(canonicalPlace(cand('Roblox Likes', 'Roblox Game Favorites'), SLUGS).platform.slug).toBe('roblox')
    // "Fiverr" is one of the referrers of a website traffic service: still website traffic
    expect(canonicalPlace(cand('Website Traffic from Brazil', 'Website Traffic [Choose Referrer: Fiverr, Google]'), SLUGS).platform.slug).not.toBe('fiverr')
    // a niche platform the registry does not have stays unknown
    expect(nichePlatform('Roblox Followers', new Set(['telegram']))).toBeNull()
  })

  it('Yandex Music and Tripadvisor get their own platforms; the shared reviews category stays with Trustpilot', () => {
    expect(canonicalPlace(cand('Yandex Music', 'Yandex Music Plays'), SLUGS).platform.slug).toBe('yandex-music')
    expect(canonicalPlace(cand('Яндекс Музыка', 'Прослушивания'), SLUGS).platform.slug).toBe('yandex-music')
    expect(canonicalPlace(cand('Tripadvisor Reviews', 'Tripadvisor Reviews [USA]'), SLUGS).platform.slug).toBe('tripadvisor')
    expect(canonicalPlace(cand('Отзывы [Trustpilot / Yelp / BBB / Tripadvisor]', 'Отзывы'), SLUGS).platform.slug).toBe('trustpilot')
  })

  it('RootPanel types: link-and-quantity actions sell as they are; comments, reviews, polls, packages and accounts do not', () => {
    for (const t of ['Followers', 'Live Viewers', 'Post Reactions', 'Track & Playlist Plays', 'Installs & Downloads']) expect(isLinkAndQuantity(t, 'X')).toBe(true)
    for (const t of ['Comments', 'Reviews & Ratings', 'Votes & Polls', 'Packages', 'Accounts & Registrations', 'Other Services', 'Tools & Access']) expect(isLinkAndQuantity(t, 'X')).toBe(false)
    expect(isLinkAndQuantity('Followers', 'Followers [Custom Comments]')).toBe(false)
    expect(isLinkAndQuantity('Members', 'Real Subscription for 2 Days')).toBe(false)
    expect(isLinkAndQuantity('Likes', 'Telegram Vote/Likes')).toBe(false)
    expect(isLinkAndQuantity('Default', 'anything')).toBe(true)
    expect(isPublishable(cand('Roblox Followers', 'Roblox Followers [30D]', { serviceType: 'Followers' }))).toBe(true)
    expect(isPublishable(cand('Topick Comments', 'Topick Comments', { serviceType: 'Comments' }))).toBe(false)
  })

  it('the type names the action when it can ("Post Reactions" in a "Members" category is reactions)', () => {
    expect(canonicalPlace(cand('Instagram Members', 'Instagram Channel Post', { serviceType: 'Post Reactions' }), SLUGS).action.key).toBe('reactions')
    expect(canonicalPlace(cand('YouTube Plays', 'Youtube Live Stream', { serviceType: 'Live Stream Viewers' }), SLUGS).action.key).toBe('live')
  })
})

describe('the empty places', () => {
  const ref = referenceCells([
    { platform: 'telegram', category: 'Telegram Post Views', name: 'Telegram Post Views [1 post]' },
    { platform: 'twitter', category: 'X (Twitter)', name: 'Twitter Followers [Real]' },
    { platform: 'twitter', category: 'X (Twitter)', name: 'Twitter Tweet Views' },
  ])

  it('a platform without reference services is empty; on a covered one only the actions it does not sell', () => {
    expect(isGap('roblox', 'followers', ref)).toBe(true)
    expect(isGap('roblox', 'other', ref)).toBe(true)
    expect(isGap('twitter', 'followers', ref)).toBe(false) // told by the service's name inside a catch-all category
    expect(isGap('twitter', 'views', ref)).toBe(false)
    expect(isGap('twitter', 'plays', ref)).toBe(true) // Spaces listeners
    expect(isGap('twitter', 'other', ref)).toBe(false)
  })

  it('never: the catch-all platform, a closed one, traffic, votes and reviews', () => {
    for (const [p, a] of [['other', 'likes'], ['periscope', 'followers'], ['roblox', 'traffic'], ['twitter', 'traffic'], ['roblox', 'votes'], ['roblox', 'reviews']]) {
      expect(isGap(p, a, ref)).toBe(false)
    }
  })

  it('at most FILL_PER_CELL per place, the cheapest, fingerprint twins counted once', () => {
    const many = Array.from({ length: 15 }, (_, i) => cand('Roblox Followers', `Roblox Followers ${i}`, { serviceType: 'Followers', rate: 15 - i, fingerprint: i >= 12 ? 'same' : `fp${i}` }))
    const chosen = chooseGapFillers(many, SLUGS, ref)
    expect(chosen).toHaveLength(FILL_PER_CELL)
    expect(chosen[0].rate).toBe(1) // the cheapest first
    expect(chosen.filter((c) => c.fingerprint === 'same')).toHaveLength(1)
  })

  it('what a covered place already sells, or a name about another platform, stays out', () => {
    const chosen = chooseGapFillers([
      cand('Twitter Space Listeners', 'Twitter Space Listeners [15 Min]'),
      cand('Twitter Live', 'Twitter Tweet Views [Refill: No Drop]'), // the panel files it under "Live": views are on sale already
      cand('Twitter Services', 'YouTube Subscribers [No Refill]'), // a mixed panel category
      cand('Telegram Likes', 'Youtube Referrer Likes [Telegram.org]'), // a referrer
      cand('Roblox Followers', 'Roblox Followers', { serviceType: 'Comments' }), // not sellable as it is
    ], SLUGS, ref)
    expect(chosen.map((c) => c.name)).toEqual(['Twitter Space Listeners [15 Min]'])
  })
})

describe('fill_storefront_gaps', () => {
  let db: PGlite
  const REF = '00000000-0000-4000-8000-0000000f0001'
  const JAP = '00000000-0000-4000-8000-0000000f0002'
  const RP = '00000000-0000-4000-8000-0000000f0003'
  const OFF = '00000000-0000-4000-8000-0000000f0004'
  const ps = async (provider: string, ext: string, name: string, rate = 1, min = 10, max = 1000) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, $5, $6) returning id`, [provider, ext, name, rate, min, max])).rows[0].id
  const row = (id: string, platform: string, action: string, name: string) => ({ ps: id, platform, cat_key: `canonical:${platform}:${action}`, cat_name: `${platform} ${action}`, cat_name_ru: `${platform} ${action}`, cat_sort: 1000, name, name_ru: name, attributes: {}, description: null })
  const fill = async (provider: string, rows: unknown[]) => (await db.query<{ r: Record<string, number> }>(`select fill_storefront_gaps($1, $2) r`, [provider, JSON.stringify(rows)])).rows[0].r
  const cardOf = async (id: string) => (await db.query<{ active: boolean; cat: string; cat_active: boolean }>(`select s.is_active active, c.name cat, c.is_active cat_active from services s join categories c on c.id = s.category_id where s.primary_provider_service_id = $1`, [id])).rows[0]

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers (id, name, api_url, routing_enabled, catalog_mode, publish_mapping, fill_gaps) values
        ('${REF}', 'Center', 'https://c', true, 'publish', 'translate', false),
        ('${JAP}', 'JAP', 'https://j', true, 'linked_only', 'canonical', true),
        ('${RP}', 'RootPanel', 'https://r', true, 'linked_only', 'translate', true),
        ('${OFF}', 'SMMStone', 'https://s', true, 'linked_only', 'translate', false)`)
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('publishes into the empty place; the reference catalogue and the donors in it are untouched', async () => {
    const a = await ps(RP, 'r1', 'Roblox Followers [30 Day Refill]', 1.05)
    const r = await fill(RP, [row(a, 'roblox', 'followers', 'Roblox Followers [30 Day Refill]')])
    expect(r).toMatchObject({ services_created: 1, linked: 0, reactivated: 0 })
    expect(await cardOf(a)).toMatchObject({ active: true, cat: 'roblox followers', cat_active: true })
    // the card sells through its offer (created with the card)
    expect((await db.query<{ n: number }>(`select count(*)::int n from provider_service_offers where provider_service_id = $1`, [a])).rows[0].n).toBe(1)
  })

  it('a donor service that is exactly a card on sale backs that card instead of repeating it', async () => {
    const original = await ps(RP, 'r2', 'Roblox Likes [No Refill]', 2, 10, 1000)
    await fill(RP, [row(original, 'roblox', 'likes', 'Roblox Likes [No Refill]')])
    const twin = await ps(JAP, 'j2', 'Roblox Likes [No Refill]', 1.5, 10, 5000)
    const r = await fill(JAP, [row(twin, 'roblox', 'likes', 'Roblox Likes [No Refill]')])
    expect(r).toMatchObject({ services_created: 0, linked: 1, twins: 1 })
    expect(await cardOf(twin)).toBeUndefined()
    const offers = (await db.query<{ provider_id: string }>(`select o.provider_id from provider_service_offers o join services s on s.id = o.service_id where s.primary_provider_service_id = $1 order by o.routing_score desc`, [original])).rows
    expect(offers.map((o) => o.provider_id)).toEqual([RP, JAP])
  })

  it('twins among the rows of one run: one card, the cheapest', async () => {
    const dear = await ps(JAP, 'j3', 'Roblox Members [Real]', 3)
    const cheap = await ps(JAP, 'j4', 'Roblox Members [Real]', 1)
    const r = await fill(JAP, [row(dear, 'roblox', 'members', 'Roblox Members [Real]'), row(cheap, 'roblox', 'members', 'Roblox Members [Real]')])
    expect(r).toMatchObject({ services_created: 1 })
    expect(await cardOf(cheap)).toMatchObject({ active: true })
    expect(await cardOf(dear)).toBeUndefined()
  })

  it('a card the compaction hid comes back with its category when it fills a gap', async () => {
    const hidden = await ps(JAP, 'j5', 'Roblox Group Members [Fast]', 1)
    await fill(JAP, [row(hidden, 'roblox', 'groups', 'Roblox Group Members [Fast]')])
    await db.exec(`update services set is_active = false where primary_provider_service_id = '${hidden}';
      update categories set is_active = false where source_key = 'canonical:roblox:groups'`)
    const r = await fill(JAP, [row(hidden, 'roblox', 'groups', 'Roblox Group Members [Fast]')])
    expect(r).toMatchObject({ services_created: 0, reactivated: 1 })
    expect(await cardOf(hidden)).toMatchObject({ active: true, cat_active: true })
  })

  it('a provider without fill_gaps writes nothing', async () => {
    const x = await ps(OFF, 's1', 'Roblox Visits [USA]', 1)
    expect(await fill(OFF, [row(x, 'roblox', 'visits', 'Roblox Visits [USA]')])).toEqual({ skipped: true })
    expect(await cardOf(x)).toBeUndefined()
  })

  it('only the database itself may call it', async () => {
    const r = (await db.query<{ anon: boolean; svc: boolean }>(`select has_function_privilege('anon', 'public.fill_storefront_gaps(uuid, jsonb)', 'execute') anon, has_function_privilege('service_role', 'public.fill_storefront_gaps(uuid, jsonb)', 'execute') svc`)).rows[0]
    expect(r).toEqual({ anon: false, svc: true })
    const ref = (await db.query<{ r: unknown[] }>(`select storefront_reference_services() r`)).rows[0].r
    expect(Array.isArray(ref)).toBe(true)
  })
})

describe('the sync step', () => {
  const makeStore = () => {
    const calls = { fill: [] as unknown[][], publish: 0, regroup: 0 }
    const store = {
      loadProviderServices: async () => [], touchProviderServices: async () => {},
      upsertProviderServices: async (rows: { external_service_id: string }[]) => rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })),
      flagAnomaly: async () => {}, loadOffers: async () => [], updateOffers: async () => {}, deactivateProviderServices: async () => {},
      loadLinkedServices: async () => [], loadServiceOffers: async () => [], updateServices: async () => {}, saveBalance: async () => {},
      loadPlatformSlugs: async (activeOnly?: boolean) => (activeOnly ? ['twitter', 'roblox', 'other'] : ['twitter', 'roblox', 'periscope', 'other']),
      loadCategories: async () => [],
      loadReferenceServices: async () => [{ platform: 'twitter', category: 'Twitter Followers', name: 'Twitter Followers' }],
      publishServices: async () => { calls.publish++; return { categories_changed: 0, services_created: 0, services_updated: 0 } },
      fillGaps: async (_p: string, rows: unknown[]) => { calls.fill.push(rows); return { services_created: rows.length, services_updated: 0, linked: 0, twins: 0, reactivated: 0 } },
      regroupVariants: async () => { calls.regroup++; return { groups: 0, services_in_groups: 0 } },
    } as unknown as CatalogStore
    return { store, calls }
  }
  const svc = (id: string, categoryRaw: string, name: string, type = 'Default') =>
    ({ externalServiceId: id, name, type, categoryRaw, ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false })
  const adapter = { getServices: async () => [
    svc('1', 'Roblox Followers', 'Roblox Followers [30D]', 'Followers'),
    svc('2', 'Twitter Followers', 'Twitter Followers [Real]'),
    svc('3', 'Twitter Spaces', 'Twitter Space Listeners [15 Min]'),
  ], getBalance: async () => ({ balance: 1, currency: 'USD' }) }

  it('a fill_gaps donor publishes the empty places only, never its whole catalogue, and regroups the variants', async () => {
    const { store, calls } = makeStore()
    const report = await syncProviderCatalog({ provider: { id: 'p', name: 'RootPanel', routing_enabled: true, catalog_mode: 'linked_only', fill_gaps: true }, adapter, store, rules: [], log: silentLogger })
    expect(calls.publish).toBe(0)
    expect((calls.fill[0] as { ps: string; platform: string }[]).map((r) => [r.ps, r.platform])).toEqual([['ps-1', 'roblox'], ['ps-3', 'twitter']])
    expect(report.filled).toMatchObject({ chosen: 2, created: 2 })
    expect(calls.regroup).toBe(1)
  })

  it('what already sells through the provider is not written again, and a run writes at most FILL_BUDGET', async () => {
    const { store, calls } = makeStore()
    ;(store as unknown as { loadOffers: () => Promise<unknown[]> }).loadOffers = async () => [{ id: 'o', service_id: 's', provider_id: 'p', provider_service_id: 'ps-3', cost_per_1000: 1, min_quantity: 10, max_quantity: 1000, refill_supported: false, cancel_supported: false, source: { rate_per_1000: 1, min_quantity: 10, max_quantity: 1000, refill_supported: false, cancel_supported: false } }]
    const report = await syncProviderCatalog({ provider: { id: 'p', name: 'RootPanel', routing_enabled: true, catalog_mode: 'linked_only', fill_gaps: true }, adapter, store, rules: [], log: silentLogger })
    expect((calls.fill[0] as { ps: string }[]).map((r) => r.ps)).toEqual(['ps-1'])
    expect(report.filled).toMatchObject({ chosen: 2, created: 1, backlog: 0 })

    // its card was hidden (no ACTIVE card sells it): it is sent again, so the database can bring the card back
    const hidden = makeStore()
    ;(hidden.store as unknown as { loadOffers: () => Promise<unknown[]> }).loadOffers = (store as unknown as { loadOffers: () => Promise<unknown[]> }).loadOffers
    ;(hidden.store as unknown as { loadSellingProviderServices: () => Promise<string[]> }).loadSellingProviderServices = async () => []
    await syncProviderCatalog({ provider: { id: 'p', name: 'RootPanel', routing_enabled: true, catalog_mode: 'linked_only', fill_gaps: true }, adapter, store: hidden.store, rules: [], log: silentLogger })
    expect((hidden.calls.fill[0] as { ps: string }[]).map((r) => r.ps)).toEqual(['ps-1', 'ps-3'])

    const big = { getServices: async () => Array.from({ length: 40 }, (_, i) => svc(String(100 + i), `Roblox Followers ${i % 20}`, `Roblox Followers ${i}`, i < 20 ? 'Followers' : 'Likes')), getBalance: adapter.getBalance }
    const many = makeStore()
    const r2 = await syncProviderCatalog({ provider: { id: 'p', name: 'RootPanel', routing_enabled: true, catalog_mode: 'linked_only', fill_gaps: true }, adapter: big, store: many.store, rules: [], log: silentLogger })
    expect(r2.filled!.chosen).toBe(20) // 10 followers + 10 likes
    expect((many.calls.fill.flat() as unknown[]).length).toBeLessThanOrEqual(FILL_BUDGET)
  })

  it('a donor without fill_gaps fills nothing', async () => {
    const { store, calls } = makeStore()
    await syncProviderCatalog({ provider: { id: 'p', name: 'SMMStone', routing_enabled: true, catalog_mode: 'linked_only' }, adapter, store, rules: [], log: silentLogger })
    expect(calls.fill).toHaveLength(0)
    expect(calls.regroup).toBe(0)
  })
})
