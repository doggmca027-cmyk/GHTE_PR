// A category with an active card is active (migration 20261229000000): the categories hidden by the compaction that hold active cards come back, and
// from then on storing or switching on a card switches its category on. Runs on a database built up to the migration, with the data it has to fix.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261229000000_category_follows_its_services.sql'

describe('a category with an active card is active', () => {
  let db: PGlite
  let seq = 0
  const ids: Record<string, string> = {}
  let source: string
  const category = async (name: string, active: boolean, sourceKey: string | null) =>
    (await db.query<{ id: string }>(`insert into categories (platform_id, name, slug, is_active, source_key) values ((select id from platforms where slug = 'instagram'), $1, $2, $3, $4) returning id`, [name, `slug-${++seq}`, active, sourceKey])).rows[0].id
  const card = async (cat: string, active: boolean) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 100, $4) returning id`, [cat, `card ${++seq}`, source, active])).rows[0].id
  const active = async (id: string) => (await db.query<{ v: boolean }>(`select is_active v from categories where id = $1`, [id])).rows[0].v

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x < MIGRATION).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into providers (id, name, api_url) values ('00000000-0000-4000-8000-0000000a0a01', 'P', 'https://p')`)
    source = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('00000000-0000-4000-8000-0000000a0a01', '1', 'p', 1, 10, 100) returning id`)).rows[0].id
    // what the migration meets: hidden categories with an active card, one without, an ordinary one that was hidden
    ids.hiddenCanonical = await category('Hidden canonical', false, 'canonical:instagram:followers')
    await card(ids.hiddenCanonical, true)
    ids.hiddenOther = await category('Hidden other', false, null)
    await card(ids.hiddenOther, true)
    ids.hiddenEmpty = await category('Hidden empty', false, 'canonical:instagram:likes')
    await card(ids.hiddenEmpty, false)
    ids.shown = await category('Shown', true, null)
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the categories that hold an active card are switched on; one with only inactive cards stays off; nothing is switched off', async () => {
    expect(await active(ids.hiddenCanonical)).toBe(true)
    expect(await active(ids.hiddenOther)).toBe(true)
    expect(await active(ids.hiddenEmpty)).toBe(false)
    expect(await active(ids.shown)).toBe(true)
  })

  it('a card stored active switches its category on', async () => {
    const cat = await category('Hidden again', false, 'canonical:instagram:views')
    await card(cat, true)
    expect(await active(cat)).toBe(true)
  })

  it('a card stored inactive does not', async () => {
    const cat = await category('Stays hidden', false, 'canonical:instagram:comments')
    await card(cat, false)
    expect(await active(cat)).toBe(false)
  })

  it('a card switched on, or moved into the category, switches it on; switching a card off never switches a category off', async () => {
    const cat = await category('Wakes up', false, 'canonical:instagram:saves')
    const id = await card(cat, false)
    expect(await active(cat)).toBe(false)
    await db.query(`update services set is_active = true where id = $1`, [id])
    expect(await active(cat)).toBe(true)

    const target = await category('Receives a card', false, null)
    const moving = await card(ids.shown, true)
    await db.query(`update services set category_id = $2 where id = $1`, [moving, target])
    expect(await active(target)).toBe(true)

    await db.query(`update services set is_active = false where id = $1`, [moving])
    expect(await active(target)).toBe(true)
  })

  it('clients cannot call the trigger function', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ v: boolean }>(`select has_function_privilege($1, 'public.activate_category_of_service()', 'execute') v`, [role])).rows[0].v).toBe(false)
    }
  })
})
