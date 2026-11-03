// The last active card with the code of SMM Center and no working offer leaves the storefront (migration 20261231000400).
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261231000400_hide_dead_smmc_card.sql'
const P = { center: '00000000-0000-4000-8000-0000000b1001', root: '00000000-0000-4000-8000-0000000b1002' }

describe('the dead card of SMM Center', () => {
  let db: PGlite
  let category: string
  const id: Record<string, string> = {}
  const panel = async (provider: string, external: string, name: string) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, 1, 10, 1000) returning id`, [provider, external, name])).rows[0].id
  const card = async (name: string, primary: string, active = true) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 2, 10, 1000, $4) returning id`, [category, name, primary, active])).rows[0].id
  const active = async (service: string) => (await db.query<{ a: boolean }>(`select is_active a from services where id = $1`, [service])).rows[0].a

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x < MIGRATION).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers (id, name, api_url, is_active, routing_enabled, health_status) values ('${P.center}', 'SMM Center', 'https://c', false, false, 'disabled'), ('${P.root}', 'RootPanel', 'https://r', true, true, 'healthy');`)
    category = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'facebook'), 'Followers', 'followers-dead') returning id`)).rows[0].id
    id.dead = await card('Facebook Profile Followers [refill: lifetime]', await panel(P.center, '27897', 'Facebook Profile Followers [refill: lifetime]'))
    // it keeps the code of SMM Center but a provider that is on serves it: not this migration's business
    id.served = await card('Facebook Page Likes', await panel(P.center, '27898', 'Facebook Page Likes'))
    await db.query(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 1000, true)`, [id.served, P.root, await panel(P.root, '9', 'Facebook Page Likes')])
    id.own = await card('Facebook Views', await panel(P.root, '10', 'Facebook Views'))
    id.hidden = await card('Facebook Shares', await panel(P.center, '27899', 'Facebook Shares'), false)
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('switches off the card whose article is SMMC and has no working offer', async () => {
    expect((await db.query<{ sku: string }>(`select sku from services where id = $1`, [id.dead])).rows[0].sku).toMatch(/-SMMC27897$/)
    expect(await active(id.dead)).toBe(false)
  })

  it('leaves alone a card of SMM Center that a provider which is on serves, a card of a provider that is on, and a card that was off', async () => {
    expect(await active(id.served)).toBe(true)
    expect(await active(id.own)).toBe(true)
    expect(await active(id.hidden)).toBe(false)
  })

  it('does not delete anything, and the category counts only what is on sale', async () => {
    expect((await db.query<{ n: number }>(`select count(*)::int n from services where category_id = $1`, [category])).rows[0].n).toBe(4)
    expect((await db.query<{ n: number }>(`select active_service_count n from categories where id = $1`, [category])).rows[0].n).toBe(2)
  })

  it('is safe to run again', async () => {
    await db.exec(fs.readFileSync(path.join(dir, MIGRATION), 'utf8'))
    expect([await active(id.dead), await active(id.served), await active(id.own)]).toEqual([false, true, true])
  })
})
