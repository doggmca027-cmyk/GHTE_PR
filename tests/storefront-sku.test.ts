// The article number (SKU) of a storefront card (migration 20261230000000): copied from the card's primary panel service, issued once, public.
// The support assistant gives it to a customer and the storefront search finds the card by it.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261230000000_storefront_sku.sql'
const SEC = '00000000-0000-4000-8000-0000000e0001'
const CATEGORY = '00000000-0000-4000-8000-0000000e00c1'

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

describe('the article of a card', () => {
  let db: PGlite
  const panelService = async (external: string, name = 'Instagram Followers | 30 Days Refill - Real - 70K/Day') =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, 1, 10, 1000) returning id`, [SEC, external, name])).rows[0].id
  const card = async (primary: string, name = 'Instagram Followers') =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 1000, true) returning id`, [CATEGORY, name, primary])).rows[0].id
  const skuOf = async (id: string) => (await db.query<{ sku: string | null }>(`select sku from services where id = $1`, [id])).rows[0].sku
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    db = await freshDb(MIGRATION) // everything before the migration: it runs below, on cards that exist already
    await db.exec(`
      insert into providers (id, name, api_url, is_premium) values ('${SEC}', 'Secsers', 'https://s', true);
      insert into categories (id, platform_id, name, slug) values ('${CATEGORY}', (select id from platforms where slug = 'instagram'), 'Followers', 'followers-sku');`)
    ids.panel = await panelService('9986')
    ids.twinPanel = await panelService('77', 'Instagram Likes')
    ids.existing = await card(ids.panel)
    ids.twinA = await card(ids.twinPanel)
    ids.twinB = await card(ids.twinPanel)
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('the cards that exist get the article of their panel service when the migration runs; two cards on one panel service are told apart', async () => {
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    expect(await skuOf(ids.existing)).toBe('IG-FOL-HQ-SEC9986')
    const [a, b] = [await skuOf(ids.twinA), await skuOf(ids.twinB)]
    expect(a).not.toBe(b)
    expect([a, b].filter((s) => s === 'IG-LIKE-STD-SEC77')).toHaveLength(1)
    expect([a, b].filter((s) => /^IG-LIKE-STD-SEC77-[0-9a-f]{4}$/.test(s ?? ''))).toHaveLength(1)
  })

  it('a card stored later gets the article of its primary panel service by itself, and no two cards share one', async () => {
    const panel = await panelService('5197', '🔵 Instagram Followers | Brazil | 30 Day Refill | HQ')
    const first = await card(panel)
    expect(await skuOf(first)).toBe('IG-FOL-HQ-SEC5197')
    const second = await card(panel)
    expect(await skuOf(second)).toMatch(/^IG-FOL-HQ-SEC5197-[0-9a-f]{4}$/)
    await expect(db.query(`update services set sku = $2 where id = $1`, [second, 'IG-FOL-HQ-SEC5197'])).rejects.toThrow(/uq_services_sku|duplicate key/)
  })

  it('is issued once: pointing the card at another panel service, or renaming the panel service, does not renumber it', async () => {
    const other = await panelService('4321', 'Instagram Views')
    await db.query(`update services set primary_provider_service_id = $2 where id = $1`, [ids.existing, other])
    expect(await skuOf(ids.existing)).toBe('IG-FOL-HQ-SEC9986')
    await db.query(`update provider_services set name = 'Instagram Views | renamed' where id = $1`, [other])
    expect(await skuOf(ids.existing)).toBe('IG-FOL-HQ-SEC9986')
  })

  it('never blocks a publish: a card whose panel service has no article is stored without one', async () => {
    const bare = await panelService('1')
    await db.query(`update provider_services set sku = null where id = $1`, [bare])
    const id = await card(bare)
    expect(await skuOf(id)).toBeNull()
  })
})

describe('who reads it', () => {
  let db: PGlite
  beforeAll(async () => { db = await freshDb() }, 240_000)
  afterAll(async () => { await db.close() })
  const can = async (role: string, table: string) =>
    (await db.query<{ ok: boolean }>(`select has_column_privilege($1, $2, 'sku', 'select') ok`, [role, `public.${table}`])).rows[0].ok

  it.each(['anon', 'authenticated'])('%s reads the article on the storefront card, and still not on the panel service', async (role) => {
    expect(await can(role, 'services')).toBe(true)
    expect(await can(role, 'provider_services')).toBe(false)
  })

  it('the routing columns of the card stay private', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const column of ['primary_provider_service_id', 'fallback_provider_service_id']) {
        expect((await db.query<{ ok: boolean }>(`select has_column_privilege($1, 'public.services', $2, 'select') ok`, [role, column])).rows[0].ok).toBe(false)
      }
    }
  })
})
