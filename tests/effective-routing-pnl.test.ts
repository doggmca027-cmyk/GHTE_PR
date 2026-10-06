import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { analyticsFromRpc, computeProfitAnalytics } from '../supabase/functions/_shared/admin-analytics.ts'
import { ROUTING_MODE, buildCandidates, effectiveCost, rankOffers, selectBestOffer, type OfferRow } from '../supabase/functions/_shared/routing.ts'
import type { IProvider, IProviderServiceOffer } from '../supabase/functions/_shared/types.ts'

// ---------------------------------------------------------------------------
// Effective provider cost (pure)
// ---------------------------------------------------------------------------

const provider = (id: string, over: Partial<IProvider> = {}): IProvider => ({
  id, name: id, apiUrl: `https://${id}`, apiVersion: 'v2', isActive: true, routingEnabled: true, healthStatus: 'healthy',
  lastHealthCheck: null, lastBalanceSync: null, providerBalance: 0, currency: 'USD', priority: 0, ...over,
})
const offer = (id: string, providerId: string, over: Partial<IProviderServiceOffer> = {}): IProviderServiceOffer => ({
  id, serviceId: 's1', providerId, providerServiceId: `ps-${id}`, costPer1000: 1, minQuantity: 10, maxQuantity: 10_000,
  refillSupported: false, cancelSupported: false, isActive: true, routingScore: 0, createdAt: 't', updatedAt: 't', ...over,
})

describe('effective provider cost routing', () => {
  it('runs in EFFECTIVE_COST mode', () => expect(ROUTING_MODE).toBe('EFFECTIVE_COST'))

  it('effective cost = base cost x reliability penalty', () => {
    expect(effectiveCost({ costPer1000: 1 }, { reliabilityPenalty: 1.3 })).toBeCloseTo(1.3, 10)
    expect(effectiveCost({ costPer1000: 2.5 }, { reliabilityPenalty: 1 })).toBe(2.5)
    expect(effectiveCost({ costPer1000: 2.5 }, {})).toBe(2.5) // no penalty set = fully reliable
    expect(effectiveCost({ costPer1000: 2.5 })).toBe(2.5)
  })

  it('REQUIRED: a cheap provider with a high penalty loses to a slightly more expensive reliable one', () => {
    // cheap: 1.00 x 1.30 = 1.30 effective; reliable: 1.10 x 1.00 = 1.10 effective
    const best = selectBestOffer(
      [offer('cheap-flaky', 'flaky', { costPer1000: 1.0 }), offer('reliable', 'solid', { costPer1000: 1.1 })],
      [provider('flaky', { reliabilityPenalty: 1.3 }), provider('solid', { reliabilityPenalty: 1 })],
    )
    expect(best.id).toBe('reliable')
  })

  it('a small penalty does not outweigh a big price difference', () => {
    // 1.00 x 1.05 = 1.05 still beats 1.50
    const best = selectBestOffer([offer('a', 'pa', { costPer1000: 1.0 }), offer('b', 'pb', { costPer1000: 1.5 })], [provider('pa', { reliabilityPenalty: 1.05 }), provider('pb')])
    expect(best.id).toBe('a')
  })

  it('ranks the whole list by effective cost: the failover order follows reliability too', () => {
    const ranked = rankOffers(
      [offer('x', 'px', { costPer1000: 1.0 }), offer('y', 'py', { costPer1000: 1.2 }), offer('z', 'pz', { costPer1000: 0.9 })],
      [provider('px', { reliabilityPenalty: 1 }), provider('py', { reliabilityPenalty: 1 }), provider('pz', { reliabilityPenalty: 2 })],
    )
    expect(ranked.map((o) => o.id)).toEqual(['x', 'y', 'z']) // z: 0.9 x 2 = 1.8
  })

  it('equal effective cost: the routing score breaks the tie, then the offer id', () => {
    // 1.0 x 1.2 = 1.2 and 1.2 x 1.0 = 1.2 (float noise must not decide)
    const tie = [offer('a', 'pa', { costPer1000: 1.0, routingScore: 1 }), offer('b', 'pb', { costPer1000: 1.2, routingScore: 9 })]
    expect(selectBestOffer(tie, [provider('pa', { reliabilityPenalty: 1.2 }), provider('pb')]).id).toBe('b')
    const full = [offer('d', 'pd'), offer('c', 'pc')]
    expect(selectBestOffer(full, [provider('pd'), provider('pc')]).id).toBe('c')
  })

  it('a nonsensical penalty (below 1, NaN) is treated as 1, never as a discount', () => {
    const best = selectBestOffer([offer('a', 'pa', { costPer1000: 1.0 }), offer('b', 'pb', { costPer1000: 0.9 })], [provider('pa', { reliabilityPenalty: 0.1 }), provider('pb', { reliabilityPenalty: Number.NaN })])
    expect(best.id).toBe('b')
  })

  it('health still comes first: an unhealthy provider is out whatever its effective cost', () => {
    const best = selectBestOffer([offer('a', 'pa', { costPer1000: 0.01 }), offer('b', 'pb', { costPer1000: 5 })], [provider('pa', { healthStatus: 'unavailable' }), provider('pb', { reliabilityPenalty: 10 })])
    expect(best.id).toBe('b')
  })

  it('buildCandidates reads the penalty from the database row (missing = 1)', () => {
    const row = (id: string, penalty: number | string | undefined): OfferRow => ({
      id, service_id: 's1', provider_id: `p-${id}`, provider_service_id: `ps-${id}`, cost_per_1000: '1.0000', min_quantity: 1, max_quantity: 100,
      refill_supported: false, cancel_supported: false, is_active: true, routing_score: 0, created_at: 't', updated_at: 't',
      provider_service: { external_service_id: '1', is_active: true },
      provider: { id: `p-${id}`, name: id, api_url: 'u', api_key_encrypted: null, api_version: 'v2', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: null, last_balance_sync: null, provider_balance: 0, currency: 'USD', priority: 0, reliability_penalty_multiplier: penalty },
    })
    const c = buildCandidates([row('a', '1.500'), row('b', undefined)])
    expect(c.providers.map((p) => p.reliabilityPenalty)).toEqual([1.5, 1])
  })
})

// ---------------------------------------------------------------------------
// Real SQL: provider config, pricing grid, snapshots, P&L
// ---------------------------------------------------------------------------

const A = '00000000-0000-0000-0000-0000000000a2'
const B = '00000000-0000-0000-0000-0000000000b2'
const PS_A = '00000000-0000-0000-0000-000000000a01'
const PS_B = '00000000-0000-0000-0000-000000000b01'
const OFFER_A = '00000000-0000-0000-0000-00000000aa01'
const OFFER_B = '00000000-0000-0000-0000-00000000bb01'
const SVC = '00000000-0000-0000-0000-0000000000f1'

async function world() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  // A is cheap (1.00), B a bit dearer (1.10). Both healthy.
  await db.exec(`
    insert into providers(id, name, api_url, routing_enabled, health_status) values
      ('${A}', 'Cheap', 'https://a', true, 'healthy'), ('${B}', 'Solid', 'https://b', true, 'healthy');
    insert into categories(platform, name, slug) values ('telegram', 'Views', 'views');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
      ('${PS_A}', '${A}', '1', 'A', 1.0, 100, 100000), ('${PS_B}', '${B}', '9', 'B', 1.1, 100, 100000);
    insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      select '${SVC}', id, 'Views', '${PS_A}', 4.0, 100, 100000 from categories;
    delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
      ('${OFFER_A}', '${SVC}', '${A}', '${PS_A}', 1.0, 100, 100000, 100),
      ('${OFFER_B}', '${SVC}', '${B}', '${PS_B}', 1.1, 100, 100000, 0);`)
  return db
}

describe('Phase 2 (real SQL)', () => {
  let db: PGlite
  let admin: string
  const asAdmin = () => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${admin}',false)`)
  const one = async <T,>(sql: string, p: unknown[] = []) => (await db.query<{ r: T }>(sql, p)).rows[0].r
  beforeEach(async () => {
    db = await world()
    admin = (await db.query<{ id: string }>(`insert into users(telegram_id, is_admin) values (1, true) returning id`)).rows[0].id
  }, 120_000)

  /** Routes with the same data the Edge Function loads (offers + providers incl. the penalty). */
  async function route() {
    const rows = (await db.query<Record<string, unknown>>(`
      select o.*, row_to_json(ps.*) as ps, row_to_json(p.*) as p from provider_service_offers o
        join provider_services ps on ps.id = o.provider_service_id join providers p on p.id = o.provider_id where o.service_id = $1`, [SVC])).rows
    const offerRows = rows.map((r) => ({ ...r, provider_service: r.ps, provider: r.p }) as unknown as OfferRow)
    const c = buildCandidates(offerRows)
    return selectBestOffer(c.offers, c.providers, { quantity: 1000 })
  }

  it('the default penalty is 1 and the cheaper provider wins; a 1.3 penalty hands the order to the reliable one', async () => {
    expect((await db.query<{ m: string }>(`select reliability_penalty_multiplier::text m from providers where id = $1`, [A])).rows[0].m).toBe('1.000')
    expect((await route()).id).toBe(OFFER_A)
    await asAdmin()
    await db.query(`select admin_update_provider_config($1::uuid, null, null, null, 1.3)`, [A])
    await db.exec('reset role')
    expect((await route()).id).toBe(OFFER_B)
  })

  it('the admin pricing grid shows the offer routing would really pick, with its effective cost', async () => {
    await db.exec(`update providers set reliability_penalty_multiplier = 1.3 where id = '${A}'`)
    await asAdmin()
    const rows = await one<Record<string, unknown>[]>(`select get_admin_pricing_view() r`)
    await db.exec('reset role')
    expect(rows[0]).toMatchObject({ best_offer_cost: 1.1, best_offer_effective_cost: 1.1, margin_absolute: 2.9 })
  })

  it('the penalty is admin-only, between 1 and 10, audited, and old 4-argument calls still work', async () => {
    await asAdmin()
    await expect(db.query(`select admin_update_provider_config($1::uuid, null, null, null, 0.5)`, [A])).rejects.toThrow(/between 1 and 10/)
    await expect(db.query(`select admin_update_provider_config($1::uuid, null, null, null, 11)`, [A])).rejects.toThrow(/between 1 and 10/)
    const r = await one<Record<string, unknown>>(`select admin_update_provider_config($1::uuid, null, null, null, 2.5) r`, [A])
    expect(r.reliability_penalty_multiplier).toBe(2.5)
    await db.query(`select admin_update_provider_config($1::uuid, 20, 200, true)`, [B]) // 4 positional args, as before
    const list = await one<Record<string, unknown>[]>(`select admin_list_providers() r`)
    await db.exec('reset role')
    expect(list.find((p) => p.id === A)).toMatchObject({ reliability_penalty_multiplier: 2.5 })
    const audit = (await db.query<{ details: Record<string, unknown> }>(`select details from admin_audit_log where action = 'update_provider_config' and target_id = $1`, [A])).rows
    expect(audit[0].details.reliability_penalty_multiplier).toEqual([1, 2.5])
    await expect(db.exec(`update providers set reliability_penalty_multiplier = 0.9 where id = '${A}'`)).rejects.toThrow()
    const user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (2) returning id`)).rows[0].id
    await db.exec(`set role authenticated; select set_config('request.jwt.sub','${user}',false)`)
    await expect(db.query(`select admin_update_provider_config($1::uuid, null, null, null, 2)`, [A])).rejects.toThrow(/forbidden/)
    await db.exec('reset role')
  })

  it('snapshots are unchanged: an order records the REAL cost of its offer, never the effective cost', async () => {
    await db.exec(`update providers set reliability_penalty_multiplier = 3 where id = '${A}'`)
    const user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (3) returning id`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100,null,'fund','f')`, [user])
    const o = (await db.query<Record<string, unknown>>(
      `select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 1.0, 'k')`, [user, SVC, OFFER_A, A, PS_A])).rows[0]
    expect(o).toMatchObject({ cost_amount: '1.0000', charge_amount: '4.0000', profit_amount: '3.0000' })
  })

  describe('P&L breakdown', () => {
    let customer: string
    /** A paid order through valid transitions; returns its id. */
    async function paidOrder(qty: number, statuses: string[], key: string) {
      const o = (await db.query<{ id: string }>(
        `select id from place_order($1::uuid, $2::uuid, 'https://t.me/x', $3::int, $4::uuid, $5::uuid, $6::uuid, $7::numeric, $8)`,
        [customer, SVC, qty, OFFER_A, A, PS_A, qty / 1000, key])).rows[0]
      for (const s of statuses) await db.query(`update orders set status = $2 where id = $1`, [o.id, s])
      return o.id
    }

    beforeEach(async () => {
      customer = (await db.query<{ id: string }>(`insert into users(telegram_id) values (10) returning id`)).rows[0].id
      await db.query(`select process_wallet_transaction($1::uuid,'deposit',1000,null,'fund','fund-c')`, [customer])
      // completed: revenue 40, cost 10
      await paidOrder(10_000, ['processing', 'submitted', 'completed'], 'done')
      // partial: 2,500 of 10,000 undelivered -> refund 10, revenue 30, cost 7.5
      const part = await paidOrder(10_000, ['processing', 'submitted'], 'part')
      await db.query(`select apply_partial_refund($1::uuid, 2500)`, [part])
      // failed + full refund: revenue 0, cost 0, refund 8
      const failed = await paidOrder(2_000, ['failed'], 'fail')
      await db.query(`select refund_order($1::uuid, null, 'provider rejected')`, [failed])
      // treasury: deposit, a fee and a network fee
      await db.exec(`select process_treasury_transaction('deposit', 500);
                     select process_treasury_transaction('fee', -2);
                     select process_treasury_transaction('network_fee', -0.35);`)
    })

    const pnl = async () => {
      await asAdmin()
      const r = await one<Record<string, unknown>>(`select get_profit_analytics(null, null) r`)
      await db.exec('reset role')
      return r
    }

    it('separates revenue, provider cost, treasury fees, network fees and refunds', async () => {
      const r = await pnl()
      expect(r).toMatchObject({
        gross_revenue: 70, provider_cost: 17.5, gross_profit: 52.5,
        treasury_fees: 2, network_fees: 0.35, refund_cost: 18,
        net_profit: 50.15, // 70 - 17.5 - 2 - 0.35
      })
    })

    it('refunds are shown for transparency but never reduce revenue twice', async () => {
      const r = await pnl()
      // revenue already excludes the partial refund (40 + 30); refund_cost (10 + 8) is a separate line, not subtracted again
      expect(Number(r.gross_revenue) - Number(r.provider_cost) - Number(r.treasury_fees) - Number(r.network_fees)).toBeCloseTo(Number(r.net_profit), 4)
    })

    it('historical figures do not move: revenue, cost and gross profit use the same formulas as before', async () => {
      const r = await pnl()
      // the Phase 1I definitions, recomputed straight from the orders table
      const old = (await db.query<{ rev: string; cost: string }>(`
        select sum(case status when 'completed' then charge_amount when 'partial' then charge_amount - partial_refund_amount end)::text rev,
               sum(case status when 'completed' then cost_amount when 'partial' then round(cost_amount * (quantity - coalesce(remains, 0)) / quantity, 4) end)::text cost
          from orders where status <> 'draft'`)).rows[0]
      expect(Number(r.gross_revenue)).toBe(Number(old.rev))
      expect(Number(r.provider_cost)).toBe(Number(old.cost))
    })

    it('the TypeScript twin gives the same numbers when fed the same ledger rows', async () => {
      const sql = analyticsFromRpc(await pnl())
      const orders = (await db.query<Record<string, unknown>>(`select status, charge_amount::float8 charge_amount, cost_amount::float8 cost_amount, quantity, remains, partial_refund_amount::float8 partial_refund_amount, error_message, created_at::text from orders`)).rows
      const tx = (await db.query<{ type: string; amount: number; created_at: string }>(`select type::text, amount::float8 amount, created_at::text from treasury_transactions`)).rows
      const refunds = (await db.query<{ amount: number; order_created_at: string }>(`select wt.amount::float8 amount, o.created_at::text order_created_at from wallet_transactions wt join orders o on o.id = wt.reference_id where wt.type = 'refund'`)).rows
      const ts = computeProfitAnalytics(
        orders as never, tx.filter((t) => t.type === 'fee'), { start: null, end: null },
        { networkFees: tx.filter((t) => t.type === 'network_fee'), refunds },
      )
      expect({ ...ts, periodStart: null, periodEnd: null }).toEqual({ ...sql, periodStart: null, periodEnd: null })
    })

    it('a network fee must be a debit', async () => {
      await expect(db.query(`select process_treasury_transaction('network_fee', 1)`)).rejects.toThrow(/sign does not match/)
    })
  })
})
