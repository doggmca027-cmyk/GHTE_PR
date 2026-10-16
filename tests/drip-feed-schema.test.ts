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

// ---------------------------------------------------------------------------
// place_order with runs / interval (migration 20261201000000)
// ---------------------------------------------------------------------------

const DPROV = '00000000-0000-0000-0000-0000000000a4'
const DSVC = '00000000-0000-0000-0000-0000000000f4'
const DOFFER = '00000000-0000-0000-0000-00000000aa04'
const DPS = '00000000-0000-0000-0000-000000000a04'
const PLAIN_SVC = '00000000-0000-0000-0000-0000000000f5'
const PLAIN_OFFER = '00000000-0000-0000-0000-00000000aa05'
const PLAIN_PS = '00000000-0000-0000-0000-000000000a05'

describe('place_order: drip-feed', () => {
  let db: PGlite
  let user: string
  let seq = 0
  const err = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }
  const num = async (sql: string, args: unknown[] = []) => Number(Object.values((await db.query<Record<string, unknown>>(sql, args)).rows[0])[0])
  const balance = () => num(`select balance from wallets where user_id = $1`, [user])
  const reserved = () => num(`select provider_balance from providers where id = $1`, [DPROV])
  /** place_order on the drip-feed service: cost = 1.0 per 1000 of the TOTAL. */
  const place = (quantity: number, runs?: number, interval?: number, opts: { svc?: string; offer?: string; ps?: string; key?: string } = {}) =>
    db.query<Record<string, unknown>>(
      `select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', $3, $4::uuid, '${DPROV}', $5::uuid, $6, $7, null, false, $8, $9)`,
      [user, opts.svc ?? DSVC, quantity, opts.offer ?? DOFFER, opts.ps ?? DPS, quantity / 1000, opts.key ?? `d-${++seq}`, runs ?? 1, interval ?? 0],
    ).then((r) => r.rows[0])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    // one run: 10..1000. The drip-feed provider service is capable, the plain one is not.
    await db.exec(`
      insert into providers(id, name, api_url, routing_enabled, health_status, provider_balance, last_balance_sync) values ('${DPROV}', 'D', 'https://d.example', true, 'healthy', 1000, now());
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-0000-0000-0000000000c4', (select id from platforms where slug = 'telegram'), 'D', 'd');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, is_dripfeed_enabled) values
        ('${DPS}', '${DPROV}', '1', 'Drip', 1.0, 10, 1000, true),
        ('${PLAIN_PS}', '${DPROV}', '2', 'Plain', 1.0, 10, 1000, false);
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values
        ('${DSVC}', '00000000-0000-0000-0000-0000000000c4', 'Drip', '${DPS}', 4.0, 10, 1000),
        ('${PLAIN_SVC}', '00000000-0000-0000-0000-0000000000c4', 'Plain', '${PLAIN_PS}', 4.0, 10, 1000);
      delete from provider_service_offers;
      insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values
        ('${DOFFER}', '${DSVC}', '${DPROV}', '${DPS}', 1.0, 10, 1000),
        ('${PLAIN_OFFER}', '${PLAIN_SVC}', '${DPROV}', '${PLAIN_PS}', 1.0, 10, 1000);`)
    user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (71002) returning id`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 500, null, 'f', 'f-' || $1::text)`, [user])
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('5000 in 5 runs of 1000 passes a 1000 max; charged and reserved on the TOTAL; ledger drift stays 0', async () => {
    const expected = await num(`select (calculate_order_price($1::uuid, '${DSVC}', 5000, 5, null)->>'final_price')::numeric`, [user])
    const [walletBefore, providerBefore] = [await balance(), await reserved()]
    const o = await place(5000, 5, 30)
    expect(o).toMatchObject({ quantity: 5000, runs: 5, interval: 30, status: 'paid' })
    expect(Number(o.charge_amount)).toBe(expected)
    expect(Number(o.cost_amount)).toBe(5)                 // 1.0 per 1000 x 5000
    expect(await balance()).toBeCloseTo(walletBefore - expected, 4)
    expect(await reserved()).toBeCloseTo(providerBefore - 5, 4)
    expect(await num(`select ledger_drift_count()`)).toBe(0)
  })

  it('the same total in ONE run is over the max; per-run limits are checked on both the service and the offer', async () => {
    expect(await err(place(5000))).toMatch(/quantity must be between 10 and 1000/)
    expect(await err(place(5000, 1000, 5))).toMatch(/quantity per run must be between 10 and 1000/)  // 5 per run
    expect(await err(place(6000, 5, 30))).toMatch(/quantity per run must be between 10 and 1000/)    // 1200 per run
    await db.query(`update provider_service_offers set max_quantity = 500 where id = $1`, [DOFFER])
    expect(await err(place(4000, 4, 30))).toMatch(/outside the limits of the selected provider offer/)  // 1000 per run > offer max 500
    await db.query(`update provider_service_offers set max_quantity = 1000 where id = $1`, [DOFFER])
  })

  it('refuses before charging: a total that does not split into whole runs, bad runs / interval, a provider service without drip-feed', async () => {
    const before = await balance()
    expect(await err(place(1000, 3, 30))).toMatch(/quantity must split evenly into runs/)
    expect(await err(place(1000, 0, 30))).toMatch(/runs must be at least 1/)
    expect(await err(place(1000, 2, -1))).toMatch(/interval must not be negative/)
    expect(await err(place(2000, 2, 30, { svc: PLAIN_SVC, offer: PLAIN_OFFER, ps: PLAIN_PS }))).toMatch(/does not support drip-feed/)
    expect(await balance()).toBe(before)
    expect(await num(`select ledger_drift_count()`)).toBe(0)
  })

  it('a plain order is unchanged: runs 1, interval stored as 0 whatever was passed; the old 11-argument call still works', async () => {
    const o = await place(1000, 1, 45, { svc: PLAIN_SVC, offer: PLAIN_OFFER, ps: PLAIN_PS })
    expect(o).toMatchObject({ quantity: 1000, runs: 1, interval: 0 })
    const legacy = (await db.query<Record<string, unknown>>(
      `select * from place_order($1::uuid, '${PLAIN_SVC}', 'https://t.me/x', 500, '${PLAIN_OFFER}', '${DPROV}', '${PLAIN_PS}', 0.5, 'legacy-1', null, false)`, [user])).rows[0]
    expect(legacy).toMatchObject({ quantity: 500, runs: 1, interval: 0 })
  })

  it('a replay returns the same order; the same key with another schedule is a conflict', async () => {
    const first = await place(2000, 2, 60, { key: 'replay-1' })
    const before = await balance()
    expect((await place(2000, 2, 60, { key: 'replay-1' })).id).toBe(first.id)
    expect(await balance()).toBe(before)
    expect(await err(place(2000, 4, 60, { key: 'replay-1' }))).toMatch(/already used with different parameters/)
    expect(await err(place(2000, 2, 15, { key: 'replay-1' }))).toMatch(/already used with different parameters/)
  })

  it('quote_order_price prices a drip-feed order like place_order: per-run limits, capable offers only, price on the total', async () => {
    const quote = (quantity: number, runs?: number, svc = DSVC) =>
      db.query<{ q: Record<string, unknown> }>(`select quote_order_price($1::uuid, $2::uuid, $3, null, $4) q`, [user, svc, quantity, runs ?? 1]).then((r) => r.rows[0].q)
    const expected = await num(`select (calculate_order_price($1::uuid, '${DSVC}', 5000, 5, null)->>'final_price')::numeric`, [user])
    expect(Number((await quote(5000, 5)).final_price)).toBe(expected)
    expect(await err(quote(5000))).toMatch(/service_unavailable/)                 // one run of 5000 is over the max
    expect(await err(quote(1000, 3))).toMatch(/quantity must split evenly into runs/)
    expect(await err(quote(2000, 2, PLAIN_SVC))).toMatch(/service_unavailable/)  // no drip-feed capable offer
    expect(Number((await quote(1000, 1, PLAIN_SVC)).final_price)).toBeGreaterThan(0)
    // the old 4-argument call is a plain quote
    expect(Number((await db.query<{ q: Record<string, unknown> }>(`select quote_order_price($1::uuid, '${PLAIN_SVC}', 1000, null) q`, [user])).rows[0].q.final_price)).toBeGreaterThan(0)
  })

  it('services.dripfeed_available follows the routable drip-feed capable offers; clients may read it, only the service role rebuilds it', async () => {
    const flags = async () => Object.fromEntries((await db.query<{ id: string; d: boolean }>(`select id, dripfeed_available d from services where id in ('${DSVC}', '${PLAIN_SVC}')`)).rows.map((r) => [r.id, r.d]))
    await db.query(`select refresh_service_dripfeed()`)
    expect(await flags()).toEqual({ [DSVC]: true, [PLAIN_SVC]: false })
    await db.query(`update providers set routing_enabled = false where id = $1`, [DPROV])
    expect(await num(`select refresh_service_dripfeed()`)).toBe(1)
    expect(await flags()).toEqual({ [DSVC]: false, [PLAIN_SVC]: false })
    await db.query(`update providers set routing_enabled = true where id = $1`, [DPROV])
    await db.query(`update provider_services set is_dripfeed_enabled = true where id = $1`, [PLAIN_PS])
    await db.query(`select refresh_service_dripfeed()`)
    expect(await flags()).toEqual({ [DSVC]: true, [PLAIN_SVC]: true })
    expect(await num(`select refresh_service_dripfeed()`)).toBe(0)                 // nothing to change: nothing written
    await db.query(`update provider_services set is_dripfeed_enabled = false where id = $1`, [PLAIN_PS])
    await db.query(`select refresh_service_dripfeed()`)
    for (const role of ['anon', 'authenticated']) {
      expect(await num(`select has_column_privilege('${role}', 'public.services', 'dripfeed_available', 'select')::int`)).toBe(1)
      expect(await num(`select has_function_privilege('${role}', 'public.refresh_service_dripfeed()', 'execute')::int`)).toBe(0)
      expect(await num(`select has_function_privilege('${role}', 'public.quote_order_price(uuid, uuid, integer, text, integer)', 'execute')::int`)).toBe(0)
    }
  })

  it('only the service role may call it', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await num(`select has_function_privilege('${role}', 'public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer)', 'execute')::int`)).toBe(0)
    }
    expect(await num(`select has_function_privilege('service_role', 'public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer)', 'execute')::int`)).toBe(1)
    expect(await num(`select count(*) from pg_proc where proname = 'place_order'`)).toBe(1)
  })
})
