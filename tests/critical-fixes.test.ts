import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PRICE_CHANGE,
  detectCatalogAnomalies,
  diffProviderServices,
  withoutAnomalies,
  type ExistingProviderService,
} from '../supabase/functions/_shared/catalog-sync.ts'
import {
  IN_FLIGHT_NOTE,
  PlaceOrderDbError,
  PreSendRejection,
  executePlaceOrder,
  firstAcceptingOffer,
  isPreSendRejection,
  mapDbError,
  type OrderRecord,
  type PlaceOrderPorts,
} from '../supabase/functions/_shared/place-order-flow.ts'
import { SMMProviderError } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { IProviderService } from '../supabase/functions/_shared/types.ts'

const quiet = { warn() {}, error() {} }

// ---------------------------------------------------------------------------
// A real database: two providers (A, B), one service with one offer on each
// ---------------------------------------------------------------------------

const PROV_A = '00000000-0000-0000-0000-0000000000a2'
const PROV_B = '00000000-0000-0000-0000-0000000000b2'
const PS_A = '00000000-0000-0000-0000-000000000a01'
const PS_B = '00000000-0000-0000-0000-000000000b01'
const OFFER_A = '00000000-0000-0000-0000-00000000aa01'
const OFFER_B = '00000000-0000-0000-0000-00000000bb01'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const CAT = '00000000-0000-0000-0000-0000000000c1'

async function world() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  // Provider rate 1.00 per 1000 -> an order of 10,000 costs the platform 10.00 at the provider.
  await db.exec(`
    insert into providers(id, name, api_url, routing_enabled, health_status) values
      ('${PROV_A}', 'A', 'https://a', true, 'healthy'), ('${PROV_B}', 'B', 'https://b', true, 'healthy');
    insert into categories(id, platform, name, slug) values ('${CAT}', 'telegram', 'Views', 'views');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
      ('${PS_A}', '${PROV_A}', '1', 'A views', 1.0, 100, 100000),
      ('${PS_B}', '${PROV_B}', '9', 'B views', 1.0, 100, 100000);
    insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      values ('${SVC}', '${CAT}', 'Views', '${PS_A}', 4.0, 100, 100000);
    delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
      ('${OFFER_A}', '${SVC}', '${PROV_A}', '${PS_A}', 1.0, 100, 100000, 100),
      ('${OFFER_B}', '${SVC}', '${PROV_B}', '${PS_B}', 1.0, 100, 100000, 0);`)
  return db
}

const offerArgs = { A: { offer: OFFER_A, provider: PROV_A, ps: PS_A, external: '1' }, B: { offer: OFFER_B, provider: PROV_B, ps: PS_B, external: '9' } }
type Which = keyof typeof offerArgs

async function newUser(db: PGlite, tg: number, funds = 1000) {
  const { id } = (await db.query<{ id: string }>(`insert into users(telegram_id) values ($1) returning id`, [tg])).rows[0]
  if (funds > 0) await db.query(`select process_wallet_transaction($1::uuid,'deposit',$2::numeric,null,'fund','fund-'||$1::text)`, [id, funds])
  return id
}
const setBalance = (db: PGlite, provider: string, amount: number | null) =>
  db.query(`update providers set provider_balance = $2, last_balance_sync = case when $3 then now() else null end where id = $1`, [provider, amount ?? 0, amount !== null])
const providerBalance = async (db: PGlite, provider: string) => Number((await db.query<{ b: string }>(`select provider_balance::text b from providers where id = $1`, [provider])).rows[0].b)
const walletBalance = async (db: PGlite, user: string) => Number((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [user])).rows[0].b)
const placeSql = (db: PGlite, user: string, which: Which, key: string, qty = 10_000) =>
  db.query<Record<string, unknown>>(
    `select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', $3::int, $4::uuid, $5::uuid, $6::uuid, $7::numeric, $8::text)`,
    [user, SVC, qty, offerArgs[which].offer, offerArgs[which].provider, offerArgs[which].ps, qty / 1000, key],
  )

/** The place-order ports, wired to the real database (what the Edge Function does with supabase-js). */
function portsFor(db: PGlite): PlaceOrderPorts {
  const row = (r: { rows: Record<string, unknown>[] }) => r.rows[0] as unknown as OrderRecord
  return {
    async placeOrder(a) {
      try {
        return row(await db.query(
          `select * from place_order($1::uuid, $2::uuid, $3::text, $4::int, $5::uuid, $6::uuid, $7::uuid, $8::numeric, $9::text)`,
          [a.userId, a.serviceId, a.targetUrl, a.quantity, a.providerOfferId, a.providerId, a.providerServiceId, a.costAmount, a.idempotencyKey]))
      } catch (e) {
        throw new PlaceOrderDbError(e instanceof Error ? e.message : String(e))
      }
    },
    async claim(id) {
      const r = await db.query(`update orders set status = 'processing', error_message = $2 where id = $1 and status = 'paid' returning *`, [id, IN_FLIGHT_NOTE])
      return (r.rows[0] as unknown as OrderRecord) ?? null
    },
    async get(id) { return row(await db.query(`select * from orders where id = $1`, [id])) },
    async update(id, p) {
      return row(await db.query(
        `update orders set status = $2, provider_order_id = coalesce($3, provider_order_id), error_message = $4 where id = $1 returning *`,
        [id, p.status, p.provider_order_id ?? null, p.error_message ?? null]))
    },
    async refund(id, comment) { return row(await db.query(`select * from refund_order($1::uuid, null, $2)`, [id, comment])) },
    async releaseReservation(id) { await db.query(`select release_provider_reservation($1::uuid)`, [id]) },
  }
}

/** A fake provider panel: records every createOrder it receives. */
function panel(behaviour: () => Promise<{ orderId: string }>) {
  const calls: unknown[] = []
  return { calls, adapter: { createOrder: async (p: unknown) => { calls.push(p); return behaviour() } } }
}

const request = (user: string, which: Which, key: string) => ({
  userId: user, serviceId: SVC, targetUrl: 'https://t.me/x', quantity: 10_000, idempotencyKey: key,
  providerOfferId: offerArgs[which].offer, providerId: offerArgs[which].provider, providerServiceId: offerArgs[which].ps,
  costAmount: 10, externalServiceId: offerArgs[which].external,
})

// ---------------------------------------------------------------------------
// 1. Unknown outcome -> reconciliation, never failover or blind retry
// ---------------------------------------------------------------------------

describe('1. blind retry / dangerous failover', () => {
  let db: PGlite
  let user: string
  beforeEach(async () => {
    db = await world()
    user = await newUser(db, 1)
    await setBalance(db, PROV_A, 100)
    await setBalance(db, PROV_B, 100)
  }, 120_000)

  it('a network timeout after sending holds the order, opens a reconciliation case at once, and never tries provider B', async () => {
    const a = panel(async () => { throw new SMMProviderError('timeout', 'add: no response within 10000ms', { ambiguous: true }) })
    const b = panel(async () => ({ orderId: 'B-1' }))
    const result = await firstAcceptingOffer(['A', 'B'] as Which[], (w) =>
      executePlaceOrder(request(user, w, 'k-timeout'), portsFor(db), w === 'A' ? a.adapter : b.adapter, quiet))

    expect(result.kind).toBe('pending')
    expect(a.calls).toHaveLength(1) // sent once, not retried
    expect(b.calls).toHaveLength(0) // no failover after the request left
    const order = (await db.query<Record<string, unknown>>(`select * from orders where id = $1`, [result.order.id])).rows[0]
    expect(order).toMatchObject({ status: 'processing', provider_order_id: null })
    expect(String(order.error_message)).toMatch(/^needs_reconciliation: timeout/)
    // the case exists immediately, without waiting for the 10-minute grace
    const cases = (await db.query(`select * from reconciliation_cases where entity_id = $1 and status = 'open'`, [result.order.id])).rows
    expect(cases).toHaveLength(1)
    // the customer stays charged (outcome unknown) and the provider reservation stays (it may have been spent)
    expect(await walletBalance(db, user)).toBe(1000 - 40)
    expect(await providerBalance(db, PROV_A)).toBe(90)
  })

  it('a 5xx after sending is treated the same way (held, case opened, no failover)', async () => {
    const a = panel(async () => { throw new SMMProviderError('http', 'add: provider responded with HTTP 502', { ambiguous: true, httpStatus: 502 }) })
    const b = panel(async () => ({ orderId: 'B-1' }))
    const result = await firstAcceptingOffer(['A', 'B'] as Which[], (w) =>
      executePlaceOrder(request(user, w, 'k-5xx'), portsFor(db), w === 'A' ? a.adapter : b.adapter, quiet))
    expect(result.kind).toBe('pending')
    expect(b.calls).toHaveLength(0)
    expect((await db.query(`select 1 from reconciliation_cases where entity_id = $1 and status = 'open'`, [result.order.id])).rows).toHaveLength(1)
  })

  it('an order still in flight is NOT a case yet (only a returned, unknown outcome is)', async () => {
    const id = String((await placeSql(db, user, 'A', 'k-flight')).rows[0].id)
    await db.query(`update orders set status = 'processing', error_message = $2 where id = $1`, [id, IN_FLIGHT_NOTE])
    expect((await db.query(`select 1 from reconciliation_cases where entity_id = $1`, [id])).rows).toHaveLength(0)
  })

  it('a clean validation rejection refunds the customer and gives the provider reservation back', async () => {
    const a = panel(async () => { throw new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link', httpStatus: 400 }) })
    const result = await executePlaceOrder(request(user, 'A', 'k-400'), portsFor(db), a.adapter, quiet)
    expect(result.kind).toBe('rejected')
    expect(await walletBalance(db, user)).toBe(1000)
    expect(await providerBalance(db, PROV_A)).toBe(100)
    expect((await db.query<{ r: string }>(`select provider_reservation::text r from orders where id = $1`, [result.order.id])).rows[0].r).toBe('0.0000')
    expect((await db.query(`select 1 from reconciliation_cases where entity_id = $1`, [result.order.id])).rows).toHaveLength(0)
  })

  it('failover happens only BEFORE sending: A cannot cover the cost, so B takes the order and A is never called', async () => {
    await setBalance(db, PROV_A, 5) // less than the 10.00 cost
    const a = panel(async () => ({ orderId: 'A-1' }))
    const b = panel(async () => ({ orderId: 'B-1' }))
    const result = await firstAcceptingOffer(['A', 'B'] as Which[], (w) =>
      executePlaceOrder(request(user, w, 'k-presend'), portsFor(db), w === 'A' ? a.adapter : b.adapter, quiet))
    expect(result.kind).toBe('submitted')
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(1)
    expect(await providerBalance(db, PROV_A)).toBe(5)
    expect(await providerBalance(db, PROV_B)).toBe(90)
    expect(await walletBalance(db, user)).toBe(960) // charged exactly once
    expect((await db.query(`select 1 from orders`)).rows).toHaveLength(1)
  })

  it('isPreSendRejection is true only for refusals that happened before sending', () => {
    expect(isPreSendRejection(new PreSendRejection('no key'))).toBe(true)
    expect(isPreSendRejection(new PlaceOrderDbError('insufficient_provider_balance: available 5, required 10'))).toBe(true)
    expect(isPreSendRejection(new PlaceOrderDbError('insufficient_funds: available 1, required 4'))).toBe(false)
    expect(isPreSendRejection(new SMMProviderError('timeout', 'x', { ambiguous: true }))).toBe(false)
    expect(isPreSendRejection(new Error('boom'))).toBe(false)
  })

  it('firstAcceptingOffer rethrows anything that is not a pre-send refusal, untouched', async () => {
    const tried: string[] = []
    await expect(firstAcceptingOffer(['A', 'B'], async (o) => { tried.push(o); throw new Error('database down') })).rejects.toThrow('database down')
    expect(tried).toEqual(['A'])
    await expect(firstAcceptingOffer(['A', 'B'], async () => { throw new PreSendRejection('no key') })).rejects.toBeInstanceOf(PreSendRejection)
  })

  it('the customer sees a clean "not charged" message when no provider can cover the cost', () => {
    expect(mapDbError('insufficient_provider_balance: available 5.0000, required 10.0000')).toMatchObject({ httpStatus: 503, error: 'service_unavailable' })
  })
})

// ---------------------------------------------------------------------------
// 2. Atomic provider balance reservation
// ---------------------------------------------------------------------------

describe('2. provider balance reservation', () => {
  let db: PGlite
  beforeEach(async () => { db = await world() }, 120_000)

  it('RACE: 5 concurrent orders on a provider with funds for 2 -> exactly 2 succeed, balance never negative, losers not charged', async () => {
    await setBalance(db, PROV_A, 25) // 2 x 10.00 fit, a third does not
    const users = await Promise.all([1, 2, 3, 4, 5].map((tg) => newUser(db, 100 + tg)))
    const results = await Promise.allSettled(users.map((u, i) => placeSql(db, u, 'A', `race-${i}`)))
    const ok = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(2)
    expect(refused).toHaveLength(3)
    for (const r of refused) expect(String(r.reason)).toMatch(/insufficient_provider_balance/)
    expect(await providerBalance(db, PROV_A)).toBe(5)
    const charged = (await Promise.all(users.map((u) => walletBalance(db, u)))).filter((b) => b < 1000)
    expect(charged).toHaveLength(2) // the three refused customers were not charged (their transactions rolled back)
    expect((await db.query(`select 1 from orders`)).rows).toHaveLength(2)
  })

  it('RACE: one customer double-submitting different orders cannot overspend the provider either', async () => {
    await setBalance(db, PROV_A, 15)
    const u = await newUser(db, 7)
    const results = await Promise.allSettled([placeSql(db, u, 'A', 'x-1'), placeSql(db, u, 'A', 'x-2'), placeSql(db, u, 'A', 'x-3')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await providerBalance(db, PROV_A)).toBe(5)
  })

  it('records the reservation on the order; a replay of the same request reserves nothing more', async () => {
    await setBalance(db, PROV_A, 50)
    const u = await newUser(db, 8)
    const first = (await placeSql(db, u, 'A', 'same')).rows[0]
    const again = (await placeSql(db, u, 'A', 'same')).rows[0]
    expect(again.id).toBe(first.id)
    expect(first.provider_reservation).toBe('10.0000')
    expect(await providerBalance(db, PROV_A)).toBe(40)
  })

  it('an exact fit is allowed (balance reaches 0, never below)', async () => {
    await setBalance(db, PROV_A, 10)
    await placeSql(db, await newUser(db, 9), 'A', 'fit')
    expect(await providerBalance(db, PROV_A)).toBe(0)
    await expect(placeSql(db, await newUser(db, 10), 'A', 'over')).rejects.toThrow(/insufficient_provider_balance: available 0.0000, required 10.0000/)
  })

  it('a provider whose balance was never synced is not blocked (nothing to reserve against)', async () => {
    await setBalance(db, PROV_A, null)
    const row = (await placeSql(db, await newUser(db, 11), 'A', 'unknown')).rows[0]
    expect(row.provider_reservation).toBe('0.0000')
    expect(row.status).toBe('paid')
  })

  it('release gives the reservation back once, and only for orders the provider never took', async () => {
    await setBalance(db, PROV_A, 50)
    const u = await newUser(db, 12)
    const id = String((await placeSql(db, u, 'A', 'rel')).rows[0].id)
    // still paid / processing: the provider may hold it -> refused
    await expect(db.query(`select release_provider_reservation($1::uuid)`, [id])).rejects.toThrow(/cannot be released/)
    await db.query(`update orders set status = 'failed', error_message = 'provider_rejected: x' where id = $1`, [id])
    expect((await db.query<{ r: string }>(`select release_provider_reservation($1::uuid)::text r`, [id])).rows[0].r).toBe('10.0000')
    expect((await db.query<{ r: string }>(`select release_provider_reservation($1::uuid)::text r`, [id])).rows[0].r).toBe('0')
    expect(await providerBalance(db, PROV_A)).toBe(50)
  })

  it('release refuses an order that has a provider id (the provider has it)', async () => {
    await setBalance(db, PROV_A, 50)
    const id = String((await placeSql(db, await newUser(db, 13), 'A', 'pid')).rows[0].id)
    for (const s of ['processing', 'submitted']) await db.query(`update orders set status = $2 where id = $1`, [id, s])
    await db.query(`update orders set provider_order_id = 'P-1' where id = $1`, [id])
    await expect(db.query(`select release_provider_reservation($1::uuid)`, [id])).rejects.toThrow(/cannot be released/)
  })

  it('clients cannot call the release function', async () => {
    await db.exec(`set role authenticated`)
    await expect(db.query(`select release_provider_reservation(gen_random_uuid())`)).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
  })
})

// ---------------------------------------------------------------------------
// 3. Poisoned catalog protection
// ---------------------------------------------------------------------------

const existingPS = (over: Partial<ExistingProviderService> = {}): ExistingProviderService => ({
  id: PS_A, external_service_id: '1', name: 'A views', category_raw: 'Telegram Views', rate_per_1000: 1, min_quantity: 100, max_quantity: 100000,
  refill_supported: false, cancel_supported: false, is_active: true, ...over,
})
const incoming = (over: Partial<IProviderService> = {}): IProviderService => ({
  externalServiceId: '1', name: 'A views', type: 'Default', categoryRaw: 'Telegram Views', ratePer1000: 1, minQuantity: 100, maxQuantity: 100000,
  refillSupported: false, cancelSupported: false, ...over,
})

describe('3. catalog anomaly detection (pure)', () => {
  it('flags a 50% price increase and keeps what the provider reported', () => {
    const a = detectCatalogAnomalies([existingPS()], [incoming({ ratePer1000: 1.5 })], [])
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ externalServiceId: '1', providerServiceId: PS_A, observed: { rate: 1.5, min: 100, max: 100000 } })
    expect(a[0].reason).toMatch(/price up 50%/)
  })

  it('flags a large drop too, and lets moves inside the 30% band through', () => {
    expect(MAX_PRICE_CHANGE).toBe(0.3)
    expect(detectCatalogAnomalies([existingPS()], [incoming({ ratePer1000: 0.5 })], [])[0].reason).toMatch(/price down 50%/)
    expect(detectCatalogAnomalies([existingPS()], [incoming({ ratePer1000: 1.3 })], [])).toEqual([])
    expect(detectCatalogAnomalies([existingPS()], [incoming({ ratePer1000: 0.71 })], [])).toEqual([])
    expect(detectCatalogAnomalies([existingPS()], [incoming({ ratePer1000: 1.31 })], [])).toHaveLength(1)
  })

  it('flags a known service whose data became impossible; new services are not compared', () => {
    const a = detectCatalogAnomalies([existingPS()], [], [{ externalServiceId: '1', reason: 'invalid max' }])
    expect(a).toEqual([{ externalServiceId: '1', providerServiceId: PS_A, reason: 'provider reports invalid max', observed: null }])
    expect(detectCatalogAnomalies([], [incoming({ ratePer1000: 999 })], [{ externalServiceId: '2', reason: 'invalid rate' }])).toEqual([])
  })

  it('takes anomalies out of the write set, the re-pricing set AND the "missing" set', () => {
    const existing = [existingPS(), existingPS({ id: 'ps-2', external_service_id: '2', rate_per_1000: 2 })]
    const valid = [incoming({ ratePer1000: 1.5 }), incoming({ externalServiceId: '2', ratePer1000: 2.1 })]
    const diff = diffProviderServices(PROV_A, existing, valid, '2026-10-07T00:00:00Z')
    const anomalies = detectCatalogAnomalies(existing, valid, [])
    const out = withoutAnomalies(diff, valid, anomalies)
    expect(out.diff.rows.map((r) => r.external_service_id)).toEqual(['2'])
    expect(out.valid.map((s) => s.externalServiceId)).toEqual(['2'])
    expect(out.diff.missing).toEqual([])
  })
})

describe('3. catalog anomaly handling (real SQL)', () => {
  let db: PGlite
  let admin: string
  beforeEach(async () => {
    db = await world()
    admin = (await db.query<{ id: string }>(`insert into users(telegram_id, is_admin) values (99, true) returning id`)).rows[0].id
  }, 120_000)

  /** What sync-catalog does for one provider run: diff, hold back anomalies, write the rest, flag the anomalies. */
  async function syncRun(providerId: string, reported: IProviderService[]) {
    const existing = (await db.query<ExistingProviderService>(
      `select id, external_service_id, name, category_raw, rate_per_1000::float8 as rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported, is_active from provider_services where provider_id = $1`, [providerId])).rows
    const diff = diffProviderServices(providerId, existing, reported, new Date().toISOString())
    const anomalies = detectCatalogAnomalies(existing, reported, [])
    const kept = withoutAnomalies(diff, reported, anomalies)
    for (const r of kept.diff.rows) {
      await db.query(`update provider_services set rate_per_1000 = $3 where provider_id = $1 and external_service_id = $2`, [providerId, r.external_service_id, r.rate_per_1000])
    }
    for (const a of anomalies) await db.query(`select flag_catalog_anomaly($1::uuid, $2, $3::jsonb)`, [a.providerServiceId, a.reason, JSON.stringify(a.observed)])
    return anomalies
  }
  const offerA = async () => (await db.query<Record<string, unknown>>(`select is_active, cost_per_1000::text cost, anomaly_detected, anomaly_reason, anomaly_observed from provider_service_offers where id = $1`, [OFFER_A])).rows[0]

  it('a 50% price increase is NOT applied: the offer keeps its cost, is suspended and flagged', async () => {
    const anomalies = await syncRun(PROV_A, [incoming({ ratePer1000: 1.5 })])
    expect(anomalies).toHaveLength(1)
    expect((await db.query<{ r: string }>(`select rate_per_1000::text r from provider_services where id = $1`, [PS_A])).rows[0].r).toBe('1.0000')
    const o = await offerA()
    expect(o).toMatchObject({ is_active: false, cost: '1.0000', anomaly_detected: true })
    expect(String(o.anomaly_reason)).toMatch(/price up 50%/)
    expect(o.anomaly_observed).toEqual({ rate: 1.5, min: 100, max: 100000 })
    // the suspended offer can no longer take orders (routing skips it, place_order refuses it)
    await setBalance(db, PROV_A, 100)
    await expect(placeSql(db, await newUser(db, 50), 'A', 'after-flag')).rejects.toThrow(/provider offer not found, inactive/)
  })

  it('a normal price move (under 30%) is applied as before', async () => {
    expect(await syncRun(PROV_A, [incoming({ ratePer1000: 1.2 })])).toEqual([])
    expect(await offerA()).toMatchObject({ is_active: true, cost: '1.2000', anomaly_detected: false })
  })

  it('the next sync does not "learn" the bad price: it stays held back until an admin accepts it', async () => {
    await syncRun(PROV_A, [incoming({ ratePer1000: 1.5 })])
    await syncRun(PROV_A, [incoming({ ratePer1000: 1.5 })])
    expect(await offerA()).toMatchObject({ is_active: false, cost: '1.0000', anomaly_detected: true })
  })

  it('an admin can accept the observed values: applied to the provider service and its offers, flag cleared, audited', async () => {
    await syncRun(PROV_A, [incoming({ ratePer1000: 1.5 })])
    const r = (await db.query<{ r: Record<string, unknown> }>(`select accept_catalog_anomaly($1::uuid, $2::uuid) r`, [OFFER_A, admin])).rows[0].r
    expect(r).toMatchObject({ rate: 1.5 })
    expect(await offerA()).toMatchObject({ is_active: true, cost: '1.5000', anomaly_detected: false, anomaly_reason: null })
    expect((await db.query(`select 1 from admin_audit_log where action = 'accept_catalog_anomaly'`)).rows).toHaveLength(1)
    expect(await syncRun(PROV_A, [incoming({ ratePer1000: 1.5 })])).toEqual([]) // now the accepted price is the baseline
  })

  it('impossible data cannot be accepted, and only a live admin can accept', async () => {
    await db.query(`select flag_catalog_anomaly($1::uuid, 'provider reports invalid max', null)`, [PS_A])
    await expect(db.query(`select accept_catalog_anomaly($1::uuid, $2::uuid)`, [OFFER_A, admin])).rejects.toThrow(/not valid/)
    const user = await newUser(db, 51, 0)
    await expect(db.query(`select accept_catalog_anomaly($1::uuid, $2::uuid)`, [OFFER_A, user])).rejects.toThrow(/forbidden/)
  })

  it('clients cannot flag or accept anomalies', async () => {
    await db.exec(`set role authenticated`)
    await expect(db.query(`select flag_catalog_anomaly(gen_random_uuid(), 'x', null)`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select accept_catalog_anomaly(gen_random_uuid(), gen_random_uuid())`)).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
  })
})
