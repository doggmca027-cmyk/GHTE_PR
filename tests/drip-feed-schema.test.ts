// Drip-feed, part 1: the schema (orders.runs / orders.interval, provider_services.is_dripfeed_enabled).
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PROV = '00000000-0000-0000-0000-0000000000a3'
const SVC = '00000000-0000-0000-0000-0000000000f3'
const OFFER = '00000000-0000-0000-0000-00000000aa03'
const PS = '00000000-0000-0000-0000-000000000a03'

describe('drip-feed schema', () => {
  let db: PGlite
  let user: string
  const err = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers(id, name, api_url, routing_enabled, health_status, provider_balance, last_balance_sync) values ('${PROV}', 'A', 'https://a.example', true, 'healthy', 1000, now());
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c3', (select id from platforms where slug = 'telegram'), 'V', 'v');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('${PS}', '${PROV}', '1', 'A', 1.0, 10, 100000);
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        values ('${SVC}', '00000000-0000-0000-0000-0000000000c3', 'V', '${PS}', 4.0, 10, 100000);
      delete from provider_service_offers;
      insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity)
        values ('${OFFER}', '${SVC}', '${PROV}', '${PS}', 1.0, 10, 100000);`)
    user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (71001) returning id`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100, null, 'f', 'f-' || $1::text)`, [user])
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('an order placed the current way is a plain order: runs 1, interval 0, quantity is the total', async () => {
    const o = (await db.query<{ id: string }>(`select id from place_order($1::uuid, '${SVC}', 'https://t.me/x', 300, '${OFFER}', '${PROV}', '${PS}', 0.3, 'k-1')`, [user])).rows[0].id
    expect((await db.query(`select quantity, runs, interval from orders where id = $1`, [o])).rows[0]).toEqual({ quantity: 300, runs: 1, interval: 0 })
  })

  it('a drip-feed shape is stored; runs below 1 and a negative interval are refused', async () => {
    const o = (await db.query<{ id: string }>(`select id from orders limit 1`)).rows[0].id
    await db.query(`update orders set runs = 3, interval = 30 where id = $1`, [o])
    expect((await db.query(`select runs, interval from orders where id = $1`, [o])).rows[0]).toEqual({ runs: 3, interval: 30 })
    expect(await err(db.query(`update orders set runs = 0 where id = $1`, [o]))).toMatch(/orders_runs_check/)
    expect(await err(db.query(`update orders set interval = -1 where id = $1`, [o]))).toMatch(/orders_interval_check/)
    expect(await err(db.query(`update orders set runs = null where id = $1`, [o]))).toMatch(/null/)
  })

  it('provider services are not drip-feed capable until the sync says so', async () => {
    expect((await db.query(`select is_dripfeed_enabled from provider_services where id = $1`, [PS])).rows[0]).toEqual({ is_dripfeed_enabled: false })
    await db.query(`update provider_services set is_dripfeed_enabled = true where id = $1`, [PS])
    expect((await db.query(`select is_dripfeed_enabled from provider_services where id = $1`, [PS])).rows[0]).toEqual({ is_dripfeed_enabled: true })
  })

  it('the migration re-runs cleanly', async () => {
    await db.exec(fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261130000000_drip_feed_schema.sql'), 'utf8'))
  })
})
