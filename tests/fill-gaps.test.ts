// Donors fill the gaps of the storefront (providers.fill_gaps, migration 20261212000000): which places are empty, which donor services go
// there, how twins are handled, and the sync step that does it.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FILL_MAX_RATE, FILL_PER_CELL, canonicalPlace, chooseGapFillers, isGap, isLinkAndQuantity, isPublishable, nichePlatform, referenceCells, type PublishCandidate,
} from '../supabase/functions/_shared/catalog-publish.ts'
import { FILL_BUDGET, fillProviderGaps, syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run.ts'
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

  it('the fill job takes the fill_gaps donors in turn, each at most once in 50 minutes', async () => {
    // the four production donors were switched on by the migrations too: start from a clean rotation of this test's two
    await db.exec(`update providers set fill_gaps = false where id not in ('${JAP}', '${RP}'); update providers set gaps_filled_at = null`)
    const claim = async () => (await db.query<{ id: string | null }>(`select claim_gap_fill_provider() id`)).rows[0].id
    const first = await claim()
    const second = await claim()
    expect(new Set([first, second])).toEqual(new Set([JAP, RP]))
    expect(await claim()).toBeNull() // both were just filled
    await db.exec(`update providers set gaps_filled_at = now() - interval '1 hour' where id = '${JAP}'`)
    expect(await claim()).toBe(JAP)
  })

  it('only the database itself may call it', async () => {
    const r = (await db.query<{ anon: boolean; svc: boolean }>(`select has_function_privilege('anon', 'public.fill_storefront_gaps(uuid, jsonb)', 'execute') anon, has_function_privilege('service_role', 'public.fill_storefront_gaps(uuid, jsonb)', 'execute') svc`)).rows[0]
    expect(r).toEqual({ anon: false, svc: true })
    const ref = (await db.query<{ r: unknown[] }>(`select storefront_reference_services() r`)).rows[0].r
    expect(Array.isArray(ref)).toBe(true)
  })
})

describe('the fill run (sync-catalog { fillGaps: true })', () => {
  type Cand = PublishCandidate & { fingerprint: string | null }
  const c = (id: string, categoryRaw: string, name: string, serviceType = 'Default', rate = 1): Cand =>
    ({ id, name, categoryRaw, serviceType, rate, min: 10, max: 1000, fingerprint: null })
  const makeStore = (candidates: Cand[], selling: string[] = []) => {
    const calls = { fill: [] as { ps: string; platform: string; description: string | null }[][], publish: 0, regroup: 0, dripfeed: 0, priced: 0, panel: 0 }
    const store = {
      loadProviderServices: async () => { calls.panel++; return [] },
      loadFillCandidates: async () => candidates.map((x) => ({ ...x })),
      loadDescriptions: async (ids: string[]) => new Map(ids.map((id) => [id, `text ${id}`])),
      loadSellingProviderServices: async () => selling,
      loadPlatformSlugs: async (activeOnly?: boolean) => (activeOnly ? ['twitter', 'roblox', 'other'] : ['twitter', 'roblox', 'periscope', 'other']),
      loadCategories: async () => [],
      loadReferenceServices: async () => [{ platform: 'twitter', category: 'Twitter Followers', name: 'Twitter Followers' }],
      publishServices: async () => { calls.publish++; return { categories_changed: 0, services_created: 0, services_updated: 0 } },
      fillGaps: async (_p: string, rows: { ps: string; platform: string; description: string | null }[]) => { calls.fill.push(rows); return { services_created: rows.length, services_updated: 0, linked: 0, twins: 0, reactivated: 0 } },
      loadLinkedServices: async () => { calls.priced++; return [] },
      loadServiceOffers: async () => [], updateServices: async () => {},
      regroupVariants: async () => { calls.regroup++; return { groups: 0, services_in_groups: 0 } },
      refreshDripFeed: async () => { calls.dripfeed++; return 0 },
    } as unknown as CatalogStore
    return { store, calls }
  }
  const donor = { id: 'p', name: 'RootPanel', routing_enabled: true, catalog_mode: 'linked_only' as const, fill_gaps: true }
  const CATALOGUE = [
    c('ps-1', 'Roblox Followers', 'Roblox Followers [30D]', 'Followers'),
    c('ps-2', 'Twitter Followers', 'Twitter Followers [Real]'),
    c('ps-3', 'Twitter Spaces', 'Twitter Space Listeners [15 Min]'),
  ]

  it('fills the empty places only (from the database, never the panel), with the panel texts, then prices, regroups and refreshes drip-feed', async () => {
    const { store, calls } = makeStore(CATALOGUE)
    const report = await fillProviderGaps({ provider: donor, store, rules: [], log: silentLogger })
    expect(calls.panel).toBe(0)
    expect(calls.publish).toBe(0)
    expect(calls.fill[0].map((r) => [r.ps, r.platform, r.description])).toEqual([['ps-1', 'roblox', 'text ps-1'], ['ps-3', 'twitter', 'text ps-3']])
    expect(report.filled).toMatchObject({ chosen: 2, created: 2, backlog: 0 })
    expect([calls.priced, calls.regroup, calls.dripfeed]).toEqual([1, 1, 1])
  })

  it('what already sells (an active card) is not written again; a hidden card is, so it can come back', async () => {
    const { store, calls } = makeStore(CATALOGUE, ['ps-3'])
    const report = await fillProviderGaps({ provider: donor, store, rules: [], log: silentLogger })
    expect(calls.fill[0].map((r) => r.ps)).toEqual(['ps-1'])
    expect(report.filled).toMatchObject({ chosen: 2, created: 1 })
  })

  it('nothing to do: nothing is written, priced or regrouped', async () => {
    const { store, calls } = makeStore(CATALOGUE, ['ps-1', 'ps-3'])
    const report = await fillProviderGaps({ provider: donor, store, rules: [], log: silentLogger })
    expect(calls.fill).toHaveLength(0)
    expect([calls.priced, calls.regroup, calls.dripfeed]).toEqual([0, 0, 0])
    expect(report.filled).toMatchObject({ chosen: 2, created: 0, backlog: 0 })
  })

  it('a run writes at most FILL_BUDGET; the rest is the backlog of the next runs', async () => {
    const many = Array.from({ length: 400 }, (_, i) => c(`ps-${i}`, `Roblox Section ${i}`, `Roblox Followers ${i}`, ['Followers', 'Likes', 'Members', 'Views'][i % 4], 1 + i / 1000))
    // forty places of ten: 40 categories x 4 actions would be more, but chooseGapFillers caps each place at ten
    const { store, calls } = makeStore(many)
    const report = await fillProviderGaps({ provider: donor, store, rules: [], log: silentLogger })
    expect(calls.fill.flat().length).toBe(Math.min(FILL_BUDGET, report.filled!.chosen))
    expect(report.filled!.backlog).toBe(Math.max(0, report.filled!.chosen - FILL_BUDGET))
  })

  it('a provider that is not a fill_gaps donor is skipped', async () => {
    for (const provider of [{ ...donor, fill_gaps: false }, { ...donor, catalog_mode: 'publish' as const }, { ...donor, routing_enabled: false }]) {
      const { store, calls } = makeStore(CATALOGUE)
      const report = await fillProviderGaps({ provider, store, rules: [], log: silentLogger })
      expect(report.status).toBe('skipped')
      expect(calls.fill).toHaveLength(0)
    }
  })

  it('the catalogue sync itself never fills (its worker is busy enough with a big panel)', async () => {
    const { store, calls } = makeStore(CATALOGUE)
    const adapter = { getServices: async () => [{ externalServiceId: '1', name: 'Roblox Followers [30D]', type: 'Followers', categoryRaw: 'Roblox Followers', ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false }], getBalance: async () => ({ balance: 1, currency: 'USD' }) }
    Object.assign(store as object, {
      touchProviderServices: async () => {}, flagAnomaly: async () => {}, loadOffers: async () => [], updateOffers: async () => {}, deactivateProviderServices: async () => {}, saveBalance: async () => {},
      upsertProviderServices: async (rows: { external_service_id: string }[]) => rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })),
    })
    await syncProviderCatalog({ provider: donor, adapter, store, rules: [], log: silentLogger })
    expect(calls.fill).toHaveLength(0)
  })
})

describe('what never fills a gap', () => {
  it('a placeholder price (more than FILL_MAX_RATE per 1000) or a separator row', () => {
    const ref = referenceCells([])
    const slugs = new Set(['instagram', 'roblox'])
    const chosen = chooseGapFillers([
      { id: 'a', name: 'Instagram Subscribers RP-01OZA', categoryRaw: 'Instagram Subscribers', serviceType: 'Subscribers', rate: 99999, min: 1, max: 10 },
      { id: 'b', name: '--------------- Real People ---------------', categoryRaw: 'Roblox Followers', serviceType: 'Default', rate: 5, min: 10, max: 1000 },
      { id: 'c', name: 'Roblox Followers [30D]', categoryRaw: 'Roblox Followers', serviceType: 'Followers', rate: 1, min: 10, max: 1000 },
    ], slugs, ref)
    expect(chosen.map((c) => c.id)).toEqual(['c'])
    expect(FILL_MAX_RATE).toBe(1000)
  })
})
