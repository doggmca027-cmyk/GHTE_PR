// Internal article numbers (SKU) of provider services (migration 20261228000000): built from the row alone, issued once, and for the admin only:
// the bundle editor and the order-hub messages of the bot. No customer screen, customer function or client role can read one.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleOffers, type BundleOfferRow } from '../supabase/functions/_shared/offer-bundle.ts'
import { hubMessage } from '../supabase/functions/_shared/order-hub.ts'

const root = path.resolve(__dirname, '..')
const dir = path.join(root, 'supabase/migrations')
const SKU = '20261228000000_service_sku.sql'
const P = { sec: '00000000-0000-4000-8000-0000000f0001', mtp: '00000000-0000-4000-8000-0000000f0002', jap: '00000000-0000-4000-8000-0000000f0003' }

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

describe('what a SKU says', () => {
  let db: PGlite
  const sku = async (name: string, category: string | null, provider: string, external: string, premium = false) =>
    (await db.query<{ s: string }>(`select build_provider_service_sku($1, $2, $3, $4, $5) s`, [name, category, provider, external, premium])).rows[0].s
  beforeAll(async () => { db = await freshDb() }, 240_000)
  afterAll(async () => { await db.close() })

  it.each<[string, string | null, string, string, string]>([
    ['Instagram Followers | 30 Days Refill - Real - 70K/Day', null, 'Secsers', '9986', 'IG-FOL-HQ-SEC9986'],
    ['Instagram Followers [HQ] [Refill: 30D]', null, 'RootPanel', '5', 'IG-FOL-HQ-ROOT5'],
    // a refill alone is a standard line, unless the provider is a premium panel (below); mix and economy lines are the cheap ones
    ['Instagram Followers (20K/Day) (Max:100K) (30 Day Refill)', null, 'RootPanel', '73486', 'IG-FOL-STD-ROOT73486'],
    ['Instagram Followers [Mix Accounts] [30 Days Refill] [50-100K/D]', null, 'RootPanel', '93111', 'IG-FOL-CHEAP-ROOT93111'],
    ['⚪ Instagram Followers ➜ [Economy] [Refill : 30 Days]', null, 'RootPanel', '78332', 'IG-FOL-CHEAP-ROOT78332'],
    ['Instagram Followers [HIGH DROP] [MAX : 50K] [Refill: 30D] [Speed: Up to 50K/D]', null, 'JAP', '10321', 'IG-FOL-CHEAP-JAP10321'],
    ['TikTok Views [no refill] [speed: 10 K/day]', null, 'JAP', '1', 'TT-VIEW-CHEAP-JAP1'],
    ['Telegram Post Views', null, 'RootPanel', '77', 'TG-VIEW-STD-ROOT77'],
    ['Telegram Premium Members [refill: 30 days] [India]', null, 'SMMFollows', '5', 'TG-MEM-STD-SMMF5'],
    ['YouTube Live Stream Views | 15 Minutes - Cheap', null, 'Secsers', '12', 'YT-LIVE-CHEAP-SEC12'],
    ['Twitter (X) Followers | Real', null, 'JAP', '8', 'TW-FOL-HQ-JAP8'],
    // the platform and the action may be in the panel's category instead of the name
    ['Followers', 'Instagram Followers ➜ Guaranteed', 'SMMFollows', '5', 'IG-FOL-STD-SMMF5'],
    ['Windows 11 Home | Licence Key', null, 'Secsers', 'ab-12', 'OTH-OTH-STD-SECAB12'],
    // a provider that is new: the first letters of its name
    ['Instagram Likes', null, 'Fooba Panel', '12', 'IG-LIKE-STD-FOOB12'],
  ])('%s (%s, %s #%s) is %s', async (name, category, provider, external, expected) => {
    expect(await sku(name, category, provider, external)).toBe(expected)
  })

  it('a premium panel that promises a refill or a guarantee is HQ; the same line at another provider is STD, and a premium panel does not lift a cheap one', async () => {
    const line = '🟢 TikTok Followers | 30 Day Refill | Speed: 5-10K/Day | Max 1M |'
    expect(await sku(line, null, 'MoreThanPanel', '5760', true)).toBe('TT-FOL-HQ-MTP5760')
    expect(await sku(line, null, 'MoreThanPanel', '5760', false)).toBe('TT-FOL-STD-MTP5760')
    expect(await sku('Instagram Followers | Lifetime Guaranteed', null, 'Secsers', '1', true)).toBe('IG-FOL-HQ-SEC1')
    expect(await sku('Instagram Followers | No Refill', null, 'Secsers', '2', true)).toBe('IG-FOL-CHEAP-SEC2')
    expect(await sku('Instagram Followers', null, 'Secsers', '3', true)).toBe('IG-FOL-STD-SEC3') // a premium panel says nothing about a line that promises nothing
  })

  it('is one readable article: PLATFORM-TYPE-QUALITY-PROVIDER+NUMBER, nothing else', async () => {
    for (const [name, provider, external] of [['Instagram Followers | Real', 'Secsers', '9986'], ['x', 'JAP', '1'], ['Spotify Plays [no refill]', 'MoreThanPanel', '4521']]) {
      expect(await sku(name as string, null, provider, external)).toMatch(/^[A-Z]{2,4}-[A-Z]{2,5}-(HQ|STD|CHEAP)-[A-Z]{3,4}[A-Z0-9]{1,12}$/)
    }
  })
})

describe('issuing SKUs', () => {
  let db: PGlite
  const prov = async (id: string, name: string, premium = false) => db.query(`insert into providers (id, name, api_url, is_premium) values ($1, $2, 'https://x', $3) on conflict do nothing`, [id, name, premium])
  const ps = async (provider: string, ext: string, name: string, category = '') =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 10, 1000) returning id`, [provider, ext, name, category])).rows[0].id
  const skuOf = async (id: string) => (await db.query<{ sku: string | null }>(`select sku from provider_services where id = $1`, [id])).rows[0].sku
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    db = await freshDb(SKU) // everything before the migration: it runs below, on services that exist already
    await prov(P.sec, 'Secsers', true); await prov(P.mtp, 'MoreThanPanel', true); await prov(P.jap, 'JAP')
    ids.real = await ps(P.sec, '9986', 'Instagram Followers | 30 Days Refill - Real - 70K/Day')
    ids.twinA = await ps(P.jap, '12-3', 'Instagram Likes')
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the services that exist get theirs when the migration runs: unique, twins told apart', async () => {
    await db.exec(fs.readFileSync(path.join(dir, SKU), 'utf8'))
    expect(await skuOf(ids.real)).toBe('IG-FOL-HQ-SEC9986')
    expect(await skuOf(ids.twinA)).toBe('IG-LIKE-STD-JAP123')
  })

  it('a SKU is unique: two services of one provider whose numbers differ only in punctuation do not share one', async () => {
    const twinB = await ps(P.jap, '123', 'Instagram Likes')
    const [a, b] = [await skuOf(ids.twinA), await skuOf(twinB)]
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
    expect(b!.startsWith('IG-LIKE-STD-JAP123')).toBe(true)
    await expect(db.query(`update provider_services set sku = $2 where id = $1`, [twinB, a])).rejects.toThrow(/uq_provider_services_sku|duplicate key/)
  })

  it('a service stored later gets one by itself; the SKU is issued once and a renamed service keeps it', async () => {
    const id = await ps(P.mtp, '5197', '🔵 🇧🇷 Instagram Followers | Brazil | 30 Day Refill | HQ')
    expect(await skuOf(id)).toBe('IG-FOL-HQ-MTP5197')
    await db.query(`update provider_services set name = 'Instagram Followers | Brazil | no refill | cheap', rate_per_1000 = 0.5 where id = $1`, [id])
    expect(await skuOf(id)).toBe('IG-FOL-HQ-MTP5197')
    // a catalogue sync writes the same panel service again (upsert): the article is not touched
    await db.query(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '5197', 'renamed again', 0.6, 10, 1000)
      on conflict (provider_id, external_service_id) do update set name = excluded.name, rate_per_1000 = excluded.rate_per_1000`, [P.mtp])
    expect(await skuOf(id)).toBe('IG-FOL-HQ-MTP5197')
  })

  it('the SKU never blocks a catalogue sync: a service whose SKU cannot be built is stored without one', async () => {
    const id = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', $2, 1, 10, 1000) returning id`, [P.sec, 'x'.repeat(50)])).rows[0].id
    expect(await skuOf(id)).not.toBeNull()
  })
})

describe('the SKU is for the admin only', () => {
  let db: PGlite
  const value = async (sql: string, ...args: unknown[]) => (await db.query<{ v: boolean | number | string | null }>(sql, args)).rows[0].v
  beforeAll(async () => { db = await freshDb() }, 240_000)
  afterAll(async () => { await db.close() })

  // The panel service's own SKU stays private. Its copy on the storefront card is public (20261230000000, tests/storefront-sku.test.ts): that one is
  // what the assistant gives a customer.
  it.each(['anon', 'authenticated'])('%s can read neither the column nor the table of the panel services, and no other table has such a column', async (role) => {
    expect(await value(`select has_column_privilege($1, 'public.provider_services', 'sku', 'select') v`, role)).toBe(false)
    expect(await value(`select has_table_privilege($1, 'public.provider_services', 'select') v`, role)).toBe(false)
    expect(await value(`select count(*)::int v from information_schema.columns where table_schema = 'public' and column_name = 'sku' and table_name not in ('provider_services', 'services')`)).toBe(0)
  })

  it('reaches the admin through the order hub: the message the database queues names the SKU of the service the order was routed to', async () => {
    await db.exec(`
      update platform_settings set deferred_orders_enabled = true where id = 1;
      insert into providers (id, name, api_url, is_active, routing_enabled, health_status, provider_balance, last_balance_sync) values ('${P.sec}', 'Secsers', 'https://s', true, true, 'healthy', 0, now());
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000f1', (select id from platforms where slug = 'instagram'), 'C', 'c-sku');`)
    const source = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '9986', 'Instagram Followers | 30 Days Refill - Real', 1, 10, 100000) returning id`, [P.sec])).rows[0].id
    const service = (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ('00000000-0000-0000-0000-0000000000f1', 'Instagram Followers', $1, 4, 10, 100000, true) returning id`, [source])).rows[0].id
    const offer = (await db.query<{ id: string }>(`select id from provider_service_offers where service_id = $1`, [service])).rows[0].id
    await db.query(`insert into users(telegram_id, is_admin) values (93001, true)`)
    const user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (93002) returning id`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100::numeric, null, 'fund', 'fund-sku')`, [user])
    await db.query(`select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 1.0, 'k-sku', null, true)`, [user, service, offer, P.sec, source])
    const payload = (await db.query<{ payload: Record<string, unknown> }>(`select payload from notification_outbox where kind = 'admin_hub' and payload->>'event' = 'waiting'`)).rows[0].payload
    expect(payload.sku).toBe('IG-FOL-HQ-SEC9986')
    expect(hubMessage(payload as never).text).toContain('🏷 Артикул: <code>IG-FOL-HQ-SEC9986</code>')
  })

  // The code is read, not just the database: a screen, a customer function or a shared module that mentions an article would be found here.
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []))
  const mentions = (file: string) => /\bsku\b/i.test(fs.readFileSync(file, 'utf8'))

  // The article on the storefront card is public since 20261230000000 (the assistant gives it to customers, the search finds a card by it). What stays private is
  // the panel service behind the card: its table, and with it the supplier's own numbers and costs. The code of the app must not even name that table.
  it('no customer screen, hook or API client in the app reads the panel services: the article a customer sees is the copy on the card', () => {
    const admin = /(^|\/)(components\/admin\/|services\/api\/(mock-)?admin|types\/(admin|catalog-mapping))/
    const offenders = files(path.join(root, 'src')).map((f) => path.relative(path.join(root, 'src'), f).replace(/\\/g, '/')).filter((f) => !admin.test(f))
      .filter((f) => /provider_service|primary_provider|fallback_provider|cost_per_1000/i.test(fs.readFileSync(path.join(root, 'src', f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('no function a customer calls, and no module they share, mentions it', () => {
    const functions = ['place-order', 'quote-order', 'request-refill', 'user-tickets', 'track-event', 'telegram-auth', 'web-auth', 'create-deposit', 'verify-deposit', 'referrals', 'sync-order-status', 'sync-catalog']
    const shared = ['routing.ts', 'order-pricing.ts', 'place-order-flow.ts', 'discounts.ts', 'order-validation.ts', 'service-text.ts', 'catalog-publish.ts', 'notification-outbox.ts']
    const offenders = [
      ...functions.flatMap((n) => files(path.join(root, 'supabase/functions', n)).filter(mentions)),
      ...shared.map((n) => path.join(root, 'supabase/functions/_shared', n)).filter(mentions),
    ].map((f) => path.relative(root, f).replace(/\\/g, '/'))
    expect(offenders).toEqual([])
  })
})

describe('where the admin sees it', () => {
  const row = (sku?: string | null): BundleOfferRow => ({
    id: 'o1', service_id: 's', provider_id: 'p', provider_service_id: 'ps', cost_per_1000: 1.979, min_quantity: 50, max_quantity: 5_000_000, refill_supported: true, is_active: true, routing_score: 0,
    provider_service: { external_service_id: '9986', name: 'Instagram Followers | 30 Days Refill - Real', is_active: true, ...(sku === undefined ? {} : { sku }) },
    provider: { id: 'p', name: 'Secsers', is_active: true, routing_enabled: true, health_status: 'healthy', provider_balance: 0, reliability_penalty_multiplier: 1, is_premium: true },
  })

  it('the bundle editor: every offer carries the SKU of its panel service', () => {
    expect(bundleOffers([row('IG-FOL-HQ-SEC9986')], 4)[0].sku).toBe('IG-FOL-HQ-SEC9986')
    expect(bundleOffers([row(null)], 4)[0].sku).toBeNull()
    expect(bundleOffers([row()], 4)[0].sku).toBeNull()
  })

  const waiting = { event: 'waiting' as const, order_id: '11111111-1111-4111-8111-111111111111', provider_id: 'p', provider: 'Secsers', service: 'Instagram Followers', quantity: 1000, charge: 3.5, cost: 1.98, balance: 0, needed: 1.98 }
  const sent = { event: 'sent' as const, order_id: '11111111-1111-4111-8111-111111111111', provider: 'Secsers', service: 'Instagram Followers', quantity: 1000, charge: 3.5, cost: 1.98, balance: 5 }

  it('the hub messages: a waiting and a sent order name the article, right under the service', () => {
    for (const p of [waiting, sent]) {
      const lines = hubMessage({ ...p, sku: 'IG-FOL-HQ-SEC9986' }).text.split('\n')
      const at = lines.findIndex((l) => l.startsWith('🏷'))
      expect(lines[at]).toBe('🏷 Артикул: <code>IG-FOL-HQ-SEC9986</code>')
      expect(lines[at - 1]).toContain('Instagram Followers')
    }
  })

  it('without a SKU the messages are exactly what they were, and a SKU is escaped like any other text', () => {
    for (const p of [waiting, sent]) {
      expect(hubMessage(p).text).not.toContain('🏷')
      expect(hubMessage({ ...p, sku: null }).text).toBe(hubMessage(p).text)
    }
    expect(hubMessage({ ...waiting, sku: '<b>x</b>' }).text).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>')
  })
})
