import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import {
  ServiceUnavailableError,
  buildCandidates,
  costForQuantity,
  rankOffers,
  resolveOffer,
  selectBestOffer,
  type OfferRow,
} from '../supabase/functions/_shared/routing.ts'
import { mapDbError } from '../supabase/functions/_shared/place-order-flow.ts'
import type { HealthStatus, IProvider, IProviderServiceOffer } from '../supabase/functions/_shared/types.ts'

// ---------------------------------------------------------------------------
// selectBestOffer (pure)
// ---------------------------------------------------------------------------

const provider = (id: string, over: Partial<IProvider> = {}): IProvider => ({
  id, name: id, apiUrl: `https://${id}`, apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
  lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0, ...over,
})
const offer = (id: string, providerId: string, over: Partial<IProviderServiceOffer> = {}): IProviderServiceOffer => ({
  id, serviceId: 's1', providerId, providerServiceId: `ps-${id}`, costPer1000: 1, minQuantity: 10, maxQuantity: 10_000,
  refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: 't', updatedAt: 't', ...over,
})

describe('selectBestOffer', () => {
  it('picks the highest routing score', () => {
    const best = selectBestOffer([offer('a', 'pa', { routingScore: 10 }), offer('b', 'pb', { routingScore: 90 }), offer('c', 'pc', { routingScore: 50 })], [provider('pa'), provider('pb'), provider('pc')])
    expect(best.id).toBe('b')
  })

  it('on equal scores the cheapest cost wins', () => {
    const best = selectBestOffer([offer('a', 'pa', { routingScore: 5, costPer1000: 0.3 }), offer('b', 'pb', { routingScore: 5, costPer1000: 0.07 }), offer('c', 'pc', { routingScore: 5, costPer1000: 0.1 })], [provider('pa'), provider('pb'), provider('pc')])
    expect(best.id).toBe('b')
  })

  it('score beats price: a more expensive offer with a higher score wins', () => {
    const best = selectBestOffer([offer('cheap', 'pa', { routingScore: 1, costPer1000: 0.01 }), offer('pricey', 'pb', { routingScore: 2, costPer1000: 9 })], [provider('pa'), provider('pb')])
    expect(best.id).toBe('pricey')
  })

  it('ties on score and cost resolve deterministically (lowest id), whatever the input order', () => {
    const offers = [offer('b', 'pb'), offer('a', 'pa')]
    const providers = [provider('pa'), provider('pb')]
    expect(selectBestOffer(offers, providers).id).toBe('a')
    expect(selectBestOffer([...offers].reverse(), providers).id).toBe('a')
  })

  it.each<HealthStatus>(['degraded', 'unavailable', 'disabled'])('never routes to a %s provider, even when it has the best score and price', (status) => {
    const best = selectBestOffer(
      [offer('bad', 'pbad', { routingScore: 1000, costPer1000: 0.001 }), offer('good', 'pgood', { routingScore: 1, costPer1000: 5 })],
      [provider('pbad', { healthStatus: status }), provider('pgood')],
    )
    expect(best.id).toBe('good')
  })

  it('ignores inactive offers, providers with routing off and inactive providers', () => {
    const best = selectBestOffer(
      [offer('inactive-offer', 'p1', { isActive: false, routingScore: 99 }), offer('routing-off', 'p2', { routingScore: 98 }), offer('provider-off', 'p3', { routingScore: 97 }), offer('ok', 'p4')],
      [provider('p1'), provider('p2', { routingEnabled: false }), provider('p3', { isActive: false }), provider('p4')],
    )
    expect(best.id).toBe('ok')
  })

  it('ignores an offer whose provider is unknown (no provider row)', () => {
    expect(selectBestOffer([offer('orphan', 'ghost', { routingScore: 9 }), offer('ok', 'p1')], [provider('p1')]).id).toBe('ok')
  })

  it('throws ServiceUnavailableError when nothing qualifies', () => {
    expect(() => selectBestOffer([], [])).toThrow(ServiceUnavailableError)
    expect(() => selectBestOffer([offer('a', 'pa')], [provider('pa', { healthStatus: 'degraded' })])).toThrow(ServiceUnavailableError)
    expect(() => selectBestOffer([offer('a', 'pa', { isActive: false })], [provider('pa')])).toThrow(ServiceUnavailableError)
  })

  it('with a quantity, skips offers that cannot take it (outside the offer limits)', () => {
    const offers = [offer('big-only', 'pa', { routingScore: 9, minQuantity: 5000, maxQuantity: 100_000 }), offer('small', 'pb', { minQuantity: 10, maxQuantity: 1000 })]
    const providers = [provider('pa'), provider('pb')]
    expect(selectBestOffer(offers, providers, { quantity: 500 }).id).toBe('small')
    expect(selectBestOffer(offers, providers, { quantity: 6000 }).id).toBe('big-only')
    expect(() => selectBestOffer(offers, providers, { quantity: 2000 })).toThrow(ServiceUnavailableError)
    expect(selectBestOffer(offers, providers).id).toBe('big-only') // no quantity: not filtered
  })

  it('does not mutate its inputs and rankOffers returns the full ordering', () => {
    const offers = [offer('b', 'pb', { routingScore: 1 }), offer('a', 'pa', { routingScore: 2 })]
    const copy = structuredClone(offers)
    expect(rankOffers(offers, [provider('pa'), provider('pb')]).map((o) => o.id)).toEqual(['a', 'b'])
    expect(offers).toEqual(copy)
  })
})

describe('resolveOffer (replays stay with their provider)', () => {
  const offers = [offer('best', 'pa', { routingScore: 9 }), offer('old', 'pb')]
  it('a new order is routed', () => {
    expect(resolveOffer(offers, [provider('pa'), provider('pb')]).id).toBe('best')
  })
  it('a pinned offer is used even if its provider has since become unhealthy', () => {
    expect(resolveOffer(offers, [provider('pa'), provider('pb', { healthStatus: 'unavailable' })], { pinnedOfferId: 'old' }).id).toBe('old')
  })
  it('a pinned offer that is no longer usable is "unavailable", never re-routed to another provider', () => {
    expect(() => resolveOffer(offers, [provider('pa'), provider('pb')], { pinnedOfferId: 'gone' })).toThrow(ServiceUnavailableError)
  })
})

describe('costForQuantity mirrors place_order rounding', () => {
  it('round(cost * quantity / 1000, 4)', () => {
    expect(costForQuantity(0.07, 1000)).toBe(0.07)
    expect(costForQuantity(0.1234, 1500)).toBe(0.1851)
    expect(costForQuantity(1.8, 50)).toBe(0.09)
    expect(costForQuantity(0, 1000)).toBe(0)
  })
})

describe('buildCandidates', () => {
  const row = (over: Partial<OfferRow> = {}): OfferRow => ({
    id: 'o1', service_id: 's1', provider_id: 'p1', provider_service_id: 'ps1', cost_per_1000: '0.0700', min_quantity: 10, max_quantity: 100,
    refill_supported: true, cancel_supported: false, is_active: true, routing_score: 7, created_at: 't', updated_at: 't',
    provider_service: { external_service_id: '9001', is_active: true },
    provider: { id: 'p1', name: 'Panel', api_url: 'https://x', api_key_encrypted: 'SECRETBLOB', api_version: 'v2', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: null, last_balance_sync: null, provider_balance: '12.5', currency: 'USD', priority: 3 },
    ...over,
  })

  it('maps rows to domain objects (numbers parsed) and keeps credentials out of them', () => {
    const c = buildCandidates([row()])
    expect(c.offers[0]).toMatchObject({ id: 'o1', costPer1000: 0.07, routingScore: 7, providerServiceId: 'ps1' })
    expect(c.providers[0]).toMatchObject({ id: 'p1', routingEnabled: true, healthStatus: 'healthy', providerBalance: 12.5 })
    expect(JSON.stringify(c.providers)).not.toContain('SECRETBLOB')
    expect(c.details.get('o1')).toEqual({ externalServiceId: '9001', apiUrl: 'https://x', apiKeyEncrypted: 'SECRETBLOB', providerName: 'Panel' })
  })

  it('drops offers whose provider service was deactivated by a catalogue sync, and rows without joins', () => {
    const c = buildCandidates([row({ provider_service: { external_service_id: '1', is_active: false } }), row({ id: 'o2', provider: null }), row({ id: 'o3', provider_service: null })])
    expect(c.offers).toEqual([])
  })

  it('shares one provider object between several offers of the same provider', () => {
    const c = buildCandidates([row(), row({ id: 'o2', provider_service_id: 'ps2' })])
    expect(c.offers).toHaveLength(2)
    expect(c.providers).toHaveLength(1)
  })
})

describe('mapDbError for routing failures', () => {
  it('maps offer validation failures to a safe 503 "not charged" answer', () => {
    for (const m of ['provider offer not found, inactive or not valid for this service', 'quantity is outside the limits of the selected provider offer', 'cost does not match the selected provider offer'])
      expect(mapDbError(m)).toMatchObject({ httpStatus: 503, error: 'service_unavailable' })
  })
})

// ---------------------------------------------------------------------------
// The migration and the place_order function (PGlite)
// ---------------------------------------------------------------------------

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations')
const MIGRATION = '20261014000000_order_routing_snapshots.sql'
const files = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
const apply = async (db: PGlite, list: string[]) => {
  for (const f of list) await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
}
async function newDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  return db
}

type Row = Record<string, unknown>
const U = '00000000-0000-0000-0000-0000000000a1'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const OFFER_A = '00000000-0000-0000-0000-00000000aa01' // provider A, cost 0.1000, score 100
const OFFER_B = '00000000-0000-0000-0000-00000000bb01' // provider B, cost 0.0700, score 0
const PROV_A = '00000000-0000-0000-0000-0000000000a2'
const PROV_B = '00000000-0000-0000-0000-0000000000b2'
const PS_A = '00000000-0000-0000-0000-000000000a01'
const PS_B = '00000000-0000-0000-0000-000000000b01'

const SEED = `
  insert into providers(id, name, api_url) values ('${PROV_A}', 'A', 'https://a'), ('${PROV_B}', 'B', 'https://b');
  insert into categories(id, platform, name, slug) values ('00000000-0000-0000-0000-0000000000c1', 'telegram', 'Views', 'views');
  insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
    ('${PS_A}', '${PROV_A}', '1', 'A views', 0.1000, 100, 50000),
    ('${PS_B}', '${PROV_B}', '9', 'B views', 0.0700, 500, 20000);
  insert into services(id, category_id, name, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
    values ('${SVC}', '00000000-0000-0000-0000-0000000000c1', 'Views', '${PS_A}', '${PS_B}', 0.4000, 100, 50000);
  insert into users(id, telegram_id) values ('${U}', 42);`
const FUND = `select process_wallet_transaction('${U}'::uuid, 'deposit', 100, null, 'fund', 'fund-1')`

/** Fresh DB with everything applied, seeded after the migrations (so the 1B backfill has not seen the data). */
async function world() {
  const db = await newDb()
  await apply(db, files())
  await db.exec(SEED)
  // the bridge trigger already created offers for primary/fallback; replace them with fixed ids for readable assertions
  await db.exec(`delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
      ('${OFFER_A}', '${SVC}', '${PROV_A}', '${PS_A}', 0.1000, 100, 50000, 100),
      ('${OFFER_B}', '${SVC}', '${PROV_B}', '${PS_B}', 0.0700, 500, 20000, 0);`)
  await db.exec(FUND)
  return db
}
const place = (db: PGlite, o: { offer?: string; provider?: string; ps?: string; cost?: number | null; qty?: number; key?: string | null; url?: string; service?: string } = {}) =>
  db.query<Row>(
    `select * from place_order($1::uuid, $2::uuid, $3::text, $4::int, $5::uuid, $6::uuid, $7::uuid, $8::numeric, $9::text)`,
    [U, o.service ?? SVC, o.url ?? 'https://t.me/x', o.qty ?? 1000, o.offer ?? OFFER_A, o.provider ?? PROV_A, o.ps ?? PS_A, o.cost === undefined ? 0.1 : o.cost, o.key === undefined ? 'k-1' : o.key],
  )
const balance = async (db: PGlite) => Number((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = '${U}'`)).rows[0].b)

describe('migration 20261014: orders carry the routing snapshot', () => {
  it('is part of the history', () => expect(files()).toContain(MIGRATION))

  it('place_order snapshots offer, provider, cost, profit and score, and debits the charge', async () => {
    const db = await world()
    const o = (await place(db, { qty: 1000 })).rows[0]
    expect(o).toMatchObject({
      status: 'paid', provider_offer_id: OFFER_A, provider_id: PROV_A, routing_score_snapshot: 100,
      charge_amount: '0.4000', cost_amount: '0.1000', profit_amount: '0.3000',
    })
    expect(await balance(db)).toBe(99.6)
  }, 120_000)

  it('snapshots the OTHER offer when that one is chosen (no more reading services.primary_provider_service_id)', async () => {
    const db = await world()
    const o = (await place(db, { offer: OFFER_B, provider: PROV_B, ps: PS_B, cost: 0.07, qty: 1000 })).rows[0]
    expect(o).toMatchObject({ provider_offer_id: OFFER_B, provider_id: PROV_B, routing_score_snapshot: 0, cost_amount: '0.0700', profit_amount: '0.3300' })
  }, 120_000)

  it('a loss-making order is allowed and recorded as negative profit', async () => {
    const db = await world()
    await db.exec(`update provider_service_offers set cost_per_1000 = 0.9 where id = '${OFFER_A}'`)
    const o = (await place(db, { cost: 0.9 })).rows[0]
    expect(o).toMatchObject({ cost_amount: '0.9000', profit_amount: '-0.5000' })
  }, 120_000)

  it('rejects arguments that do not match the offer, charging nothing and creating no order', async () => {
    const db = await world()
    const bad: Array<[string, Parameters<typeof place>[1], RegExp]> = [
      ['unknown offer', { offer: '00000000-0000-0000-0000-000000000999' }, /provider offer not found/],
      ['offer of another provider', { provider: PROV_B }, /provider offer not found/],
      ['offer with another provider service', { ps: PS_B }, /provider offer not found/],
      ['cost not matching the offer', { cost: 0.01 }, /cost does not match/],
      ['negative cost', { cost: -1 }, /cost does not match/],
      ['null cost', { cost: null }, /cost does not match/],
      ['quantity below the offer minimum', { offer: OFFER_B, provider: PROV_B, ps: PS_B, cost: 0.0140, qty: 200 }, /outside the limits of the selected provider offer/],
    ]
    for (const [name, args, re] of bad) await expect(place(db, { key: `bad-${name}`, ...args }), name).rejects.toThrow(re)
    expect(await balance(db)).toBe(100)
    expect((await db.query(`select 1 from orders`)).rows).toHaveLength(0)
  }, 120_000)

  it('refuses an inactive offer and an offer that belongs to another service', async () => {
    const db = await world()
    await db.exec(`update provider_service_offers set is_active = false where id = '${OFFER_A}'`)
    await expect(place(db)).rejects.toThrow(/provider offer not found/)
    await db.exec(`
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1', 'Other', '${PS_A}', 1, 100, 50000)`)
    await expect(place(db, { offer: OFFER_B, provider: PROV_B, ps: PS_B, cost: 0.07, service: '00000000-0000-0000-0000-0000000000f2' })).rejects.toThrow(/provider offer not found/)
  }, 120_000)

  it('still enforces the service rules and funds, atomically (wallet locked FOR UPDATE)', async () => {
    const db = await world()
    await expect(place(db, { qty: 50, cost: 0.005 })).rejects.toThrow(/quantity must be between/)
    await expect(place(db, { qty: 500_000, cost: 50 })).rejects.toThrow(/quantity must be between/)
    await db.exec(`update services set customer_rate_per_1000 = 1000`) // charge 1000 > balance 100
    await expect(place(db, { key: 'poor' })).rejects.toThrow(/insufficient_funds/)
    expect(await balance(db)).toBe(100)
    expect((await db.query(`select 1 from orders`)).rows).toHaveLength(0) // the whole transaction rolled back
    expect(fs.readFileSync(path.join(MIGRATIONS, MIGRATION), 'utf8')).toMatch(/from wallets where user_id = p_user_id for update/)
  }, 120_000)

  it('is idempotent: a replay returns the original order and snapshot, even when routing now says otherwise', async () => {
    const db = await world()
    const first = (await place(db, { key: 'same' })).rows[0]
    const replay = (await place(db, { key: 'same', offer: OFFER_B, provider: PROV_B, ps: PS_B, cost: 0.07 })).rows[0]
    expect(replay.id).toBe(first.id)
    expect(replay).toMatchObject({ provider_offer_id: OFFER_A, provider_id: PROV_A })
    expect(await balance(db)).toBe(99.6) // charged once
    expect((await db.query(`select 1 from orders`)).rows).toHaveLength(1)
    await expect(place(db, { key: 'same', qty: 2000, cost: 0.2 })).rejects.toThrow(/different parameters/)
  }, 120_000)

  it('the snapshot is frozen after creation, like the other commercial terms', async () => {
    const db = await world()
    const id = (await place(db)).rows[0].id as string
    for (const set of [`provider_offer_id = '${OFFER_B}'`, `provider_offer_id = null`, `routing_score_snapshot = 5`, `profit_amount = 99`, `charge_amount = 1`])
      await expect(db.query(`update orders set ${set} where id = $1`, [id]), set).rejects.toThrow(/immutable after draft/)
    await db.query(`update orders set status = 'processing' where id = $1`, [id]) // normal lifecycle untouched
    await db.query(`update orders set status = 'submitted', provider_order_id = 'P-1' where id = $1`, [id])
  }, 120_000)

  it('later edits of an offer or of the services columns do not rewrite an existing order', async () => {
    const db = await world()
    const id = (await place(db)).rows[0].id as string
    await db.exec(`update provider_service_offers set cost_per_1000 = 5, routing_score = 1 where id = '${OFFER_A}'; update services set primary_provider_service_id = '${PS_B}', fallback_provider_service_id = null`)
    expect((await db.query<Row>(`select cost_amount::text c, routing_score_snapshot s, provider_offer_id from orders where id = $1`, [id])).rows[0]).toEqual({ c: '0.1000', s: 100, provider_offer_id: OFFER_A })
  }, 120_000)

  it('the old 5-argument place_order is gone and the new one is service_role only', async () => {
    const db = await world()
    const sigs = (await db.query<{ args: string }>(`select pg_get_function_identity_arguments(oid) args from pg_proc where proname = 'place_order'`)).rows
    expect(sigs).toHaveLength(1)
    expect(sigs[0].args).toMatch(/p_provider_offer_id uuid/)
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(`select has_function_privilege($1, p.oid, 'execute') ok from pg_proc p where proname = 'place_order'`, [role])
      expect(r.rows[0].ok, role).toBe(false)
    }
    const sr = await db.query<{ ok: boolean }>(`select has_function_privilege('service_role', p.oid, 'execute') ok from pg_proc p where proname = 'place_order'`)
    expect(sr.rows[0].ok).toBe(true)
  }, 120_000)
})

describe('migration 20261014: history is backfilled, not rewritten', () => {
  it('computes profit for old orders, links an offer only when unambiguous, and leaves updated_at alone', async () => {
    const db = await newDb()
    await apply(db, files().filter((f) => f < MIGRATION))
    await db.exec(SEED)
    await db.exec(`
      -- service has one offer for provider A and TWO offers for provider B (ambiguous)
      insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
        ('${OFFER_A}', '${SVC}', '${PROV_A}', '${PS_A}', 0.1, 100, 50000, 100),
        ('${OFFER_B}', '${SVC}', '${PROV_B}', '${PS_B}', 0.07, 500, 20000, 0);
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        values ('00000000-0000-0000-0000-000000000b02', '${PROV_B}', '10', 'B second', 0.08, 500, 20000);
      insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity)
        values ('${SVC}', '${PROV_B}', '00000000-0000-0000-0000-000000000b02', 0.08, 500, 20000);
      insert into orders(id, user_id, service_id, target_url, quantity, charge_amount, cost_amount, provider_id) values
        ('00000000-0000-0000-0000-0000000000d1', '${U}', '${SVC}', 'https://t.me/x', 1000, 0.4, 0.1, '${PROV_A}'),
        ('00000000-0000-0000-0000-0000000000d2', '${U}', '${SVC}', 'https://t.me/x', 1000, 0.4, 0.07, '${PROV_B}');`)
    const before = (await db.query<{ id: string; u: string }>(`select id, updated_at::text u from orders order by id`)).rows
    await apply(db, [MIGRATION])
    const rows = (await db.query<Row>(`select id, profit_amount::text profit, provider_offer_id, routing_score_snapshot score, updated_at::text u from orders order by id`)).rows
    expect(rows[0]).toMatchObject({ profit: '0.3000', provider_offer_id: OFFER_A, score: 100 })
    expect(rows[1]).toMatchObject({ profit: '0.3300', provider_offer_id: null, score: 0 }) // two offers for provider B: left unlinked
    expect(rows.map((r) => r.u)).toEqual(before.map((r) => r.u))
  }, 120_000)

  it('keeps the schema backward compatible: orders may have no offer (old rows), columns have defaults', async () => {
    const db = await newDb()
    await apply(db, files())
    await db.exec(SEED)
    await db.exec(`insert into orders(user_id, service_id, target_url, quantity, charge_amount) values ('${U}', '${SVC}', 'https://t.me/x', 100, 1)`)
    expect((await db.query<Row>(`select provider_offer_id, routing_score_snapshot, profit_amount::text p from orders`)).rows[0]).toEqual({ provider_offer_id: null, routing_score_snapshot: 0, p: '0.0000' })
  }, 120_000)

  it('an order keeps its offer from being deleted (restrict)', async () => {
    const db = await world()
    await place(db)
    await expect(db.exec(`delete from provider_service_offers where id = '${OFFER_A}'`)).rejects.toThrow(/foreign key|violates/i)
  }, 120_000)
})

describe('bridge triggers keep offers in step with the catalogue sync', () => {
  const O = (db: PGlite, where = '') => db.query<Row>(`select o.cost_per_1000::text cost, o.min_quantity, o.max_quantity, o.refill_supported refill, o.is_active, o.routing_score score, p.name prov from provider_service_offers o join providers p on p.id = o.provider_id ${where} order by o.routing_score desc`)

  it('a new service gets an offer for its primary (score 100) and fallback (score 0) provider service', async () => {
    const db = await newDb()
    await apply(db, files())
    await db.exec(SEED)
    expect((await O(db)).rows).toEqual([
      { cost: '0.1000', min_quantity: 100, max_quantity: 50000, refill: false, is_active: true, score: 100, prov: 'A' },
      { cost: '0.0700', min_quantity: 500, max_quantity: 20000, refill: false, is_active: true, score: 0, prov: 'B' },
    ])
  }, 120_000)

  it('changing a service\'s primary adds an offer, never touches or duplicates existing ones (operator edits survive)', async () => {
    const db = await newDb()
    await apply(db, files())
    await db.exec(SEED)
    await db.exec(`update provider_service_offers set routing_score = 42, is_active = false where provider_service_id = '${PS_A}'`)
    await db.exec(`update services set primary_provider_service_id = '${PS_B}', fallback_provider_service_id = '${PS_A}'`)
    const rows = (await db.query<Row>(`select provider_service_id, routing_score, is_active from provider_service_offers order by provider_service_id`)).rows
    expect(rows).toEqual([
      { provider_service_id: PS_A, routing_score: 42, is_active: false },
      { provider_service_id: PS_B, routing_score: 0, is_active: true },
    ])
  }, 120_000)

  it('a provider price / limit / flag change updates the offers built on that provider service', async () => {
    const db = await newDb()
    await apply(db, files())
    await db.exec(SEED)
    await db.exec(`update provider_service_offers set routing_score = 77, is_active = false where provider_service_id = '${PS_A}'`)
    await db.exec(`update provider_services set rate_per_1000 = 0.2500, min_quantity = 50, max_quantity = 9000, refill_supported = true where id = '${PS_A}'`)
    expect((await O(db, `where p.name = 'A'`)).rows[0]).toEqual({ cost: '0.2500', min_quantity: 50, max_quantity: 9000, refill: true, is_active: false, score: 77, prov: 'A' }) // operator fields untouched
    expect((await O(db, `where p.name = 'B'`)).rows[0]).toMatchObject({ cost: '0.0700' }) // other offers untouched
  }, 120_000)

  it('an unrelated provider_services update (name, last_synced_at) does not touch offers', async () => {
    const db = await newDb()
    await apply(db, files())
    await db.exec(SEED)
    const before = (await db.query<{ u: string }>(`select updated_at::text u from provider_service_offers order by id`)).rows
    await db.exec(`update provider_services set name = 'renamed', last_synced_at = now()`)
    expect((await db.query<{ u: string }>(`select updated_at::text u from provider_service_offers order by id`)).rows).toEqual(before)
  }, 120_000)

  it('end to end: a freshly synced service can be ordered through its auto-created offer', async () => {
    const db = await newDb()
    await apply(db, files())
    await db.exec(SEED)
    await db.exec(FUND)
    const o = (await db.query<{ id: string; provider_id: string; provider_service_id: string }>(`select id, provider_id, provider_service_id from provider_service_offers where provider_id = '${PROV_A}'`)).rows[0]
    const r = (await place(db, { offer: o.id, provider: o.provider_id, ps: o.provider_service_id })).rows[0]
    expect(r).toMatchObject({ status: 'paid', provider_offer_id: o.id, profit_amount: '0.3000' })
  }, 120_000)
})
