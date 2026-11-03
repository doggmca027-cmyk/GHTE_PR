// Floor cards (migration 20261231000000): RootPanel #73486 and #89336 are the owner's bottom price for mass orders. The premium offers the matcher had
// linked to them are gone for good, their rates are back, and the matcher links no premium panel's offer to a card that is marked.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261231000000_floor_cards.sql'
const P = { root: '00000000-0000-4000-8000-0000000c0001', sec: '00000000-0000-4000-8000-0000000c0002', mtp: '00000000-0000-4000-8000-0000000c0003' }
const NAME_89336 = 'Instagram Followers ➜ [Speed: 50k+/Day | Refill: 30 Days]'
const NAME_73486 = 'Instagram Followers (20K/Day) (Max:100K) (30 Day Refill)'
const NAME_BYSTANDER = 'Instagram Followers [refill: 30 days] [Iran]'

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

describe('the floor cards', () => {
  let db: PGlite
  let category: string
  const id: Record<string, string> = {}
  const panel = async (provider: string, external: string, name: string, rate: number) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 10, 100000) returning id`, [provider, external, name, rate])).rows[0].id
  const card = async (name: string, primary: string, rate: number) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 100, 10000, true) returning id`, [category, name, primary, rate])).rows[0].id
  /** The matcher's own link: an offer and the candidate that records it. */
  const linkPremium = async (service: string, provider: string, source: string, cost: number, best: number) => {
    const offer = (await db.query<{ id: string }>(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 10, 100000, true) returning id`, [service, provider, source, cost])).rows[0].id
    await db.query(`insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status, offer_id, decided_at) values ($1, $2, $3, $4, $5, $6, '{}', 'auto_linked', $7, now())`, [service, source, provider, best, cost, Number((1 - cost / best).toFixed(4)), offer])
  }
  const providersOf = async (service: string) =>
    (await db.query<{ name: string }>(`select p.name from provider_service_offers o join providers p on p.id = o.provider_id where o.service_id = $1 order by p.name`, [service])).rows.map((r) => r.name)
  const rate = async (service: string) => Number((await db.query<{ r: string }>(`select customer_rate_per_1000 r from services where id = $1`, [service])).rows[0].r)
  const locked = async (service: string) => (await db.query<{ v: boolean }>(`select no_premium_offers v from services where id = $1`, [service])).rows[0].v

  beforeAll(async () => {
    db = await freshDb(MIGRATION) // the world as production was: the premium offers are on the cards
    await db.exec(`
      insert into providers (id, name, api_url, is_active, routing_enabled, health_status) values ('${P.root}', 'RootPanel', 'https://r', true, true, 'healthy');
      insert into providers (id, name, api_url, is_active, routing_enabled, health_status, is_premium) values
        ('${P.sec}', 'Secsers', 'https://s', true, true, 'healthy', true), ('${P.mtp}', 'MoreThanPanel', 'https://m', true, true, 'healthy', true);`)
    category = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'instagram'), 'Followers', 'followers-floor') returning id`)).rows[0].id
    const root89336 = await panel(P.root, '89336', NAME_89336, 0.3276)
    const root73486 = await panel(P.root, '73486', NAME_73486, 0.36)
    const rootOther = await panel(P.root, '555', NAME_BYSTANDER, 0.3)
    id.a = await card(NAME_89336, root89336, 1.82)
    id.b = await card(NAME_73486, root73486, 1.82)
    id.bystander = await card(NAME_BYSTANDER, rootOther, 1.82)
    for (const service of [id.a, id.b, id.bystander]) {
      await linkPremium(service, P.sec, await panel(P.sec, `s${service.slice(0, 4)}`, 'Instagram Followers | 30 Days Refill - Real', 0.91), 0.91, 0.3276)
      await linkPremium(service, P.mtp, await panel(P.mtp, `m${service.slice(0, 4)}`, '🔵 Instagram Followers | HQ | 30 Day Refill', 1.88), 1.88, 0.3276)
    }
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('marks the two cards of RootPanel and no other', async () => {
    expect([await locked(id.a), await locked(id.b), await locked(id.bystander)]).toEqual([true, true, false])
  })

  it('takes the premium offers off the two cards for good; the cards keep RootPanel; a bystander keeps its premium offers', async () => {
    expect(await providersOf(id.a)).toEqual(['RootPanel'])
    expect(await providersOf(id.b)).toEqual(['RootPanel'])
    expect(await providersOf(id.bystander)).toEqual(['MoreThanPanel', 'RootPanel', 'Secsers'])
    const pairs = (await db.query<{ status: string; offer_id: string | null; service_id: string }>(`select service_id, status, offer_id from arbitrage_candidates`)).rows
    for (const service of [id.a, id.b]) {
      const mine = pairs.filter((p) => p.service_id === service)
      expect(mine).toHaveLength(2)
      expect(mine.every((p) => p.status === 'rejected' && p.offer_id === null)).toBe(true)
    }
    expect(pairs.filter((p) => p.service_id === id.bystander).every((p) => p.status === 'auto_linked' && p.offer_id !== null)).toBe(true)
  })

  it('puts the retail rates back: 0.9828 and 1.08; the others stay', async () => {
    expect(await rate(id.a)).toBe(0.9828)
    expect(await rate(id.b)).toBe(1.08)
    expect(await rate(id.bystander)).toBe(1.82)
  })

  it('is safe to run again, and the mark is private', async () => {
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    expect([await rate(id.a), await rate(id.b), await providersOf(id.a)]).toEqual([0.9828, 1.08, ['RootPanel']])
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ ok: boolean }>(`select has_column_privilege($1, 'public.services', 'no_premium_offers', 'select') ok`, [role])).rows[0].ok).toBe(false)
    }
  })

  it('the matcher links no premium panel\'s offer to a marked card, and still does to an ordinary one', async () => {
    const fresh = await panel(P.root, '777', 'Instagram Followers [refill: 30 days] [Oman]', 0.3)
    const ordinary = await card('Instagram Followers [refill: 30 days] [Oman]', fresh, 0.9)
    for (const [name, rate] of [[NAME_89336, 0.95], [NAME_73486, 0.95], ['Instagram Followers [refill: 30 days] [Oman]', 0.95]] as const) {
      await panel(P.sec, `n${rate}${name.length}`, name, rate)
      await panel(P.mtp, `n${rate}${name.length}`, name, rate + 0.1)
    }
    await db.query(`select refresh_arbitrage_candidates(0.15, 2000, 0)`)
    expect(await providersOf(id.a)).toEqual(['RootPanel'])
    expect(await providersOf(id.b)).toEqual(['RootPanel'])
    expect(await providersOf(ordinary)).toContain('Secsers') // the control: the same premium panel, an unmarked card
    expect(await rate(id.a)).toBe(0.9828)
  })
})
