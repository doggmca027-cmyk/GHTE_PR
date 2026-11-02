// The retired providers leave no tail (migration 20261227000000): no order can go to a provider that is switched off, their keys are gone, their top-up
// proposals are rejected and their arbitrage links dropped. Runs on a database built up to the migration, with the data it has to clean.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const FOUR = ['SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider']
const dir = path.resolve(__dirname, '../supabase/migrations')
const CLEANUP = '20261227000000_retired_providers_cleanup.sql'
const P = {
  center: '00000000-0000-4000-8000-0000000d0001', stone: '00000000-0000-4000-8000-0000000d0002', pwr: '00000000-0000-4000-8000-0000000d0003', smmp: '00000000-0000-4000-8000-0000000d0004',
  jap: '00000000-0000-4000-8000-0000000d0005', secsers: '00000000-0000-4000-8000-0000000d0006',
}

describe('the retired providers leave no tail', () => {
  let db: PGlite
  let cat: string, seq = 0, user: string
  const S: Record<string, string> = {}
  const O: Record<string, string> = {}
  const value = async (sql: string, ...args: unknown[]) => (await db.query<{ v: boolean | number | string | null }>(sql, args)).rows[0].v
  const err = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return e instanceof Error ? e.message : String(e) } }
  const ps = async (provider: string, name: string, rate: number) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 10, 100000) returning id`, [provider, `e${++seq}`, name, rate])).rows[0].id
  const card = async (name: string, source: string) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 4, 10, 10000, true) returning id`, [cat, name, source])).rows[0].id
  const offer = async (service: string, provider: string, source: string, cost: number) =>
    (await db.query<{ id: string }>(`insert into provider_service_offers (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 10, 100000, true) returning id`, [service, provider, source, cost])).rows[0].id
  /** A card gets an offer on its primary provider service by itself (trigger): the one at the provider the card came from. */
  const ownOffer = async (service: string) => (await db.query<{ id: string }>(`select id from provider_service_offers where service_id = $1`, [service])).rows[0].id
  /** place_order on one offer: the provider can pay, the customer can pay, so only the guard can stop it. */
  const place = (service: string, provider: string, offerId: string, source: string, key: string, cost = 1.0) =>
    db.query<{ id: string; status: string }>(`select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, $7::numeric, $6::text, null, false)`, [user, service, offerId, provider, source, key, cost])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    // everything up to the cleanup: it runs below, on data
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x < CLEANUP).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into providers (id, name, api_url, is_active, routing_enabled, health_status, catalog_mode, api_key_encrypted, provider_balance, last_balance_sync) values
      ('${P.center}', 'SMM Center', 'https://c', false, false, 'disabled', 'publish', 'v1:aaaa:bbbb', 100, now()), ('${P.stone}', 'SMMStone', 'https://s', false, false, 'disabled', 'linked_only', 'v1:aaaa:bbbb', 100, now()),
      ('${P.pwr}', 'SMMPWR', 'https://p', false, false, 'disabled', 'linked_only', 'v1:aaaa:bbbb', 100, now()), ('${P.smmp}', 'SMMProvider', 'https://m', false, false, 'disabled', 'linked_only', 'v1:aaaa:bbbb', 100, now()),
      ('${P.jap}', 'JAP', 'https://j', true, true, 'healthy', 'linked_only', 'v1:cccc:dddd', 100, now()), ('${P.secsers}', 'Secsers', 'https://x', true, true, 'healthy', 'publish', 'v1:eeee:ffff', 100, now())`)
    cat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'C', 'c') returning id`)).rows[0].id
    user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (92001) returning id`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100::numeric, null, 'fund', 'fund-cleanup')`, [user])

    // a card whose old offer at a retired provider was left active by mistake, next to a working one
    const centerPs = await ps(P.center, 'Instagram Likes [Aruba]', 1)
    S.stray = await card('Instagram Likes [Aruba]', centerPs)
    O.stray = await ownOffer(S.stray)
    S.strayJap = await ps(P.jap, 'Instagram Likes [Aruba] JAP', 1.5)
    O.japOnStray = await offer(S.stray, P.jap, S.strayJap, 1.5)
    S.strayCenterPs = centerPs
    // an offer that places the order in the hub: the guard also holds on the update
    const stonePs = await ps(P.stone, 'Instagram Likes [Belize]', 1)
    S.waiting = await card('Instagram Likes [Belize]', stonePs)
    O.stone = await ownOffer(S.waiting)

    // what the cleanup has to remove, and what it has to leave
    for (const id of [P.center, P.stone, P.pwr, P.smmp, P.jap]) await db.query(`select create_topup_proposal($1::uuid, 100)`, [id])
    for (const [prov, source, offerId] of [[P.center, centerPs, O.stray], [P.stone, stonePs, O.stone], [P.jap, S.strayJap, O.japOnStray]] as const) {
      await db.query(`insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, status, offer_id) values ((select service_id from provider_service_offers where id = $1), $2, $3, 1, 0.9, 0.1, 'auto_linked', $1)`, [offerId, source, prov])
    }
    await db.exec(fs.readFileSync(path.join(dir, CLEANUP), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('their API keys are gone, the others are untouched', async () => {
    for (const name of FOUR) expect([name, await value(`select api_key_encrypted v from providers where name = $1`, name)]).toEqual([name, null])
    expect(await value(`select count(*)::int v from providers where api_key_encrypted is not null`)).toBe(2) // JAP and Secsers
  })

  it('their pending top-up proposals are rejected, and only theirs', async () => {
    expect(await value(`select count(*)::int v from topup_proposals t join providers p on p.id = t.provider_id where p.name = any($1) and t.status = 'pending'`, FOUR)).toBe(0)
    expect(await value(`select count(*)::int v from topup_proposals t join providers p on p.id = t.provider_id where p.name = any($1) and t.status = 'rejected' and t.decided_at is not null`, FOUR)).toBe(4)
    expect(await value(`select t.status::text v from topup_proposals t join providers p on p.id = t.provider_id where p.name = 'JAP'`)).toBe('pending')
  })

  it('their arbitrage links are dropped, the offers they pointed at stay (switched off by the rotation, kept for the orders)', async () => {
    expect(await value(`select count(*)::int v from arbitrage_candidates c join providers p on p.id = c.provider_id where p.name = any($1)`, FOUR)).toBe(0)
    expect(await value(`select count(*)::int v from arbitrage_candidates c join providers p on p.id = c.provider_id where p.name = 'JAP'`)).toBe(1)
    expect(await value(`select count(*)::int v from provider_service_offers where id = $1`, O.stray)).toBe(1)
  })

  it('an order on an offer of a retired provider is refused by the database, nothing is charged or reserved', async () => {
    const [wallet, reserved] = [await value(`select balance::float8 v from wallets where user_id = $1`, user), await value(`select provider_balance::float8 v from providers where id = $1`, P.center)]
    // the stray offer is ACTIVE: place_order alone would have accepted it
    expect(await err(place(S.stray, P.center, O.stray, S.strayCenterPs, 'stray-1'))).toMatch(/provider offer not found, inactive or not valid for this service/)
    expect(await value(`select balance::float8 v from wallets where user_id = $1`, user)).toBe(wallet)
    expect(await value(`select provider_balance::float8 v from providers where id = $1`, P.center)).toBe(reserved)
    expect(await value(`select count(*)::int v from orders where service_id = $1`, S.stray)).toBe(0)
    expect(await value(`select ledger_drift_count() v`)).toBe(0)
  })

  it('the same card still takes an order through its working offer', async () => {
    const o = (await place(S.stray, P.jap, O.japOnStray, S.strayJap, 'ok-1', 1.5)).rows[0]
    expect(o.status).toBe('paid')
  })

  it('a waiting order cannot be moved onto an offer of a provider that is off either (the hub moves orders this way)', async () => {
    const o = (await place(S.stray, P.jap, O.japOnStray, S.strayJap, 'ok-2', 1.5)).rows[0]
    await db.query(`update orders set awaiting_funds_since = now() where id = $1`, [o.id]) // waiting for its provider's funds
    const move = (offerId: string) => db.transaction(async (tx) => {
      await tx.query(`select set_config('app.order_hub', 'reroute', true)`) // what hub_reroute_order sets: the only way an order's offer may change
      await tx.query(`update orders set provider_offer_id = $2 where id = $1`, [o.id, offerId])
    })
    expect(await err(move(O.stray))).toMatch(/provider offer not found, inactive or not valid for this service/)
    expect(await value(`select provider_offer_id::text v from orders where id = $1`, o.id)).toBe(O.japOnStray)
    // an update that does not change the offer is not a move
    await db.query(`update orders set provider_offer_id = provider_offer_id where id = $1`, [o.id])
  })

  it('the guard is not callable by clients, and re-running the migration changes nothing', async () => {
    expect(await value(`select has_function_privilege('anon', 'public.guard_order_provider()', 'execute') v`)).toBe(false)
    expect(await value(`select has_function_privilege('authenticated', 'public.guard_order_provider()', 'execute') v`)).toBe(false)
    await expect(db.exec(fs.readFileSync(path.join(dir, CLEANUP), 'utf8'))).rejects.toThrow(/already exists/) // the triggers: a migration runs once
  })
})
