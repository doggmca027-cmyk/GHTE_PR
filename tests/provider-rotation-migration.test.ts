// The rotation (migration 20261226000000): the four providers leave, a card that loses its last offer looks for the same product elsewhere, and
// only a card with nothing left leaves the storefront.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const FOUR = ['SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider']
const dir = path.resolve(__dirname, '../supabase/migrations')
const ROTATION = '20261226000000_provider_rotation.sql'
const P = {
  center: '00000000-0000-4000-8000-0000000c0001', stone: '00000000-0000-4000-8000-0000000c0002', pwr: '00000000-0000-4000-8000-0000000c0003', smmp: '00000000-0000-4000-8000-0000000c0004',
  jap: '00000000-0000-4000-8000-0000000c0005', root: '00000000-0000-4000-8000-0000000c0006', secsers: '00000000-0000-4000-8000-0000000c0007',
}

describe('the provider rotation', () => {
  let db: PGlite
  let cat: string, seq = 0
  const S: Record<string, string> = {}
  const ps = async (provider: string, name: string, rate: number, o: { min?: number; max?: number; refill?: boolean; type?: string; active?: boolean } = {}) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported, service_type, is_active)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [provider, `e${++seq}`, name, rate, o.min ?? 10, o.max ?? 100000, o.refill ?? false, o.type ?? 'Default', o.active ?? true])).rows[0].id
  const card = async (name: string, source: string, o: { active?: boolean } = {}) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active)
      values ($1, $2, $3, 2, 100, 10000, $4) returning id`, [cat, name, source, o.active ?? true])).rows[0].id
  const link = (service: string, provider: string, source: string, cost: number) =>
    db.query(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 10, 100000, true)`, [service, provider, source, cost])
  const value = async (sql: string, ...args: unknown[]) => (await db.query<{ v: boolean | number | string }>(sql, args)).rows[0].v
  const active = (id: string) => value(`select is_active v from services where id = $1`, id)
  const runningOffers = async (id: string) => (await db.query<{ provider_id: string; cost: string }>(
    `select o.provider_id, o.cost_per_1000::text cost from provider_service_offers o join providers p on p.id = o.provider_id join provider_services ps on ps.id = o.provider_service_id
      where o.service_id = $1 and o.is_active and ps.is_active and p.is_active order by o.cost_per_1000`, [id])).rows

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    // everything up to the rotation: it runs below, on data
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x < ROTATION).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into providers (id, name, api_url, is_active, routing_enabled, health_status, catalog_mode, is_premium) values
      ('${P.center}', 'SMM Center', 'https://c', true, true, 'healthy', 'publish', false), ('${P.stone}', 'SMMStone', 'https://s', true, true, 'healthy', 'linked_only', false),
      ('${P.pwr}', 'SMMPWR', 'https://p', true, true, 'healthy', 'linked_only', false), ('${P.smmp}', 'SMMProvider', 'https://m', true, true, 'healthy', 'linked_only', false),
      ('${P.jap}', 'JAP', 'https://j', true, true, 'healthy', 'linked_only', false), ('${P.root}', 'RootPanel', 'https://r', true, true, 'healthy', 'linked_only', false),
      ('${P.secsers}', 'Secsers', 'https://x', true, true, 'healthy', 'linked_only', true)`)
    cat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'C', 'c') returning id`)).rows[0].id

    // cards with nothing elsewhere
    S.onlyCenter = await card('Instagram Likes [Aruba]', await ps(P.center, 'Instagram Likes [Aruba]', 1))
    S.onlyTwoRetiring = await card('Instagram Likes [Belize]', await ps(P.stone, 'Instagram Likes [Belize]', 1))
    await link(S.onlyTwoRetiring, P.pwr, await ps(P.pwr, 'Instagram Likes [Belize] B', 1), 1)
    // a card with a working offer elsewhere keeps it
    S.alsoJap = await card('Instagram Likes [Chad]', await ps(P.center, 'Instagram Likes [Chad]', 1))
    await link(S.alsoJap, P.jap, await ps(P.jap, 'Some JAP name', 1.5), 1.5)
    // an offer whose panel service is gone does not count, and is no replacement
    S.japRetired = await card('Instagram Likes [Dominica]', await ps(P.center, 'Instagram Likes [Dominica]', 1))
    const retired = await ps(P.jap, 'Instagram Likes [Dominica]', 1, { active: false })
    await link(S.japRetired, P.jap, retired, 1)
    // never touched: not on any of the four, or hidden before
    S.untouched = await card('Instagram Likes [Egypt]', await ps(P.root, 'Instagram Likes [Egypt]', 1))
    S.hiddenBefore = await card('Instagram Likes [Fiji]', await ps(P.center, 'Instagram Likes [Fiji]', 1), { active: false })
    // the same product elsewhere: dearer than the card's cost, so the matcher never linked it
    S.dearerTwin = await card('Instagram Followers [no refill] [Gabon]', await ps(P.center, 'Instagram Followers [no refill] [Gabon]', 1))
    await ps(P.jap, 'Instagram Followers [no refill] [Gabon]', 1.5)
    await ps(P.root, 'Instagram Followers [no refill] [Gabon]', 1.2)
    await ps(P.root, 'Instagram Followers [no refill] [Gabon] | fast', 1.1) // the cheapest per provider
    await ps(P.secsers, 'Instagram Followers [no refill] [Gabon]', 3)
    S.narrowerTwin = await card('Instagram Followers [Haiti]', await ps(P.center, 'Instagram Followers [Haiti]', 1))
    await ps(P.jap, 'Instagram Followers [Haiti]', 1, { min: 500, max: 2000 }) // overlaps 100..10000: the sync narrows the card
    // not the same product, or not orderable, or not believable
    S.otherCountry = await card('Instagram Followers [Iran]', await ps(P.center, 'Instagram Followers [Iran]', 1))
    await ps(P.jap, 'Instagram Followers [Peru]', 1)
    S.needsTexts = await card('Instagram Comments [Jordan]', await ps(P.center, 'Instagram Comments [Jordan]', 1))
    await ps(P.secsers, 'Instagram Comments [Jordan]', 1, { type: 'Custom Comments' })
    S.tooDear = await card('Instagram Followers [Kenya]', await ps(P.center, 'Instagram Followers [Kenya]', 1))
    await ps(P.jap, 'Instagram Followers [Kenya]', 60)
    S.tooCheap = await card('Instagram Followers [Laos]', await ps(P.center, 'Instagram Followers [Laos]', 1))
    await ps(P.jap, 'Instagram Followers [Laos]', 0.1)
    S.noOverlap = await card('Instagram Followers [Mali]', await ps(P.center, 'Instagram Followers [Mali]', 1))
    await ps(P.jap, 'Instagram Followers [Mali]', 1, { min: 20000, max: 50000 }) // the card sells 100..10000
    S.rejected = await card('Instagram Followers [Nepal]', await ps(P.center, 'Instagram Followers [Nepal]', 1))
    const rejectedPs = await ps(P.jap, 'Instagram Followers [Nepal]', 1)
    await db.query(`insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, status) values ($1, $2, $3, 1, 1, 0, 'rejected')`, [S.rejected, rejectedPs, P.jap])
    S.guaranteeWanted = await card('Instagram Followers [refill: 30 days] [Oman]', await ps(P.center, 'Instagram Followers [refill: 30 days] [Oman]', 1))
    await ps(P.jap, 'Instagram Followers [no refill] [Oman]', 1)

    await db.exec(fs.readFileSync(path.join(dir, ROTATION), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the four providers are out of the pool, the others untouched', async () => {
    const providers = (await db.query<{ name: string; is_active: boolean; routing_enabled: boolean; health_status: string }>(`select name, is_active, routing_enabled, health_status from providers`)).rows
    expect(providers.length).toBe(7)
    for (const p of providers) {
      const gone = FOUR.includes(p.name)
      expect([p.name, p.is_active, p.routing_enabled, p.health_status]).toEqual([p.name, !gone, !gone, gone ? 'disabled' : 'healthy'])
    }
  })

  it('their offers are switched off, not deleted', async () => {
    expect(await value(`select count(*)::int v from provider_service_offers o join providers p on p.id = o.provider_id where o.is_active and p.name = any($1)`, FOUR)).toBe(0)
    expect(await value(`select count(*)::int v from provider_service_offers where service_id = $1`, S.onlyCenter)).toBe(1)
    // and a later write of the card does not bring its offer back
    await db.query(`update services set primary_provider_service_id = primary_provider_service_id where id = $1`, [S.alsoJap])
    expect(await value(`select count(*)::int v from provider_service_offers o join providers p on p.id = o.provider_id where o.service_id = $1 and o.is_active and p.name = 'SMM Center'`, S.alsoJap)).toBe(0)
  })

  it('a card with a working offer elsewhere stays, and gets no new link', async () => {
    expect(await active(S.alsoJap)).toBe(true)
    expect((await runningOffers(S.alsoJap)).map((o) => o.provider_id)).toEqual([P.jap])
    expect(await active(S.untouched)).toBe(true)
  })

  it('a card whose only offers left is linked to the same product elsewhere, even when dearer: one offer per provider, the cheapest', async () => {
    expect(await active(S.dearerTwin)).toBe(true)
    expect((await runningOffers(S.dearerTwin)).map((o) => [o.provider_id, Number(o.cost)])).toEqual([[P.root, 1.1], [P.jap, 1.5], [P.secsers, 3]])
    expect(await active(S.narrowerTwin)).toBe(true)
    const linked = (await db.query<{ status: string; saving: string; current_cost: string }>(`select status, saving::text, current_cost::text from arbitrage_candidates where service_id = $1 and provider_id = $2`, [S.dearerTwin, P.jap])).rows
    expect(linked).toEqual([{ status: 'auto_linked', saving: '-0.5000', current_cost: '1.0000' }])
  })

  it.each(['onlyCenter', 'onlyTwoRetiring', 'japRetired', 'otherCountry', 'needsTexts', 'tooDear', 'tooCheap', 'noOverlap', 'rejected', 'guaranteeWanted'])('%s has nothing to go to: it leaves the storefront and is listed', async (key) => {
    expect(await active(S[key])).toBe(false)
    expect(await value(`select count(*)::int v from provider_rotation_hidden where service_id = $1`, S[key])).toBe(1)
    expect(await runningOffers(S[key])).toEqual([])
  })

  it('a card hidden before the rotation is not listed: undoing the rotation leaves it alone', async () => {
    expect(await active(S.hiddenBefore)).toBe(false)
    expect(await value(`select count(*)::int v from provider_rotation_hidden where service_id = $1`, S.hiddenBefore)).toBe(0)
    await db.exec(`begin;
      update services set is_active = true where id in (select service_id from provider_rotation_hidden);`)
    expect(await active(S.onlyCenter)).toBe(true)
    expect(await active(S.hiddenBefore)).toBe(false)
    await db.exec(`rollback;`)
    expect(await active(S.onlyCenter)).toBe(false)
  })

  it('the listing is private, and running the migration again changes nothing', async () => {
    expect(await value(`select has_table_privilege('anon', 'public.provider_rotation_hidden', 'select') v`)).toBe(false)
    expect(await value(`select has_table_privilege('authenticated', 'public.provider_rotation_hidden', 'select') v`)).toBe(false)
    const before = await value(`select count(*)::int v from provider_rotation_hidden`)
    const offers = await value(`select count(*)::int v from provider_service_offers`)
    await db.exec(fs.readFileSync(path.join(dir, ROTATION), 'utf8'))
    expect(await value(`select count(*)::int v from provider_rotation_hidden`)).toBe(before)
    expect(await value(`select count(*)::int v from provider_service_offers`)).toBe(offers)
  })
})
