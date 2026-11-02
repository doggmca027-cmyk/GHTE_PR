// Quality before price on the cards that promise it (offer-quality.ts + its SQL twins), and how the premium panels are connected.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isCatalogueService, isLinkAndQuantity } from '../supabase/functions/_shared/catalog-publish.ts'
import { syncProviderCatalog } from '../supabase/functions/_shared/catalog-sync-run.ts'
import { isQualityCard, offerQualityScore, qualityScorer } from '../supabase/functions/_shared/offer-quality.ts'
import { bundleOffers, type BundleOfferRow } from '../supabase/functions/_shared/offer-bundle.ts'
import { priceLadder } from '../supabase/functions/_shared/order-pricing.ts'
import { buildCandidates, rankOffers, type OfferRow } from '../supabase/functions/_shared/routing.ts'
import { serviceCostBasis, type PricingOffer } from '../supabase/functions/_shared/service-cost.ts'
import { SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { IProvider, IProviderServiceOffer } from '../supabase/functions/_shared/types.ts'
import { ensurePanelsSql, PREMIUM_PANELS, readSyncAnswer } from '../scripts/lib/sync-services.ts'

const CARDS: [string, boolean][] = [
  // names of the live storefront
  ['YouTube Likes [refill: lifetime] [speed: up to 75 K/day] [real] [max: 100 K]', true],
  ['TikTok Likes [refill: 365 days] [drops: 0-15%] [speed: 50 K/day] [real]', true],
  ['YouTube Views [refill: lifetime] [slow and cheap]', true],
  ['SnackVideo Saves ➜ [High Quality | Max: 500K | Refill: 30 Days]', true],
  ['Instagram Likes (refill 30 Days) [no drops] [speed: 20 K/day] [start: fast] [medium quality]', true],
  ['Telegram Bot Starts [refill: lifetime] [Iran]', true],
  ['Telegram Subscribers-bot Starts (supported Referral Link) [refill: lifetime] [ultra fast] [100% real] [bonus 10%]', true],
  ['Instagram Followers [HQ]', true],
  ['Instagram Followers [Non-Drop]', true],
  ['Instagram Followers Non Drop', true],
  ['Instagram Real Followers', true],
  ['Website Traffic from Google [organic] [Italy]', true],
  ['Instagram Followers [Without Bots] [UHQ]', true],
  ['Twitch AI Chat Bot | Quality: UHQ Human-Like AI Chat', true],
  ['YouTube Social Shares from Reddit [Lifetime Guaranteed]', true],
  ['YouTube Comment Reply Likes [no refill] [high quality] [worldwide]', false],
  ['Telegram Bot Starts (Premium) [no refill] [high quality] [Russia]', false],
  ['Instagram Real Comments [no refill] [start: instant] [no bots] [Egypt]', false],
  ['Facebook Post Reactions [no refill] [speed: 100 K/day] [start: instant] [Thailand] [super]', false],
  ['TikTok Followers | Serbia | High Quality | No Refill | MAX 1M', false],
  ['Tiktok Followers [Refill: No] [Max: 50K]', false],
  ['Instagram Followers [Without Refill] [HQ]', false],
  ['Instagram Followers HQ Non-Refillable', false],
  ['Instagram Bot Followers [HQ]', false],
  ['Instagram Followers [Refill: 0 days] [real]', false],
  ['Kick Chat Bot for 30 Minutes [Valid For All Streams]', false],
  ['Telegram Post Views [last 200 posts]', false],
  ['Traffic from Italy from eBay.it', false],
  ['Potato Members', false],
  ['Twitch Real Time Viewers', false],
  ['Google Traffic from Italy [no refill] [organic]', false],
  ['Instagram Followers [Low Drop]', false],
]

const PANELS: [string, boolean, number][] = [
  ['Instagram Followers | Refill: Lifetime', false, 1],
  ['Youtube Likes | RUSSIA | Real | Speed: 20K/Day | Non-Drop | R30 | MAX 100K', false, 1],
  ['Twitter Views | ✅Quality: HQ | ⚡Start: Instant', false, 1],
  ['YouTube Views | ⏬Drop: No | MAX 100K', false, 1],
  ['Instagram Followers [Real]', false, 1],
  ['Website Traffic | Organic from Google.com.hk - Custom Keyword', false, 1],
  ['🔵 Instagram Likes | Lifetime Guaranteed | Speed: 200-500/Day ⌊ Max 2K | Real User Guaranteed | Low Drop |', false, 1],
  ['Tiktok Views [ Turkey 🇹🇷 ] No Drop - No Refill - 50M - 100K/Day', false, 0],
  ['🟢 Kick Live Viewers | Without Chatbots | 1=3 | 5 Hours |', false, 0],
  ['Instagram Followers [Cheap]', false, 0],
  ['Instagram Followers | HQ | ♻️Refill: No', false, 0],
  ['Instagram Followers', true, 2],
  ['Instagram Followers | HQ', true, 2],
  ['Instagram Followers | No Refill', true, 0], // a premium panel's own "no refill" keeps no promise
  ['Instagram Bot Followers', true, 0],
]

describe('what a card promises and how an offer keeps it', () => {
  it.each(CARDS)('%s -> %s', (name, quality) => {
    expect(isQualityCard(name)).toBe(quality)
  })
  it.each(PANELS)('offer "%s" premium=%s -> %i', (name, premium, score) => {
    expect(offerQualityScore(name, premium)).toBe(score)
  })
  it('every offer scores 0 on a card that promises nothing, or whose name is not given', () => {
    expect(qualityScorer('Telegram Post Views [no refill]')('Instagram | HQ', true)).toBe(0)
    expect(qualityScorer(undefined)('Instagram | HQ', true)).toBe(0)
    expect(qualityScorer('Instagram Followers [HQ]')('Instagram | HQ', true)).toBe(2)
  })
})

const P: IProvider[] = ['jap', 'root', 'secsers', 'mtp'].map((id) => ({
  id, name: id, apiUrl: `https://${id}`, apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
  lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0, premium: id === 'secsers' || id === 'mtp',
}))
const offer = (id: string, providerId: string, costPer1000: number, panelName: string, over: Partial<IProviderServiceOffer> = {}): IProviderServiceOffer => ({
  id, serviceId: 's', providerId, providerServiceId: `ps-${id}`, panelName, costPer1000, minQuantity: 10, maxQuantity: 10_000,
  refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: 't', updatedAt: 't', ...over,
})
const HQ = 'Instagram Followers [refill: 30 days] [high quality]'
const PLAIN = 'Telegram Post Views [no refill]'

describe('the router', () => {
  const offers = [
    offer('junk', 'jap', 0.05, 'Instagram Followers [Cheap]'),
    offer('labelled', 'root', 0.3, 'Instagram Followers | HQ | Refill: 30 Days'),
    offer('premium', 'secsers', 0.8, 'Instagram Followers'),
  ]
  const ids = (list: IProviderServiceOffer[], serviceName?: string, quantity?: number) => rankOffers(list, P, { serviceName, quantity }).map((o) => o.id)

  it('a quality card: premium panel, then an offer that says so, then the rest, whatever they cost', () => {
    expect(ids(offers, HQ)).toEqual(['premium', 'labelled', 'junk'])
  })
  it('a quality card without a premium offer: the labelled offer beats a cheaper unlabelled one', () => {
    expect(ids(offers.filter((o) => o.id !== 'premium'), HQ)).toEqual(['labelled', 'junk'])
  })
  it('a card that promises nothing goes to the cheapest, even against a premium panel', () => {
    expect(ids(offers, PLAIN)).toEqual(['junk', 'labelled', 'premium'])
    expect(ids(offers, 'Telegram Post Views')).toEqual(['junk', 'labelled', 'premium'])
  })
  it('without a card name nothing changes: cost only', () => {
    expect(ids(offers)).toEqual(['junk', 'labelled', 'premium'])
  })
  it('within a group the cheaper offer wins, and the reliability penalty still counts', () => {
    const two = [offer('a', 'secsers', 1, 'x'), offer('b', 'mtp', 0.9, 'x')]
    expect(ids(two, HQ)).toEqual(['b', 'a'])
    const flaky = P.map((p) => (p.id === 'mtp' ? { ...p, reliabilityPenalty: 2 } : p))
    expect(rankOffers(two, flaky, { serviceName: HQ }).map((o) => o.id)).toEqual(['a', 'b'])
  })
  it('a quality card still sells when the better offer cannot take the quantity or its provider is down', () => {
    const limited = [offer('junk', 'jap', 0.05, 'cheap'), offer('premium', 'secsers', 0.8, 'x', { minQuantity: 1000 })]
    expect(ids(limited, HQ, 100)).toEqual(['junk'])
    expect(ids(limited, HQ, 2000)).toEqual(['premium', 'junk'])
    const down = P.map((p) => (p.id === 'secsers' ? { ...p, healthStatus: 'degraded' as const } : p))
    expect(rankOffers(limited, down, { serviceName: HQ, quantity: 2000 }).map((o) => o.id)).toEqual(['junk'])
  })
  it('the name and the premium flag reach the router from the database row', () => {
    const row = (id: string, name: string, premium: boolean, cost: number): OfferRow => ({
      id, service_id: 's', provider_id: `p-${id}`, provider_service_id: `ps-${id}`, cost_per_1000: cost, min_quantity: 10, max_quantity: 1000, refill_supported: false,
      cancel_supported: false, is_active: true, routing_score: 0, created_at: 't', updated_at: 't',
      provider_service: { external_service_id: 'e', is_active: true, name },
      provider: { id: `p-${id}`, name: id, api_url: 'u', api_key_encrypted: null, api_version: 'v2', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: null, last_balance_sync: null, provider_balance: 0, currency: 'USD', priority: 0, is_premium: premium },
    })
    const c = buildCandidates([row('cheap', 'plain', false, 0.1), row('hq', 'plain', true, 5)])
    expect(rankOffers(c.offers, c.providers, { serviceName: HQ }).map((o) => o.id)).toEqual(['hq', 'cheap'])
  })
})

describe('the router with a drip-feed order', () => {
  const drip = { dripfeedSupported: true }
  const list = [
    offer('bots', 'jap', 0.05, 'Instagram Followers [Cheap]', drip),
    offer('labelled', 'root', 0.3, 'Instagram Followers | HQ', drip),
    offer('premium', 'secsers', 0.8, 'Instagram Followers', drip),
    offer('premium-no-drip', 'mtp', 0.4, 'Instagram Followers'),
  ]
  const ids = (offers: IProviderServiceOffer[], serviceName: string, quantity: number, runs: number) => rankOffers(offers, P, { serviceName, quantity, runs }).map((o) => o.id)

  it('only drip-feed capable offers qualify, and among them quality still comes first', () => {
    expect(ids(list, HQ, 3000, 3)).toEqual(['premium', 'labelled', 'bots'])
    expect(ids(list, HQ, 3000, 1)).toEqual(['premium-no-drip', 'premium', 'labelled', 'bots']) // a plain order may take the one without it
    expect(ids(list, PLAIN, 3000, 3)).toEqual(['bots', 'labelled', 'premium'])
  })
  it('the limits of an offer hold for one delivery, not the total', () => {
    const small = [offer('premium', 'secsers', 0.8, 'x', { ...drip, maxQuantity: 1000 }), offer('bots', 'jap', 0.05, 'cheap', drip)]
    expect(ids(small, HQ, 3000, 3)).toEqual(['premium', 'bots']) // 1000 per delivery
    expect(ids(small, HQ, 3000, 2)).toEqual(['bots']) // 1500 per delivery: over its max
    expect(ids(small, HQ, 3001, 3)).toEqual([]) // does not split
  })
})

describe('the price follows the router', () => {
  const pricing = (id: string, cost: number, panel: string, premium = false, over: Partial<PricingOffer> = {}): PricingOffer => ({
    id, service_id: 's', provider_id: `p-${id}`, provider_service_id: `ps-${id}`, cost_per_1000: cost, min_quantity: 10, max_quantity: 1000, refill_supported: false,
    is_active: true, provider_service_active: true, provider_active: true, routing_enabled: true, panel_name: panel, provider_premium: premium, ...over,
  })
  const offers = [pricing('junk', 0.05, 'cheap'), pricing('hq', 0.3, 'x | HQ'), pricing('premium', 0.8, 'x', true)]

  it('a quality card is priced on the offer that serves it, not on the cheapest', () => {
    expect(serviceCostBasis(offers, HQ)?.cost).toBe(0.8)
    expect(serviceCostBasis(offers.slice(0, 2), HQ)?.cost).toBe(0.3)
    expect(serviceCostBasis([offers[0]], HQ)?.cost).toBe(0.05) // no better offer: its only one
  })
  it('any other card, or an unnamed one, on the cheapest', () => {
    expect(serviceCostBasis(offers, PLAIN)?.cost).toBe(0.05)
    expect(serviceCostBasis(offers)?.cost).toBe(0.05)
  })
  it('an offer that cannot take an order does not set the price', () => {
    const off = [pricing('junk', 0.05, 'cheap'), pricing('premium', 0.8, 'x', true, { provider_active: false })]
    expect(serviceCostBasis(off, HQ)?.cost).toBe(0.05)
  })
  it('the price ladder names the offer the router sends each quantity to', () => {
    const list = [offer('junk', 'jap', 0.05, 'cheap'), offer('premium', 'secsers', 0.8, 'x', { minQuantity: 1000 })]
    const segments = priceLadder({ min: 10, max: 10_000 }, list, P, (o) => o.costPer1000 * 2, HQ)
    expect(segments.map((s) => [s.from, s.to, s.offerId])).toEqual([[10, 999, 'junk'], [1000, 10_000, 'premium']])
  })
  it('the bundle editor shows the routing order', () => {
    const row = (id: string, cost: number, name: string, premium: boolean): BundleOfferRow => ({
      id, service_id: 's', provider_id: `p-${id}`, provider_service_id: `ps-${id}`, cost_per_1000: cost, min_quantity: 10, max_quantity: 1000, refill_supported: false, is_active: true, routing_score: 0,
      provider_service: { external_service_id: 'e', name, is_active: true },
      provider: { id: `p-${id}`, name: id, is_active: true, routing_enabled: true, health_status: 'healthy', provider_balance: 0, reliability_penalty_multiplier: 1, is_premium: premium },
    })
    const rows = [row('junk', 0.05, 'cheap', false), row('premium', 0.8, 'x', true)]
    expect(bundleOffers(rows, 10, HQ).map((o) => o.offerId)).toEqual(['premium', 'junk'])
    expect(bundleOffers(rows, 10, PLAIN).map((o) => o.offerId)).toEqual(['junk', 'premium'])
  })
})

describe('what goes on the storefront when a whole catalogue is published', () => {
  const SLUGS = new Set(['instagram', 'tiktok', 'youtube', 'telegram', 'facebook', 'twitter', 'steam', 'other', 'website', 'google-maps', 'spotify'])
  const service = (name: string, categoryRaw: string) => ({ name, categoryRaw, serviceType: 'Default' })
  it.each([
    ['Instagram Followers | 30 Days Refill - Old + New account  - 30K/Day - Max 50K', 'Instagram Followers ➜ Guaranteed'],
    ['🔵 Instagram Likes | Lifetime Guaranteed | Speed: 200-500/Day ⌊ Max 2K | Real User Guaranteed | Low Drop |', '🔵 Instagram Real People Guaranteed Services'],
    ['🔵 Instagram Followers | 120 Day Refill | Speed: 30-50K/Day | Max 10M | Real Looking Accounts |', 'Instagram Followers'],
    ['Telegram Views No Drop - Lifetime Refill - 100M - 1M/Day', 'Telegram Views'],
    ['Facebook Page Rating | Random 5 Stars Reviews - Lifetime Refill', 'Facebook Reviews'],
    ['🔵 Spotify Mobile Plays | Global | Lifetime Guaranteed | %100 Premium Accounts', 'Spotify Plays'],
    ['YouTube Video Dislikes | No Refill - Max 50K - 10k/day', 'Youtube Likes'],
  ])('sold: %s', (name, category) => {
    expect(isCatalogueService(service(name, category), SLUGS)).toBe(true)
  })
  it.each([
    ['🔵 Netflix Premium | 3 Month | Full Account | NEW!', 'MoreThanMovies | Netflix | Disney+ | HBO Max | Amazon Prime |'],
    ['🔵 ChatGPT Plus | 1 Month Access | Shared Account', 'MoreThanAI | ChatGPT | Midjourney | Gemini | Claude |'],
    ['Windows 11 Home | Licence Key | NEW!', 'MoreThanLicence | Windows Licence Key | Office Licence Key | VPN | Antivirus |'],
    ['🔵 Steam Game Account | Mafia Trilogy |', 'Steam Game Accounts'],
    ['Ubisoft Game Account | Watch Dogs 2 |', 'Ubisoft Game Accounts'],
    ['Mobile Legends: Bang Bang | 336 Diamond | All Countries Of The World | NEW! |', 'Mobile Legends: Bang Bang Diamond'],
    ['Roblox 800 Robux', 'Roblox: Robux'],
    ['🔵 🇺🇸 Proxy Account | IPv4 ISP | USA | 2 Week | $3.49/per | NEW |', 'MoreThanProxy | IPv4 ISP Proxy |'],
    ['🔵 Tiktok Old Date Accounts | 2016-2025 | 5000 Followers', '🔵 Tiktok Account Sales | 2016-2025 Date Range Accounts | MTP Exclusive |'],
    ['🔵 Instagram Old Date Accounts | 2010-2024 | 500+ Followers', '🔵 Instagram Account Sales | 2010-2024 Date Range Accounts |  MTP Exclusive |'],
    ['🔵 Facebook Account Report | Speed 500-1K/Day | Max 1M |', '🔵 Facebook Elite Services | MTP Best Seller, Stable |'],
    ['Twitter Post Report | Max 10K - Fast', 'X - Twitter Report'],
    ['🔵 🇩🇪 Google 1 Star Negative | Germany | Max 1K | UHQ | Provided by US Profiles |', 'MoreThanPanel Germany Services'],
    ['Google Map Reviews [ 1 Stars + Random Comments ]', 'Google Map Reviews'],
    ['👇👇👇👇👇👇👇👇👇 INSTAGRAM SERVICES 👇👇👇👇👇👇👇👇👇', 'MoreThanPanel Services'],
    ['TT Live Shares - TEST', 'not for use'],
  ])('not sold: %s', (name, category) => {
    expect(isCatalogueService(service(name, category), SLUGS)).toBe(false)
  })

  it('the sync publishes a canonical catalogue without them, and they do not count as work left', async () => {
    const published: { ps: string }[] = []
    const services = [
      { externalServiceId: '1', name: 'Instagram Followers | 30 Days Refill', type: 'Default', categoryRaw: 'Instagram Followers', ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false },
      { externalServiceId: '2', name: 'Netflix Premium | 3 Month | Full Account', type: 'Default', categoryRaw: 'MoreThanMovies | Netflix |', ratePer1000: 1, minQuantity: 1, maxQuantity: 1, refillSupported: false, cancelSupported: false },
    ]
    const store = {
      loadProviderServices: async () => [],
      upsertProviderServices: async (rows: { external_service_id: string }[]) => rows.map((r) => ({ id: `ps-${r.external_service_id}`, external_service_id: r.external_service_id })),
      flagAnomaly: async () => {}, loadOffers: async () => [], updateOffers: async () => {}, deactivateProviderServices: async () => {},
      loadLinkedServices: async () => [], loadServiceOffers: async () => [], updateServices: async () => {}, saveBalance: async () => {},
      loadPlatformSlugs: async () => ['instagram', 'other'], loadCategories: async () => [],
      publishServices: async (_p: string, rows: { ps: string }[]) => { published.push(...rows); return { categories_changed: 0, services_created: rows.length, services_updated: 0 } },
    }
    const adapter = { getServices: async () => services, getBalance: async () => ({ balance: 0, currency: 'USD' }) }
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, bind: () => {}, child: () => log } as never
    const report = await syncProviderCatalog({ provider: { id: 'p', name: 'Secsers', routing_enabled: true, catalog_mode: 'publish', publish_mapping: 'canonical' }, adapter, store: store as never, rules: [], log })
    expect(published.map((r) => r.ps)).toEqual(['ps-1'])
    expect(report.published).toMatchObject({ created: 1, backlog: 0 })
  })
})

describe('reading a premium panel\'s catalogue', () => {
  // what Secsers and MoreThanPanel really answer: dripfeed is a boolean there, 0 / 1 on other panels
  const catalogue = [
    { service: 1, name: 'A', type: 'Default', rate: '2.365', min: 10, max: 100000, dripfeed: true, refill: false, cancel: true, category: 'c' },
    { service: 2, name: 'B', type: 'Default', rate: '1', min: 10, max: 100, dripfeed: false, refill: true, cancel: false, category: 'c' },
    { service: 3, name: 'C', type: 'Default', rate: '1', min: 10, max: 100, dripfeed: 1, category: 'c' },
    { service: 4, name: 'D', type: 'Default', rate: '1', min: 10, max: 100, dripfeed: 0, category: 'c' },
    { service: 5, name: 'E', type: 'Default', rate: '1', min: 10, max: 100, dripfeed: '1', category: 'c' },
    { service: 6, name: 'F', type: 'Default', rate: '1', min: 10, max: 100, dripfeed: '0', category: 'c' },
    { service: 7, name: 'G', type: 'Default', rate: '1', min: 10, max: 100, category: 'c' }, // the examples in their documentation have no such field
  ]
  it('dripfeed: true / 1 / "1" is capable, anything else is not', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(catalogue), { status: 200 })) as unknown as typeof fetch
    const list = await new SMMv2Adapter({ id: 'p', name: 'Secsers', apiUrl: 'https://secsers.test/api/v2', apiKey: 'k', mockMode: false, fetchImpl }).getServices()
    expect(list.map((s) => s.dripfeedSupported)).toEqual([true, false, true, false, true, false, false])
    expect(list[0]).toMatchObject({ externalServiceId: '1', ratePer1000: 2.365, cancelSupported: true, refillSupported: false })
  })
  it('a refused key is reported as such: these panels answer it with HTTP 401 and a JSON error', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })) as unknown as typeof fetch
    await expect(new SMMv2Adapter({ id: 'p', name: 'MoreThanPanel', apiUrl: 'https://mtp.test/api/v2', apiKey: 'zzz', mockMode: false, fetchImpl }).getBalance())
      .rejects.toMatchObject({ kind: 'api', code: 'invalid_api_key', httpStatus: 401 })
  })
})

describe('npm run sync-services', () => {
  it('registers the two panels, idempotently, with routing left to the default (off)', () => {
    expect(PREMIUM_PANELS.map((p) => p.apiUrl)).toEqual(['https://secsers.com/api/v2', 'https://morethanpanel.com/api/v2'])
    const sql = ensurePanelsSql(PREMIUM_PANELS)
    expect(sql).toContain('where not exists')
    expect(/insert into providers \(([^)]*)\)/.exec(sql)?.[1]).not.toContain('routing_enabled')
  })
  it('reads the answers of sync-catalog', () => {
    expect(readSyncAnswer('X', 200, { skipped: 'another_run_in_progress' }).kind).toBe('busy')
    expect(readSyncAnswer('X', 200, { added: 5, updated: 1, deactivated: 0, providers: [{ status: 'ok' }] })).toEqual({ kind: 'ok', backlog: 0, line: 'X: 5 new, 1 updated, 0 removed' })
    expect(readSyncAnswer('X', 200, { added: 0, updated: 0, deactivated: 0, providers: [{ status: 'ok', published: { created: 1500, backlog: 1856 } }] })).toEqual({ kind: 'ok', backlog: 1856, line: 'X: 0 new, 0 updated, 0 removed, 1500 cards published, 1856 to go' })
    expect(readSyncAnswer('X', 200, { providers: [{ status: 'skipped', error: 'no API key configured (set ...)' }] }).kind).toBe('no_key')
    expect(readSyncAnswer('X', 200, { providers: [{ status: 'failed', error: 'boom' }] }).kind).toBe('failed')
    expect(readSyncAnswer('X', 200, { providers: [{ status: 'skipped', error: 'provider returned no valid services; nothing changed' }] }).kind).toBe('failed')
    expect(readSyncAnswer('X', 200, { providers: [] }).kind).toBe('failed') // inactive: sync-catalog found nothing to do
    expect(readSyncAnswer('X', 500, { error: 'internal_error' }).kind).toBe('failed')
    expect(readSyncAnswer('X', 502, null).kind).toBe('failed')
  })
})

describe('in the database', () => {
  let db: PGlite
  const dir = path.resolve(__dirname, '../supabase/migrations')
  const P_ID = {
    center: '00000000-0000-4000-8000-0000000b0001', stone: '00000000-0000-4000-8000-0000000b0002', pwr: '00000000-0000-4000-8000-0000000b0003', smmp: '00000000-0000-4000-8000-0000000b0004',
    jap: '00000000-0000-4000-8000-0000000b0005', root: '00000000-0000-4000-8000-0000000b0006', secsers: '00000000-0000-4000-8000-0000000b0007',
  }
  let cat: string, seq = 0
  const ps = async (provider: string, name: string, rate: number, o: { min?: number; max?: number; refill?: boolean; type?: string; drip?: boolean } = {}) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported, service_type, is_dripfeed_enabled)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [provider, `e${++seq}`, name, rate, o.min ?? 10, o.max ?? 100000, o.refill ?? false, o.type ?? 'Default', o.drip ?? false])).rows[0].id
  const card = async (name: string, source: string, rate = 2) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active)
      values ($1, $2, $3, $4, 100, 10000, true) returning id`, [cat, name, source, rate])).rows[0].id
  const link = (service: string, provider: string, source: string, cost: number) =>
    db.query(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 10, 100000, true)`, [service, provider, source, cost])
  const flag = async (sql: string, ...args: unknown[]) => (await db.query<{ v: boolean | number }>(sql, args)).rows[0].v

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into providers (id, name, api_url, is_active, routing_enabled, health_status, catalog_mode) values
      ('${P_ID.center}', 'SMM Center', 'https://c', true, true, 'healthy', 'publish'), ('${P_ID.stone}', 'SMMStone', 'https://s', true, true, 'healthy', 'linked_only'),
      ('${P_ID.pwr}', 'SMMPWR', 'https://p', true, true, 'healthy', 'linked_only'), ('${P_ID.smmp}', 'SMMProvider', 'https://m', true, true, 'healthy', 'linked_only'),
      ('${P_ID.jap}', 'JAP', 'https://j', true, true, 'healthy', 'linked_only'), ('${P_ID.root}', 'RootPanel', 'https://r', true, true, 'healthy', 'linked_only')`)
    cat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'C', 'c') returning id`)).rows[0].id
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the SQL twins answer like offer-quality.ts on every name', async () => {
    for (const [name] of CARDS) {
      expect([name, await flag(`select service_name_is_quality($1) v`, name)]).toEqual([name, isQualityCard(name)])
    }
    for (const [name, premium] of PANELS) {
      expect([name, await flag(`select offer_quality_score($1, $2, $3) v`, HQ, name, premium)]).toEqual([name, offerQualityScore(name, premium)])
      expect(await flag(`select offer_quality_score($1, $2, $3) v`, PLAIN, name, premium)).toBe(0)
    }
    expect(await flag(`select service_name_is_quality(null) v`)).toBe(false)
  })

  it('what the matcher may link: the same answer as catalog-publish.ts on the types the panels really send', async () => {
    const CASES: [string, string][] = [
      ['Default', 'Instagram Followers'], ['default ', 'Custom anything: Default is Default'], ['Package', 'Instagram Package'], ['Custom Comments', 'Instagram Comments'],
      ['Custom Comments Package', 'x'], ['Subscriptions', 'Instagram Auto Likes'], ['Mentions User Followers', 'x'], ['Mentions Media Likers', 'x'], ['Mentions Custom List', 'x'],
      ['Mentions with Hashtags', 'x'], ['Comment Likes', 'x'], ['Comment Replies', 'x'], ['Invites from Groups', 'x'], ['Poll', 'x'], ['SEO', 'x'],
      ['followers', 'Instagram Followers'], ['Likes', 'Instagram Likes'], ['likes', 'Instagram Custom Likes'], ['views', 'Telegram Poll Views'], ['comments', 'x'],
    ]
    for (const [type, name] of CASES) {
      expect([type, name, await flag(`select service_takes_link_and_quantity($1, $2) v`, type, name)]).toEqual([type, name, isLinkAndQuantity(type, name)])
    }
    expect(await flag(`select service_takes_link_and_quantity(null, 'x') v`)).toBe(true)
  })

  it('the matcher links a premium panel to a quality card even when it is dearer, within reason', async () => {
    await db.exec(`insert into providers (id, name, api_url, is_active, routing_enabled, health_status, is_premium) values ('${P_ID.secsers}', 'Secsers', 'https://x', true, true, 'healthy', true)`)
    const quality = async (name: string, cost: number) => {
      const source = await ps(P_ID.jap, name, cost)
      return card(name, source)
    }
    const dearerOk = await quality('Instagram Followers [refill: 30 days] [Iran]', 0.05)
    const dearerPs = await ps(P_ID.secsers, 'Instagram Followers [refill: 30 days] [Iran]', 0.8)
    const absurd = await quality('Instagram Followers [refill: 30 days] [Oman]', 0.05)
    await ps(P_ID.secsers, 'Instagram Followers [refill: 30 days] [Oman]', 5)
    const plain = await quality('Instagram Followers [no refill] [Peru]', 0.05)
    await ps(P_ID.secsers, 'Instagram Followers [no refill] [Peru]', 0.8)
    const notPremium = await quality('Instagram Followers [refill: 30 days] [Chile]', 0.05)
    await ps(P_ID.root, 'Instagram Followers [refill: 30 days] [Chile]', 0.8)
    const needsTexts = await quality('Instagram Comments [refill: 30 days] [Fiji]', 0.05)
    await ps(P_ID.secsers, 'Instagram Comments [refill: 30 days] [Fiji]', 0.8, { type: 'Custom Comments' })

    await db.query(`select refresh_arbitrage_candidates(0.15, 2000, 0)`)

    const panels = async (svc: string) => (await db.query<{ provider_id: string; ps: string }>(`select provider_id, provider_service_id ps from provider_service_offers where service_id = $1`, [svc])).rows
    expect((await panels(dearerOk)).map((r) => r.ps)).toContain(dearerPs)
    expect((await panels(absurd)).map((r) => r.provider_id)).not.toContain(P_ID.secsers) // 100 times the price is not the same product
    expect((await panels(plain)).map((r) => r.provider_id)).not.toContain(P_ID.secsers) // the card promises nothing: dearer is not better
    expect((await panels(notPremium)).map((r) => r.provider_id)).not.toContain(P_ID.root) // dearer and not premium: as before
    expect((await panels(needsTexts)).map((r) => r.provider_id)).not.toContain(P_ID.secsers) // the order form cannot send what it needs
  })

  it('a drip-feed order of an HQ card on a premium panel: the customer pays for the total, the panel is asked for one delivery', async () => {
    const user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (91002) returning id`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100::numeric,null,'fund','fund-drip')`, [user])
    const service = await card('Instagram Followers [refill: 30 days] [Malta]', await ps(P_ID.jap, 'bots', 0.05, { drip: true }), 5)
    const premiumPs = await ps(P_ID.secsers, 'fine panel', 0.8, { drip: true })
    await link(service, P_ID.secsers, premiumPs, 0.8)
    await db.exec(`update providers set provider_balance = 100, last_balance_sync = now() where id = '${P_ID.secsers}'`)
    const offer = (await db.query<{ id: string }>(`select id from provider_service_offers where service_id = $1 and provider_id = $2`, [service, P_ID.secsers])).rows[0].id
    const onTotal = Number((await db.query<{ p: string }>(`select calculate_order_price($1::uuid, $2::uuid, 3000, 3, null)->>'final_price' p`, [user, service])).rows[0].p)
    const plainTotal = Number((await db.query<{ p: string }>(`select calculate_order_price($1::uuid, $2::uuid, 3000, 1, null)->>'final_price' p`, [user, service])).rows[0].p)
    expect(onTotal).toBeGreaterThan(0)
    expect(onTotal).toBe(plainTotal) // 3000 in 3 runs costs what 3000 at once costs, not what 1000 costs
    const placed = (await db.query<{ quantity: number; runs: number; interval: number; charge_amount: string; cost_amount: string; provider_id: string }>(
      `select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', 3000, $3::uuid, $4::uuid, $5::uuid, 2.4, 'k-drip', null, false, 3, 60)`, [user, service, offer, P_ID.secsers, premiumPs])).rows[0]
    expect(placed).toMatchObject({ quantity: 3000, runs: 3, interval: 60, provider_id: P_ID.secsers })
    expect(Number(placed.charge_amount)).toBe(onTotal)
    expect(Number(placed.cost_amount)).toBe(2.4) // 0.8 per 1000 x the total
    expect(await flag(`select ledger_drift_count() v`)).toBe(0)

    const bodies: string[] = []
    const fetchImpl = (async (_url: string, init: { body: URLSearchParams }) => {
      bodies.push(String(init.body))
      return new Response(JSON.stringify({ order: 23501 }), { status: 200 })
    }) as unknown as typeof fetch
    const adapter = new SMMv2Adapter({ id: P_ID.secsers, name: 'Secsers', apiUrl: 'https://secsers.test/api/v2', apiKey: 'K', mockMode: false, fetchImpl, capabilities: { supportsDripFeed: true } })
    await adapter.createOrder({ serviceId: '77', link: 'https://t.me/x', quantity: placed.quantity, runs: placed.runs, interval: placed.interval })
    expect(bodies).toEqual(['key=K&action=add&service=77&link=https%3A%2F%2Ft.me%2Fx&quantity=1000&runs=3&interval=60'])
  })

  it('hub_reroute_order keeps to the best quality that can pay', async () => {
    const user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (91001) returning id`)).rows[0].id
    const service = await card('Instagram Views [refill: 30 days] [Fiji]', await ps(P_ID.jap, 'waiting', 0.1), 5)
    const cheap = await ps(P_ID.root, 'cheap panel', 0.2)
    const good = await ps(P_ID.secsers, 'fine panel', 0.8)
    await link(service, P_ID.root, cheap, 0.2)
    await link(service, P_ID.secsers, good, 0.8)
    await db.exec(`update providers set provider_balance = 100, last_balance_sync = now() where id in ('${P_ID.root}', '${P_ID.secsers}')`)
    await db.exec(`update platform_settings set deferred_orders_enabled = true where id = 1`)
    await db.exec(`update providers set provider_balance = 0, last_balance_sync = now() where id = '${P_ID.jap}'`)
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100::numeric,null,'fund','fund-reroute')`, [user])
    const japOffer = (await db.query<{ id: string; ps: string }>(`select id, provider_service_id ps from provider_service_offers where service_id = $1 and provider_id = $2`, [service, P_ID.jap])).rows[0]
    const order = (await db.query<{ id: string; awaiting_funds_since: string | null }>(`select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 0.1, 'k-reroute', null, true)`, [user, service, japOffer.id, P_ID.jap, japOffer.ps])).rows[0]
    expect(order.awaiting_funds_since).not.toBeNull()
    const r = (await db.query<{ r: { ok: boolean; provider: string; reason?: string } }>(`select hub_reroute_order($1) r`, [order.id])).rows[0].r
    expect(r).toMatchObject({ ok: true, provider: 'Secsers' })
  })
})
