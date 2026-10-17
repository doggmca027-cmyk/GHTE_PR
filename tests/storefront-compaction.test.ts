// Storefront compaction (migration 20261207000000): donor-published English duplicates leave the storefront, unique platforms stay,
// the donors go back to linked_only and keep serving through offers.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rankOffers } from '../supabase/functions/_shared/routing.ts'

const MIGRATION = path.resolve(__dirname, '../supabase/migrations/20261207000000_storefront_compaction.sql')

describe('storefront compaction', () => {
  let db: PGlite
  const ids: Record<string, string> = {}
  const active = async (id: string) => (await db.query<{ a: boolean }>(`select is_active a from services where id = $1`, [id])).rows[0].a

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const one = async (sql: string, args: unknown[] = []) => (await db.query<{ id: string }>(sql, args)).rows[0].id
    ids.center = await one(`insert into providers (name, api_url, routing_enabled, catalog_mode) values ('SMM Center', 'https://c', true, 'publish') returning id`)
    ids.jap = await one(`insert into providers (name, api_url, routing_enabled, catalog_mode, publish_mapping) values ('JAP', 'https://j', true, 'publish', 'canonical') returning id`)
    const cat = (platform: string, name: string, key: string | null) =>
      one(`insert into categories (platform_id, name, slug, source_key) values ((select id from platforms where slug = $1), $2, $3, $4) returning id`, [platform, name, `${platform}-${name}`.toLowerCase().replace(/\W+/g, '-'), key])
    const service = async (provider: string, category: string, name: string, autoPublished: boolean) => {
      const ps = await one(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $2, 1, 10, 1000) returning id`, [provider, name])
      return one(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, auto_published) values ($1, $2, $3, 1.8, 10, 1000, $4) returning id`, [category, name, ps, autoPublished])
    }
    const tgRef = await cat('telegram', 'Telegram Members [0% drops]', 'участники telegram')
    const tgJap = await cat('telegram', 'Telegram Members', 'canonical:telegram:members')
    const other = await cat('other', 'Views (Other platforms)', 'canonical:other:views')
    ids.reference = await service(ids.center, tgRef, 'Telegram Members [refill: 30 days]', true)
    ids.duplicate = await service(ids.jap, tgJap, 'Telegram Members [Refill: 30D]', true)
    ids.unique = await service(ids.jap, other, 'Some Site Views [USA]', true)
    ids.manual = await service(ids.jap, tgRef, 'Telegram Members [manual]', false) // created by an admin, not by publishing
    ids.tgJapCat = tgJap
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'))
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('the donors are hidden suppliers again', async () => {
    expect((await db.query<{ m: string }>(`select catalog_mode m from providers where id = $1`, [ids.jap])).rows[0].m).toBe('linked_only')
    expect((await db.query<{ m: string }>(`select catalog_mode m from providers where id = $1`, [ids.center])).rows[0].m).toBe('publish')
  })

  it('a published duplicate on a covered platform goes; the reference, a unique platform and an admin-made service stay', async () => {
    expect(await active(ids.duplicate)).toBe(false)
    expect(await active(ids.reference)).toBe(true)
    expect(await active(ids.unique)).toBe(true)
    expect(await active(ids.manual)).toBe(true)
    expect((await db.query<{ a: boolean }>(`select is_active a from categories where id = $1`, [ids.tgJapCat])).rows[0].a).toBe(false)
    // nothing is deleted: the hidden service and its offer are still there
    expect((await db.query<{ n: number }>(`select count(*)::int n from provider_service_offers o join services s on s.id = o.service_id where s.id = $1`, [ids.duplicate])).rows[0].n).toBe(1)
  })

  it('running it again changes nothing', async () => {
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'))
    expect([await active(ids.reference), await active(ids.unique), await active(ids.duplicate)]).toEqual([true, true, false])
  })

  it('routing does not look at catalog_mode: a linked_only donor offer is still chosen when it is the cheapest', () => {
    const provider = (id: string) => ({ id, name: id, apiUrl: 'x', apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy' as const, lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0 })
    const offer = (id: string, providerId: string, cost: number) => ({ id, serviceId: 's', providerId, providerServiceId: `ps-${id}`, costPer1000: cost, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: 't', updatedAt: 't' })
    expect(rankOffers([offer('center', 'c', 1), offer('donor', 'j', 0.4)], [provider('c'), provider('j')], { quantity: 100 }).map((o) => o.id)).toEqual(['donor', 'center'])
  })
})
