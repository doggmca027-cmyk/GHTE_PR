// Premium segments of the storefront (migration 20261231000300): what a card name says, who reads it, and that a new or renamed card gets it by itself.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261231000300_service_segments.sql'
const CATEGORY = '00000000-0000-4000-8000-0000000a00c1'

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

describe('what a name says', () => {
  let db: PGlite
  const segments = async (name: string | null) => (await db.query<{ s: string[] }>(`select service_segments($1) s`, [name])).rows[0].s
  beforeAll(async () => { db = await freshDb() }, 240_000)
  afterAll(async () => { await db.close() })

  it.each<[string, string[]]>([
    // the order is always premium, guaranteed, safe
    ['Instagram Followers | HQ | Real | Refill 30D', ['premium', 'guaranteed']],
    ['Instagram Followers ➜ [Speed: 50k+/Day | Refill: 30 Days]', ['guaranteed']],
    ['Instagram Followers | Organic | 500/Day | R30', ['guaranteed', 'safe']],
    ['TikTok Likes | Real Users | Non-Drop | Slow | 2K/Day', ['premium', 'guaranteed', 'safe']],
    ['YouTube Views | Lifetime Guarantee', ['guaranteed']],
    ['Telegram Members | Natural growth', ['safe']],
    ['Telegram Post Views', []],
    // a name that takes the promise back keeps neither premium nor guaranteed ...
    ['Instagram Followers [no refill] [high quality]', []],
    ['Instagram Followers | Real | Non Refill', []],
    // ... and a bot is not safe growth
    ['Instagram Followers | Slow | Bot', []],
  ])('%s -> %j', async (name, expected) => {
    expect(await segments(name)).toEqual(expected)
  })

  it('a card without a name has none', async () => {
    expect(await segments(null)).toEqual([])
    expect(await segments('')).toEqual([])
  })
})

describe('on the storefront', () => {
  let db: PGlite
  const card = async (name: string) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 1000, true) returning id`, [CATEGORY, name, source])).rows[0].id
  const segmentsOf = async (id: string) => (await db.query<{ s: string[] }>(`select segments s from services where id = $1`, [id])).rows[0].s
  let source: string
  let existing: string

  beforeAll(async () => {
    db = await freshDb(MIGRATION) // the cards that exist when the migration runs
    await db.exec(`
      insert into providers (id, name, api_url) values ('00000000-0000-4000-8000-0000000a0001', 'RootPanel', 'https://r');
      insert into categories (id, platform_id, name, slug) values ('${CATEGORY}', (select id from platforms where slug = 'instagram'), 'Followers', 'followers-seg');`)
    source = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('00000000-0000-4000-8000-0000000a0001', '1', 'x', 1, 10, 1000) returning id`)).rows[0].id
    existing = await card('Instagram Followers | HQ | Refill 30D')
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the cards that exist get theirs when the migration runs', async () => {
    expect(await segmentsOf(existing)).toEqual(['premium', 'guaranteed'])
  })

  it('a new card gets its segments by itself, and a renamed card gets them again', async () => {
    const id = await card('Instagram Followers | Slow | Organic')
    expect(await segmentsOf(id)).toEqual(['safe'])
    await db.query(`update services set name = 'Instagram Followers | HQ | Real' where id = $1`, [id])
    expect(await segmentsOf(id)).toEqual(['premium'])
    await db.query(`update services set customer_rate_per_1000 = 2 where id = $1`, [id])
    expect(await segmentsOf(id)).toEqual(['premium']) // a price change leaves them alone
  })

  it('they follow the name: a change of anything else leaves them, the next rename puts back those of the new name', async () => {
    const id = await card('Telegram Post Views')
    await db.query(`update services set segments = '{premium}' where id = $1`, [id])
    expect(await segmentsOf(id)).toEqual(['premium']) // not a rename: the trigger does not run ...
    await db.query(`update services set name = 'Telegram Post Views v2' where id = $1`, [id])
    expect(await segmentsOf(id)).toEqual([]) // ... and the next rename puts the name's own back
  })

  it('anon and authenticated read the column (the storefront filters on it), nobody else gets the function', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ ok: boolean }>(`select has_column_privilege($1, 'public.services', 'segments', 'select') ok`, [role])).rows[0].ok).toBe(true)
      expect((await db.query<{ ok: boolean }>(`select has_function_privilege($1, 'public.service_segments(text)', 'execute') ok`, [role])).rows[0].ok).toBe(false)
    }
  })

  it('a filter on a segment is served by an index of the active cards', async () => {
    const idx = (await db.query<{ def: string }>(`select indexdef def from pg_indexes where indexname = 'idx_services_segments'`)).rows[0]?.def
    expect(idx).toMatch(/gin \(segments\)/)
    expect(idx).toMatch(/where is_active/i)
  })
})
