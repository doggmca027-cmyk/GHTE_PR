// The article of a card without the code of a provider (migration 20261231000900): every card is renumbered, no order is touched, the numbers stay unique
// and are issued once, and the provider's own (admin-only) article keeps its panel code.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SKU_PATTERN, skuFromQuery } from '../src/lib/service-search'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261231000900_anonymous_sku.sql'
const SEC = '00000000-0000-4000-8000-0000000f0001'
const ROOT = '00000000-0000-4000-8000-0000000f0002'
const CATEGORY = '00000000-0000-4000-8000-0000000f00c1'
const PROVIDER_CODES = /SEC|ROOT|MTP|JAP|SMMF|SMMC|PWR|STONE/i

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

describe('anonymous articles', () => {
  let db: PGlite
  let n = 0
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  const panel = async (provider: string, external: string, name: string) =>
    (await q<{ id: string; sku: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, 1, 10, 1000) returning id, sku`, [provider, external, name]))[0]!
  const card = async (primary: string, name = 'Instagram Followers') =>
    (await q<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 1000, true) returning id`, [CATEGORY, name, primary]))[0]!.id
  const skuOf = async (id: string) => (await q<{ sku: string | null }>('select sku from services where id = $1', [id]))[0]!.sku
  const old: Record<string, string> = {}
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    db = await freshDb(MIGRATION) // everything before the migration: it runs below, on cards that exist already
    await db.exec(`
      insert into providers (id, name, api_url, is_premium) values ('${SEC}', 'Secsers', 'https://s', true), ('${ROOT}', 'RootPanel', 'https://r', false);
      insert into categories (id, platform_id, name, slug) values ('${CATEGORY}', (select id from platforms where slug = 'instagram'), 'Followers', 'followers-anon');`)
    const hq = await panel(SEC, '9986', 'Instagram Followers | 30 Days Refill - Real - 70K/Day')
    const std = await panel(ROOT, '89336', 'Instagram Likes')
    const twinPanel = await panel(ROOT, '77', 'TikTok Views')
    ids.hq = await card(hq.id)
    ids.std = await card(std.id, 'Instagram Likes')
    ids.twinA = await card(twinPanel.id, 'TikTok Views')
    ids.twinB = await card(twinPanel.id, 'TikTok Views')
    for (const k of ['hq', 'std', 'twinA', 'twinB']) old[k] = (await skuOf(ids[k]!))!
    // an order on a card: it must survive untouched
    await q(`insert into users (telegram_id) values (777001)`)
    const user = (await q<{ id: string }>(`select id from users where telegram_id = 777001`))[0]!.id
    ids.user = user
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 50::numeric, null, 'fund', $2)`, [user, `fund-${user}`])
    const offer = (await q<{ id: string; provider_id: string; provider_service_id: string }>(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [ids.hq]))[0]!
    await q('update provider_service_offers set cost_per_1000 = 0.5 where id = $1', [offer.id])
    ids.order = (await q<{ v: string }>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 0.5::numeric, 'anon-sku-1')`, [user, ids.hq, offer.id, offer.provider_id, offer.provider_service_id]))[0]!.v
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('before the migration the articles carry the codes of the providers (the leak)', () => {
    expect(old.hq).toMatch(/^IG-FOL-HQ-SEC9986$/)
    expect(old.std).toMatch(/ROOT89336/)
    for (const k of ['hq', 'std', 'twinA', 'twinB']) expect(old[k]).toMatch(PROVIDER_CODES)
  })

  it('after it: every card has PLATFORM-TYPE-QUALITY-CODE with a hash of its own id, and no trace of a provider', async () => {
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    for (const k of ['hq', 'std', 'twinA', 'twinB']) {
      const sku = (await skuOf(ids[k]!))!
      expect(sku, k).toMatch(/^[A-Z]{2,4}-[A-Z]{2,5}-(HQ|STD|CHEAP)-[0-9A-F]{6,12}$/)
      expect(sku, k).not.toMatch(PROVIDER_CODES)
      expect(sku.split('-').slice(0, 3).join('-'), k).toBe(old[k]!.split('-').slice(0, 3).join('-')) // what the card is stays
    }
    expect(await skuOf(ids.hq!)).toMatch(/^IG-FOL-HQ-[0-9A-F]{6}$/)
  })
  it('the code is the card\'s own hash: nothing of the panel\'s number is in it, and two cards on one panel service differ', async () => {
    const [a, b] = [await skuOf(ids.twinA!), await skuOf(ids.twinB!)]
    expect(a).not.toBe(b)
    expect(await q<{ ok: boolean }>(`select sku = split_part(sku, '-', 1) || '-' || split_part(sku, '-', 2) || '-' || split_part(sku, '-', 3) || '-' || card_sku_code(id) as ok from services where id = $1`, [ids.hq])).toEqual([{ ok: true }])
    expect(await skuOf(ids.hq!)).not.toContain('9986')
  })
  it('every article that is stored is unique, and matches the pattern the search box uses', async () => {
    const rows = await q<{ sku: string }>('select sku from services where sku is not null')
    expect(new Set(rows.map((r) => r.sku)).size).toBe(rows.length)
    for (const { sku } of rows) {
      expect(SKU_PATTERN.test(sku), sku).toBe(true)
      expect(skuFromQuery(`  **${sku.toLowerCase()}**  `)).toBe(sku)
    }
  })
  it('the order is untouched: it still points at its card, with its price and status', async () => {
    const [o] = await q<{ service_id: string; status: string; quantity: number; charge_amount: string }>('select service_id, status::text, quantity, charge_amount::text from orders where id = $1', [ids.order])
    expect(o).toMatchObject({ service_id: ids.hq, status: expect.any(String), quantity: 1000 })
    expect(Number((await q<{ balance: string }>('select balance from wallets where user_id = $1', [ids.user]))[0]!.balance)).toBeLessThan(50)
  })
  it('the admin-only article of the panel service keeps its panel code', async () => {
    const [ps] = await q<{ sku: string }>(`select sku from provider_services where external_service_id = '9986'`)
    expect(ps!.sku).toMatch(/SEC9986/)
  })
  it('running the migration again changes nothing a customer has saved? the articles are rewritten only from their own hash, so the same ones come back', async () => {
    const before = (await q<{ sku: string }>('select sku from services where sku is not null order by id')).map((r) => r.sku)
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    expect((await q<{ sku: string }>('select sku from services where sku is not null order by id')).map((r) => r.sku)).toEqual(before)
  })

  it('a card that comes later gets such an article by itself, from its panel service\'s what-it-is and its own hash; no provider in it', async () => {
    const p = await panel(SEC, `5197-${++n}`, '🔵 Instagram Followers | Brazil | 30 Day Refill | HQ')
    const id = await card(p.id, 'Instagram Followers HQ')
    const sku = (await skuOf(id))!
    expect(sku).toMatch(/^IG-FOL-HQ-[0-9A-F]{6}$/)
    expect(sku).not.toMatch(PROVIDER_CODES)
    expect(sku.split('-')[3]).toBe((await q<{ c: string }>('select card_sku_code($1::uuid) c', [id]))[0]!.c)
  })
  it('a card whose code is already taken gets a longer one, then a longer one still, and the article stays unique', async () => {
    const p = await panel(ROOT, `clash-${++n}`, 'Instagram Followers | Real')
    const id = '00000000-0000-4000-8000-0000000fc0de'
    const code = async (len: number) => (await q<{ c: string }>('select card_sku_code($1::uuid, $2) c', [id, len]))[0]!.c
    const [six, eight, twelve] = [await code(6), await code(8), await code(12)]
    const insert = () => q(`insert into services (id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, 'Claimant', $3, 1, 10, 1000, true)`, [id, CATEGORY, p.id])
    const squatter = await card(p.id, 'Squatter')
    await q('update services set sku = $2 where id = $1', [squatter, `IG-FOL-HQ-${six}`]) // somebody holds the 6 characters
    await insert()
    expect(await skuOf(id)).toBe(`IG-FOL-HQ-${eight}`)
    await q('delete from services where id = $1', [id])
    const squatter2 = await card(p.id, 'Squatter 2')
    await q('update services set sku = $2 where id = $1', [squatter2, `IG-FOL-HQ-${eight}`]) // ...and the 8
    await insert()
    expect(await skuOf(id)).toBe(`IG-FOL-HQ-${twelve}`)
  })
  it('the code is between 6 and 12 characters whatever is asked, upper-case hex', async () => {
    const id = '00000000-0000-4000-8000-000000000abc'
    const lens = await q<{ l: number; c: string }>(`select l, card_sku_code($1::uuid, l) c from unnest(array[0, 6, 8, 12, 40]) l`, [id])
    expect(lens.map((r) => r.c.length)).toEqual([6, 6, 8, 12, 12])
    for (const r of lens) expect(r.c).toMatch(/^[0-9A-F]+$/)
  })

  it('the helpers are for nobody but the service role', async () => {
    for (const fn of ['card_sku_code(uuid, integer)', 'card_sku_prefix(text)']) {
      const [g] = await q<{ anon: boolean; authed: boolean }>(`select has_function_privilege('anon', '${fn}', 'execute') anon, has_function_privilege('authenticated', '${fn}', 'execute') authed`)
      expect([g!.anon, g!.authed], fn).toEqual([false, false])
    }
  })
})
