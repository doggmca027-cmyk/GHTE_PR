// The two-level catalogue (migration 20270101000100): which cards are Premium, that the database and offer-quality.ts say the same, and what the
// markup rules of docs/proposals/two-level-markup.sql do to a price (Premium x2.5 - x3.0, the rest x1.5 - x2.0).
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPremiumCard } from '../supabase/functions/_shared/offer-quality.ts'
import { calculateCustomerRate, selectPriceRule } from '../supabase/functions/_shared/price-engine.ts'
import type { PriceRule } from '../supabase/functions/_shared/types.ts'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20270101000100_premium_segment.sql'
const CATEGORY = '00000000-0000-4000-8000-0000000a00d1'

const NAMES: [string, boolean][] = [
  // each trigger of the brief
  ['Instagram Followers | Real', true],
  ['Instagram Followers 100% Real', true],
  ['Instagram Followers [Refill: 30 Days]', true],
  ['YouTube Views Lifetime', true],
  ['Instagram Followers Guarantee', true],
  ['Instagram Followers Guaranteed 90d', true],
  ['Instagram Followers No Drop', true],
  ['Instagram Followers Non-Drop', true],
  ['Instagram Followers No Drops', true],
  ['Instagram Followers Targeted USA', true],
  ['Website Traffic [organic] [Italy]', true],
  // and the words the storefront already called premium
  ['Instagram Followers | HQ', true],
  ['Instagram Followers UHQ', true],
  ['Instagram Followers High Quality', true],
  ['Instagram Followers Premium', true],
  ['Instagram Followers Verified', true],
  // nothing promised
  ['Instagram Followers', false],
  ['Telegram Post Views', false],
  ['Instagram Followers | Speed 10K/day', false],
  ['Website Traffic Real-time Stats', false],
  ['Surreal Views', false],
  ['Unreal Likes', false],
  // a promise taken back
  ['Instagram Followers [no refill] [high quality]', false],
  ['Instagram Followers | Real | Non Refill', false],
  ['Instagram Followers | Real | Bot', false],
  ['Instagram Followers Refill: 0', false],
]

describe('which cards are Premium', () => {
  let db: PGlite
  const sql = async (name: string | null) => (await db.query<{ v: boolean }>(`select service_is_premium($1) v`, [name])).rows[0].v
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it.each(NAMES)('%s -> %s, in the database and in offer-quality.ts', async (name, expected) => {
    expect(isPremiumCard(name)).toBe(expected)
    expect(await sql(name)).toBe(expected)
  })

  it('a card without a name is not Premium', async () => {
    expect(await sql(null)).toBe(false)
    expect(await sql('')).toBe(false)
  })

  it('the Premium chip (segment) is the same set as the flag', async () => {
    for (const [name, expected] of NAMES) {
      const seg = (await db.query<{ s: string[] }>(`select service_segments($1) s`, [name])).rows[0].s
      expect([name, seg.includes('premium')]).toEqual([name, expected])
    }
  })

  it('nobody but the service role can call the function; anon and authenticated read the flag column', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ ok: boolean }>(`select has_function_privilege($1, 'public.service_is_premium(text)', 'execute') ok`, [role])).rows[0].ok).toBe(false)
      expect((await db.query<{ ok: boolean }>(`select has_column_privilege($1, 'public.services', 'is_premium', 'select') ok`, [role])).rows[0].ok).toBe(true)
    }
  })

  it('a price rule may be limited to premium or standard cards, and to nothing else', async () => {
    const rule = (scope: string) => db.query(`insert into price_rules (name, type, value, quality_scope) values ('t', 'percentage', 10, '${scope}')`)
    await rule('premium')
    await rule('standard')
    await expect(rule('gold')).rejects.toThrow()
  })
})

describe('on the storefront', () => {
  let db: PGlite
  const dbWith = async (upTo?: string) => {
    const d = new PGlite()
    await d.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && (!upTo || x < upTo)).sort()) await d.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    return d
  }
  let source: string
  const card = async (name: string) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 1000, true) returning id`, [CATEGORY, name, source])).rows[0].id
  const flagOf = async (id: string) => (await db.query<{ v: boolean }>(`select is_premium v from services where id = $1`, [id])).rows[0].v
  let existing: string
  let plain: string

  beforeAll(async () => {
    db = await dbWith(MIGRATION) // the cards that exist when the migration runs
    await db.exec(`
      insert into providers (id, name, api_url) values ('00000000-0000-4000-8000-0000000a0002', 'RootPanel', 'https://r');
      insert into categories (id, platform_id, name, slug) values ('${CATEGORY}', (select id from platforms where slug = 'instagram'), 'Followers', 'followers-prem');`)
    source = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('00000000-0000-4000-8000-0000000a0002', 'x1', 'x', 1, 10, 1000) returning id`)).rows[0].id
    existing = await card('Instagram Followers | Real | Refill 30D')
    plain = await card('Instagram Followers')
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the cards that exist are sorted into the two levels when the migration runs', async () => {
    expect(await flagOf(existing)).toBe(true)
    expect(await flagOf(plain)).toBe(false)
  })

  it('a new card gets its flag by itself, and a renamed card gets it again', async () => {
    const id = await card('Telegram Members Lifetime')
    expect(await flagOf(id)).toBe(true)
    await db.query(`update services set name = 'Telegram Members' where id = $1`, [id])
    expect(await flagOf(id)).toBe(false)
    await db.query(`update services set name = 'Telegram Members [no refill] [real]' where id = $1`, [id])
    expect(await flagOf(id)).toBe(false)
  })

  it('the storefront lists Premium first with the index it has', async () => {
    const idx = (await db.query<{ def: string }>(`select indexdef def from pg_indexes where indexname = 'idx_services_premium_first'`)).rows[0]?.def
    expect(idx).toMatch(/is_premium DESC, sort_order, customer_rate_per_1000, id/i)
    expect(idx).toMatch(/where is_active/i)
  })
})

// the rules of docs/proposals/two-level-markup.sql, and the tiers they sit beside in production
const tier = (id: string, scope: PriceRule['quality_scope'], value: number, min_rate: number, max_rate: number | null, extra: Partial<PriceRule> = {}): PriceRule =>
  ({ id, type: 'tier', value, min_rate, max_rate, priority: 0, is_active: true, quality_scope: scope, ...extra })
const OLD = [
  tier('t1', null, 400, 0, 0.0499, { min_markup: 0.1, min_price: 0.12 }),
  tier('t2', null, 200, 0.05, 0.4999, { min_markup: 0.12 }),
  tier('t3', null, 100, 0.5, 4.9999, { min_markup: 0.3 }),
  tier('t4', null, 60, 5, null),
  tier('q3a', 'quality', 150, 1, 2.9999, { min_markup: 0.8, priority: 1 }),
]
const RULES: PriceRule[] = [
  ...OLD.slice(0, 4),
  // the old quality rule is switched off by the same script
  { ...OLD[4], is_active: false },
  tier('s1', 'standard', 100, 0, 0.0499, { min_markup: 0.1, min_price: 0.12 }),
  tier('s2', 'standard', 100, 0.05, 0.9999, { min_markup: 0.05 }),
  tier('s3', 'standard', 75, 1, 4.9999),
  tier('s4', 'standard', 50, 5, null),
  tier('p1', 'premium', 200, 0, 0.0499, { min_markup: 0.1, min_price: 0.12 }),
  tier('p2', 'premium', 200, 0.05, 0.9999, { min_markup: 0.05 }),
  tier('p3', 'premium', 175, 1, 4.9999),
  tier('p4', 'premium', 150, 5, null),
]
const PREMIUM = 'Instagram Followers | Real | Refill 30D'
const PLAIN = 'Instagram Followers'
const price = (cost: number, serviceName?: string) => calculateCustomerRate(cost, RULES, { serviceName })

describe('the two markups', () => {
  it('Premium sells at x3.0 up to 1.00, x2.75 up to 5.00 and x2.5 from there', () => {
    expect(price(0.5, PREMIUM)).toBe(1.5)
    expect(price(0.9999, PREMIUM)).toBe(2.9997)
    expect(price(1, PREMIUM)).toBe(2.75)
    expect(price(4, PREMIUM)).toBe(11)
    expect(price(5, PREMIUM)).toBe(12.5)
    expect(price(20, PREMIUM)).toBe(50)
  })

  it('the rest sells at x2.0 up to 1.00, x1.75 up to 5.00 and x1.5 from there', () => {
    expect(price(0.5, PLAIN)).toBe(1)
    expect(price(1, PLAIN)).toBe(1.75)
    expect(price(4, PLAIN)).toBe(7)
    expect(price(5, PLAIN)).toBe(7.5)
    expect(price(20, PLAIN)).toBe(30)
  })

  it('the cheapest cards keep their floors, so a tiny order still earns something', () => {
    expect(price(0.01, PLAIN)).toBe(0.12)
    expect(price(0.03, PREMIUM)).toBe(0.13)
    expect(price(0.06, PLAIN)).toBe(0.12)
  })

  it('Premium is always dearer than the rest at the same cost, and the multiples stay inside the brief above the floors', () => {
    for (const cost of [0.06, 0.2, 0.5, 0.9, 1, 2.5, 4.9, 5, 10, 50]) {
      expect(price(cost, PREMIUM)).toBeGreaterThan(price(cost, PLAIN))
      expect(price(cost, PREMIUM) / cost).toBeGreaterThanOrEqual(2.5 - 1e-9)
      expect(price(cost, PREMIUM) / cost).toBeLessThanOrEqual(3 + 1e-9)
      expect(price(cost, PLAIN) / cost).toBeGreaterThanOrEqual(1.5 - 1e-9)
      expect(price(cost, PLAIN) / cost).toBeLessThanOrEqual(2 + 1e-9)
    }
  })

  it('a card that takes its promise back, or a context without a name, is priced as the rest', () => {
    expect(price(2, 'Instagram Followers [no refill] [high quality]')).toBe(3.5)
    expect(price(2)).toBe(3.5)
  })

  it('every card meets exactly one of the two scopes, never the old global tiers', () => {
    for (const cost of [0.01, 0.3, 1, 7]) {
      for (const name of [PREMIUM, PLAIN, undefined]) {
        const rule = selectPriceRule(cost, RULES, { serviceName: name })
        expect(rule?.quality_scope).toBe(name && isPremiumCard(name) ? 'premium' : 'standard')
      }
    }
  })

  it('without the new rules (the rollback) the old tiers price every card as before', () => {
    const before = (cost: number, serviceName: string) => calculateCustomerRate(cost, OLD, { serviceName })
    expect(before(0.5, PLAIN)).toBe(1)
    expect(before(0.3, PLAIN)).toBe(0.9)
  })
})
