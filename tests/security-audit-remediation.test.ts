// Reproduction tests for the security audit (phases 0-5), written BEFORE the fixes (red) and kept as regression tests (green).
// One describe block per audit issue number. Database tests run on PGlite with Supabase's default grants emulated, so a forgotten
// REVOKE shows up here exactly as it would in production.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pagePricingRows } from '../supabase/functions/_shared/admin-pricing.ts'
import { verifyDeposit, type DepositRow } from '../supabase/functions/_shared/deposit-verify.ts'
import { readBoundedText, readJson } from '../supabase/functions/_shared/http.ts'
import { mockModeEnabled } from '../supabase/functions/_shared/mock-guard.ts'
import { syncProviderOrders, type OrderSyncAdapter, type OrderFieldsPatch, type SyncOrder, type SyncPorts } from '../supabase/functions/_shared/order-sync.ts'
import { SMMProviderError, SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { fetchRecentTransfers, memoizeTransferLoader, type ChainTransfer } from '../supabase/functions/_shared/ton.ts'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const quiet = { warn() {}, error() {} }

// ---------------------------------------------------------------------------
// A database with Supabase's default privileges, every migration applied
// ---------------------------------------------------------------------------

const PROV_A = '00000000-0000-0000-0000-0000000000a2'
const PROV_B = '00000000-0000-0000-0000-0000000000b2'
const PS_A = '00000000-0000-0000-0000-000000000a01'
const PS_B = '00000000-0000-0000-0000-000000000b01'
const OFFER_A = '00000000-0000-0000-0000-00000000aa01'
const OFFER_B = '00000000-0000-0000-0000-00000000bb01'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const CAT = '00000000-0000-0000-0000-0000000000c1'

async function world(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`)
  const dir = path.join(ROOT, 'supabase', 'migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  // Customer rate 1.05 per 1000. Offer A costs 1.00, offer B costs 1.04: a quote must not assume the cheaper one.
  await db.exec(`
    insert into providers(id, name, api_url, routing_enabled, health_status, provider_balance, last_balance_sync) values
      ('${PROV_A}', 'A', 'https://a.example', true, 'healthy', 100, now()), ('${PROV_B}', 'B', 'https://b.example', true, 'healthy', 100, now());
    insert into categories(id, platform_id, name, slug) values ('${CAT}', (select id from platforms where slug = 'telegram'), 'Views', 'views');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
      ('${PS_A}', '${PROV_A}', '1', 'A views', 1.0, 100, 100000),
      ('${PS_B}', '${PROV_B}', '9', 'B views', 1.04, 100, 100000);
    insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      values ('${SVC}', '${CAT}', 'Views', '${PS_A}', 1.05, 100, 100000);
    delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
      ('${OFFER_A}', '${SVC}', '${PROV_A}', '${PS_A}', 1.0, 100, 100000, 100),
      ('${OFFER_B}', '${SVC}', '${PROV_B}', '${PS_B}', 1.04, 100, 100000, 0);
    update platform_settings set discount_min_margin_per_1000 = 0.01;`)
  return db
}

let tgSeq = 5000
async function newUser(db: PGlite, funds = 1000, admin = false): Promise<string> {
  const { id } = (await db.query<{ id: string }>(`insert into users(telegram_id, is_admin) values ($1, $2) returning id`, [++tgSeq, admin])).rows[0]
  if (funds > 0) await db.query(`select process_wallet_transaction($1::uuid,'deposit',$2::numeric,null,'fund','fund-'||$1::text)`, [id, funds])
  return id
}
const actAs = (db: PGlite, user: string | null) => db.query(`select set_config('request.jwt.sub', $1, false)`, [user ?? ''])
const bal = async (db: PGlite, user: string) => Number((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [user])).rows[0].b)
const provBal = async (db: PGlite, p: string) => Number((await db.query<{ b: string }>(`select provider_balance::text b from providers where id = $1`, [p])).rows[0].b)
const place = async (db: PGlite, user: string, key: string, qty = 10_000) =>
  (await db.query<{ id: string; status: string }>(
    `select * from place_order($1::uuid, $2::uuid, 'https://t.me/x', $3::int, $4::uuid, $5::uuid, $6::uuid, $7::numeric, $8::text)`,
    [user, SVC, qty, OFFER_A, PROV_A, PS_A, (qty / 1000) * 1.0, key])).rows[0]
const sqlError = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { return e instanceof Error ? e.message : String(e) }
  return ''
}

let tonSeq = 0
async function newDeposit(db: PGlite, user: string, usd = 10, crypto = 2) {
  const memo = `dep_${(++tonSeq).toString(16).padStart(32, '0')}`
  return (await db.query<{ id: string }>(
    `insert into deposits (user_id, amount_usd, amount_crypto, rate_usd, memo, recipient_address, valid_until)
     values ($1, $2, $3, 5, $4, 'UQrecipient', now() + interval '30 minutes') returning id`, [user, usd, crypto, memo])).rows[0].id
}

// ---------------------------------------------------------------------------
// Issue #1 / #7: Toncenter pagination, bounded window, short cache
// ---------------------------------------------------------------------------

describe('#1 Toncenter pagination blindness', () => {
  const ACCOUNT = '0:' + 'ab'.repeat(32)
  const BASE = 1_700_000_000
  const tx = (i: number, comment: string | null = null) => ({
    hash: `hash-${i}`, now: BASE + 10_000 - i * 10, description: { aborted: false },
    in_msg: { source: '0:' + 'cd'.repeat(32), destination: ACCOUNT, value: '1000000000', bounce: false, bounced: false,
      message_content: { decoded: comment ? { type: 'text_comment', comment } : null } },
  })
  /** A Toncenter that honours start_utime / end_utime / limit / offset / sort=desc over `all` (newest first). */
  function toncenter(all: ReturnType<typeof tx>[]) {
    const urls: URL[] = []
    const fetchImpl = (async (input: URL | string) => {
      const u = new URL(String(input))
      urls.push(u)
      const start = Number(u.searchParams.get('start_utime') ?? 0)
      const end = u.searchParams.has('end_utime') ? Number(u.searchParams.get('end_utime')) : Infinity
      const limit = Number(u.searchParams.get('limit') ?? 10)
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const rows = all.filter((t) => t.now >= start && t.now <= end).slice(offset, offset + limit)
      return new Response(JSON.stringify({ transactions: rows }))
    }) as unknown as typeof fetch
    return { urls, fetchImpl }
  }

  it('finds a payment that sits on page 3 of the account history', async () => {
    const all = Array.from({ length: 250 }, (_, i) => tx(i, i === 230 ? 'dep_target' : null))
    const { fetchImpl, urls } = toncenter(all)
    const got = await fetchRecentTransfers({ baseUrl: 'https://toncenter.test', account: ACCOUNT, sinceUtime: BASE + 7_000, untilUtime: BASE + 10_100, fetchImpl })
    expect(got.map((t) => t.hash)).toContain('hash-230')
    expect(got).toHaveLength(250)
    expect(urls).toHaveLength(3) // 100 + 100 + 50: a short page ends the walk
    expect(urls.every((u) => u.searchParams.get('end_utime') === String(BASE + 10_100))).toBe(true)
  })

  it('never walks more pages than the cap', async () => {
    const all = Array.from({ length: 5_000 }, (_, i) => tx(i))
    const { fetchImpl, urls } = toncenter(all)
    await fetchRecentTransfers({ baseUrl: 'https://toncenter.test', account: ACCOUNT, sinceUtime: BASE, untilUtime: BASE + 20_000, fetchImpl, maxPages: 4 })
    expect(urls).toHaveLength(4)
  })

  it('#7 serves a repeated lookup from a short-lived cache, and never caches a failure', async () => {
    let calls = 0
    let clock = 1_000
    let fail = false
    const load = memoizeTransferLoader(async (): Promise<ChainTransfer[]> => {
      calls++
      if (fail) throw new Error('boom')
      return []
    }, 3_000, () => clock)
    await load(10, 20)
    await load(10, 20)
    expect(calls).toBe(1)
    await load(11, 20) // another window is another lookup
    expect(calls).toBe(2)
    clock += 3_001
    await load(10, 20)
    expect(calls).toBe(3)
    fail = true
    clock += 3_001
    await expect(load(10, 20)).rejects.toThrow('boom')
    fail = false
    await load(10, 20)
    expect(calls).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Issues #2, #3, #4, #5, #9, #10, #11, #13: the database
// ---------------------------------------------------------------------------

describe('database remediation', () => {
  let db: PGlite
  beforeAll(async () => { db = await world() }, 120_000)
  afterAll(async () => { await db.close() })

  describe('#2 an order stuck in `paid`', () => {
    it('is surfaced after the grace period, refunded after an hour, and the reservation is given back', async () => {
      const user = await newUser(db, 1000)
      const before = await bal(db, user)
      const reservedFrom = await provBal(db, PROV_A)
      const o = await place(db, user, 'stuck-1')
      expect(o.status).toBe('paid') // charged, and nobody ever called claim()
      expect(await provBal(db, PROV_A)).toBe(reservedFrom - 10)

      const fresh = await place(db, user, 'stuck-fresh')
      await db.query(`update orders set created_at = now() - interval '30 minutes' where id = $1`, [o.id])
      const held = (await db.query<{ h: boolean }>(`select order_needs_reconciliation(o) h from orders o where o.id = $1`, [o.id])).rows[0].h
      expect(held).toBe(true)
      expect((await db.query<{ h: boolean }>(`select order_needs_reconciliation(o) h from orders o where o.id = $1`, [fresh.id])).rows[0].h).toBe(false)

      // 30 minutes: visible, but nobody is refunded automatically yet
      const early = (await db.query<{ r: { refunded: number } }>(`select expire_stale_paid_orders() r`)).rows[0].r
      expect(early.refunded).toBe(0)

      await db.query(`update orders set created_at = now() - interval '2 hours' where id = $1`, [o.id])
      const late = (await db.query<{ r: { refunded: number } }>(`select expire_stale_paid_orders() r`)).rows[0].r
      expect(late.refunded).toBe(1)
      const row = (await db.query<{ status: string; provider_reservation: string }>(`select status, provider_reservation::text from orders where id = $1`, [o.id])).rows[0]
      expect(row.status).toBe('refunded')
      expect(Number(row.provider_reservation)).toBe(0)
      expect((await db.query<{ status: string }>(`select status from orders where id = $1`, [fresh.id])).rows[0].status).toBe('paid')
      expect(await bal(db, user)).toBe(before - 10.5) // only the fresh order is still charged
      await db.query(`select refund_order($1::uuid, null, 'cleanup')`, [fresh.id])
    })

    it('leaves an order that is waiting for provider funds alone', async () => {
      const user = await newUser(db, 1000)
      const o = await place(db, user, 'waiting-1')
      await db.query(`update orders set awaiting_funds_since = now() - interval '3 hours', created_at = now() - interval '3 hours' where id = $1`, [o.id])
      expect((await db.query<{ h: boolean }>(`select order_needs_reconciliation(o) h from orders o where o.id = $1`, [o.id])).rows[0].h).toBe(false)
      const r = (await db.query<{ r: { refunded: number } }>(`select expire_stale_paid_orders() r`)).rows[0].r
      expect(r.refunded).toBe(0)
      await db.query(`select refund_order($1::uuid, null, 'cleanup')`, [o.id])
    })
  })

  describe('#3 / #4 overpaid, underpaid and late deposits', () => {
    it('records what was received and opens an overpaid case; an exact payment opens none', async () => {
      const user = await newUser(db, 0)
      const exact = await newDeposit(db, user, 10, 2)
      await db.query(`select complete_deposit($1::uuid, 'tx-exact', null, 2000000000)`, [exact])
      const over = await newDeposit(db, user, 10, 2)
      await db.query(`select complete_deposit($1::uuid, 'tx-over', null, 4000000000)`, [over])

      const cols = (await db.query<{ id: string; received_amount_nano: string | null }>(`select id, received_amount_nano::text from deposits where id in ($1, $2)`, [exact, over])).rows
      expect(cols.find((c) => c.id === exact)?.received_amount_nano).toBe('2000000000')
      expect(cols.find((c) => c.id === over)?.received_amount_nano).toBe('4000000000')
      expect(await bal(db, user)).toBe(20) // the quote is credited, never more
      const cases = (await db.query<{ entity_id: string; reason: string }>(`select entity_id, reason from reconciliation_cases where entity_type = 'deposit' and status = 'open'`)).rows
      expect(cases.map((c) => c.entity_id)).toContain(over)
      expect(cases.find((c) => c.entity_id === over)?.reason).toMatch(/^overpaid/)
      expect(cases.map((c) => c.entity_id)).not.toContain(exact)
    })

    it('lets an admin credit an underpaid deposit once (idempotent by tx hash), pro rata, with an audit row', async () => {
      const admin = await newUser(db, 0, true)
      const user = await newUser(db, 0)
      const dep = await newDeposit(db, user, 10, 2)
      await db.query(`select flag_deposit_issue($1::uuid, 'underpaid: received 1 TON of 2')`, [dep])

      await actAs(db, user)
      expect(await sqlError(db.query(`select admin_resolve_deposit($1::uuid, 'credit', 'tx-late-1', 1000000000, 'x')`, [dep]))).toMatch(/forbidden/)
      await actAs(db, admin)
      const r = (await db.query<{ r: { credited: number; status: string } }>(`select admin_resolve_deposit($1::uuid, 'credit', 'tx-late-1', 1000000000, 'user paid half') r`, [dep])).rows[0].r
      expect(r.status).toBe('completed')
      expect(Number(r.credited)).toBe(5)
      expect(await bal(db, user)).toBe(5)

      const again = (await db.query<{ r: { credited: number } }>(`select admin_resolve_deposit($1::uuid, 'credit', 'tx-late-1', 1000000000, 'retry') r`, [dep])).rows[0].r
      expect(Number(again.credited)).toBe(0)
      expect(await bal(db, user)).toBe(5)

      const other = await newDeposit(db, user, 10, 2)
      expect(await sqlError(db.query(`select admin_resolve_deposit($1::uuid, 'credit', 'tx-late-1', 2000000000, 'reuse')`, [other]))).toMatch(/tx_already_used/)

      const caseRow = (await db.query<{ status: string; resolution: string }>(`select status, resolution from reconciliation_cases where entity_type = 'deposit' and entity_id = $1`, [dep])).rows[0]
      expect(caseRow).toMatchObject({ status: 'resolved', resolution: 'manual' })
      expect(Number((await db.query<{ n: string }>(`select count(*)::text n from admin_audit_log where action = 'resolve_deposit' and target_id = $1`, [dep])).rows[0].n)).toBeGreaterThanOrEqual(1)
      await actAs(db, null)
    })

    it('can also dismiss a case without crediting anything', async () => {
      const admin = await newUser(db, 0, true)
      const user = await newUser(db, 0)
      const dep = await newDeposit(db, user, 10, 2)
      await db.query(`select flag_deposit_issue($1::uuid, 'paid outside the validity window')`, [dep])
      await actAs(db, admin)
      await db.query(`select admin_resolve_deposit($1::uuid, 'dismiss', null, null, 'refunded off-chain')`, [dep])
      expect(await bal(db, user)).toBe(0)
      expect((await db.query<{ status: string }>(`select status from deposits where id = $1`, [dep])).rows[0].status).not.toBe('completed')
      await actAs(db, null)
    })
  })

  describe('#9 provider-supplied progress is bounded in the database', () => {
    it('refuses remains outside 0..quantity and a negative start count', async () => {
      const user = await newUser(db, 1000)
      const o = await place(db, user, 'bounds-1')
      await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
      await db.query(`update orders set status = 'submitted', provider_order_id = 'P-1' where id = $1`, [o.id])
      expect(await sqlError(db.query(`update orders set remains = 10001 where id = $1`, [o.id]))).toMatch(/orders_remains_bounds/)
      expect(await sqlError(db.query(`update orders set remains = -1 where id = $1`, [o.id]))).toMatch(/orders_remains_bounds/)
      expect(await sqlError(db.query(`update orders set start_count = -5 where id = $1`, [o.id]))).toMatch(/orders_start_count_nonneg/)
      await db.query(`update orders set remains = 10000, start_count = 0 where id = $1`, [o.id])
      await db.query(`update orders set status = 'failed' where id = $1`, [o.id])
      await db.query(`select refund_order($1::uuid, null, 'cleanup')`, [o.id])
    })
  })

  describe('#10 the provider reservation follows the order to its end', () => {
    async function submitted(user: string, key: string) {
      const o = await place(db, user, key)
      await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
      await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [o.id, `P-${key}`])
      return o.id
    }

    it('gives the whole reservation back when the provider cancels an order it had accepted', async () => {
      const user = await newUser(db, 1000)
      const start = await provBal(db, PROV_A)
      const id = await submitted(user, 'res-cancel')
      expect(await provBal(db, PROV_A)).toBe(start - 10)
      await db.query(`update orders set status = 'canceled' where id = $1`, [id])
      expect(await provBal(db, PROV_A)).toBe(start)
      expect(Number((await db.query<{ r: string }>(`select provider_reservation::text r from orders where id = $1`, [id])).rows[0].r)).toBe(0)
      await db.query(`select refund_order($1::uuid, null, 'cleanup')`, [id])
      expect(await provBal(db, PROV_A)).toBe(start) // and a second release changes nothing
    })

    it('gives back the share of a partial order that the provider did not deliver', async () => {
      const user = await newUser(db, 1000)
      const start = await provBal(db, PROV_A)
      const id = await submitted(user, 'res-partial')
      await db.query(`select apply_partial_refund($1::uuid, 2500, 0)`, [id])
      expect(await provBal(db, PROV_A)).toBeCloseTo(start - 7.5, 4)
      expect(Number((await db.query<{ r: string }>(`select provider_reservation::text r from orders where id = $1`, [id])).rows[0].r)).toBeCloseTo(7.5, 4)
    })
  })

  describe('#11 a quote never assumes a cheaper provider than the order can get', () => {
    it('prices the quote on the most expensive eligible offer', async () => {
      const user = await newUser(db, 0)
      const q = (await db.query<{ q: { provider_cost: number; final_price: number } }>(`select quote_order_price($1::uuid, $2::uuid, 10000, null) q`, [user, SVC])).rows[0].q
      expect(Number(q.provider_cost)).toBe(10.4)
      const worst = (await db.query<{ p: { final_price: number } }>(`select calculate_order_price($1::uuid, $2::uuid, 10000, 10.40, null) p`, [user, SVC])).rows[0].p
      const best = (await db.query<{ p: { final_price: number } }>(`select calculate_order_price($1::uuid, $2::uuid, 10000, 10.00, null) p`, [user, SVC])).rows[0].p
      expect(Number(q.final_price)).toBe(Number(worst.final_price))
      expect(Number(q.final_price)).toBeGreaterThanOrEqual(Number(best.final_price))
    })
  })

  describe('#13 banning', () => {
    it('is an audited admin action, never self-service, and a banned user can no longer open or answer tickets', async () => {
      const admin = await newUser(db, 0, true)
      const user = await newUser(db, 0)
      await actAs(db, user)
      expect(await sqlError(db.query(`select admin_set_user_ban($1::uuid, true, 'try')`, [user]))).toMatch(/forbidden/)
      await actAs(db, admin)
      expect(await sqlError(db.query(`select admin_set_user_ban($1::uuid, true, 'self')`, [admin]))).toMatch(/yourself|self/)
      await db.query(`select admin_set_user_ban($1::uuid, true, 'chargeback abuse')`, [user])
      expect((await db.query<{ b: boolean }>(`select is_banned b from users where id = $1`, [user])).rows[0].b).toBe(true)
      expect(Number((await db.query<{ n: string }>(`select count(*)::text n from admin_audit_log where action = 'ban_user' and target_id = $1`, [user])).rows[0].n)).toBe(1)

      expect(await sqlError(db.query(`select support_create_ticket($1::uuid, 'Hello there', 'Please help', null)`, [user]))).toMatch(/user_banned/)
      await db.query(`select admin_set_user_ban($1::uuid, false, 'appeal accepted')`, [user])
      await db.query(`select support_create_ticket($1::uuid, 'Hello there', 'Please help', null)`, [user])
      await actAs(db, null)
    })
  })
})

// ---------------------------------------------------------------------------
// Issue #5: the wallet is only writable through the ledger functions, and drift is detected
// ---------------------------------------------------------------------------

describe('#5 wallet privilege hardening and ledger drift', () => {
  let db: PGlite
  beforeAll(async () => { db = await world() }, 120_000)
  afterAll(async () => { await db.close() })

  it('service_role cannot UPDATE wallets directly, but the ledger functions still work for it', async () => {
    const user = await newUser(db, 100)
    await db.exec(`set role service_role`)
    try {
      expect(await sqlError(db.query(`update wallets set balance = 999 where user_id = $1`, [user]))).toMatch(/permission denied/)
      const r = await db.query<{ balance_after: string }>(`select balance_after::text from process_wallet_transaction($1::uuid, 'bonus', 5, null, 'ok', 'k-5-' || $1::text)`, [user])
      expect(Number(r.rows[0].balance_after)).toBe(105)
    } finally {
      await db.exec(`reset role`)
    }
  })

  it('reports a wallet whose balance no longer equals its ledger', async () => {
    const user = await newUser(db, 50)
    expect(Number((await db.query<{ n: string }>(`select ledger_drift_count()::text n`)).rows[0].n)).toBe(0)
    // what a privileged SQL session could do: raise the flag in its own transaction and move money without a ledger row
    await db.exec(`do $$ begin perform set_config('app.wallet_op','on',true); update wallets set balance = balance + 7 where user_id = '${user}'; end $$`)
    expect(Number((await db.query<{ n: string }>(`select ledger_drift_count()::text n`)).rows[0].n)).toBe(1)
    const health = (await db.query<{ h: { ledger: { drift_count: number } } }>(`select get_system_health(24) h`)).rows[0].h
    expect(Number(health.ledger.drift_count)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Issues #6, #14: provider HTTP is strict
// ---------------------------------------------------------------------------

describe('#6 / #14 the provider adapter', () => {
  const adapter = (impl: typeof fetch, extra: Record<string, unknown> = {}) =>
    new SMMv2Adapter({ id: 'p', name: 'Panel', apiUrl: 'https://panel.example/api/v2', apiKey: 'KEY-123456', fetchImpl: impl, ...extra })

  it('refuses to follow redirects (a 307 would carry the API key to another host)', async () => {
    let init: RequestInit | undefined
    const impl = (async (_u: string, i: RequestInit) => { init = i; return new Response(JSON.stringify({ balance: '5', currency: 'USD' })) }) as unknown as typeof fetch
    await adapter(impl).getBalance()
    expect(init?.redirect).toBe('error')
  })

  it('reads a bounded number of bytes, from the header and from the stream', async () => {
    const huge = (async () => new Response('x'.repeat(3_000_000))) as unknown as typeof fetch
    await expect(adapter(huge).getBalance()).rejects.toMatchObject({ kind: 'invalid_response', message: expect.stringMatching(/too large/i) })

    const declared = (async () => new Response('{}', { headers: { 'content-length': '999999999' } })) as unknown as typeof fetch
    await expect(adapter(declared).getBalance()).rejects.toMatchObject({ kind: 'invalid_response', message: expect.stringMatching(/too large/i) })
  })

  it('treats an oversized answer to an order as UNKNOWN (held), never as a rejection', async () => {
    const huge = (async () => new Response('x'.repeat(3_000_000))) as unknown as typeof fetch
    const e = await adapter(huge).createOrder({ serviceId: '1', link: 'https://t.me/x', quantity: 100 }).catch((x) => x)
    expect(e).toBeInstanceOf(SMMProviderError)
    expect((e as SMMProviderError).ambiguous).toBe(true)
  })

  it('lets the catalogue call be much larger than an ordinary answer', async () => {
    const row = { service: '1', name: 'Followers', type: 'Default', category: 'IG', rate: '1.5', min: 10, max: 1000, refill: false, cancel: false }
    const body = JSON.stringify(Array.from({ length: 30_000 }, () => row)) // ~2.7 MB
    expect(body.length).toBeGreaterThan(2_000_000)
    const impl = (async () => new Response(body)) as unknown as typeof fetch
    expect((await adapter(impl).getServices()).length).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// Issue #8: admin pricing search
// ---------------------------------------------------------------------------

describe('#8 admin pricing search', () => {
  it('splits the query on whitespace, so every word is matched as a word', () => {
    const rows = [
      { name: 'Instagram Views Fast', category: 'Views' },
      { name: 'Instagram Followers', category: 'Followers' },
      { name: 'TikTok Views', category: 'Views' },
    ]
    const q = { search: 'instagram views', platform: null, categoryId: null, offset: 0, limit: 50 }
    const out = pagePricingRows(rows, q)
    expect(out.total).toBe(1)
    expect(out.rows[0].name).toBe('Instagram Views Fast')
  })
})

// ---------------------------------------------------------------------------
// Issue #9: remains / start_count from a provider
// ---------------------------------------------------------------------------

describe('#9 the order sync does not trust progress numbers', () => {
  const order = (over: Partial<SyncOrder> = {}): SyncOrder => ({
    id: 'o1', user_id: 'u1', service_id: 's1', provider_order_id: 'P1', status: 'submitted', quantity: 1000, charge_amount: 5,
    remains: null, start_count: null, error_message: null, created_at: new Date(0).toISOString(), ...over,
  })
  const run = async (entry: { remains?: number; startCount?: number; status?: string }) => {
    const patches: OrderFieldsPatch[] = []
    const ports: SyncPorts = {
      async setProviderOrderId() {},
      async updateOrder(_id, patch) { patches.push(patch); return true },
      async applyPartialRefund() { return 0 },
      async refundOrder() {},
      async touch() {},
    }
    const adapter: OrderSyncAdapter = {
      async getOrdersStatus(ids) {
        return Object.fromEntries(ids.map((id) => [id, { ok: true as const, status: { orderId: id, rawStatus: 'In progress', status: entry.status ?? 'in_progress', currency: 'USD', ...entry } }])) as never
      },
    }
    await syncProviderOrders([order()], adapter, ports, {}, quiet)
    return patches
  }

  it.each([
    ['negative remains', { remains: -5 }],
    ['remains above the quantity', { remains: 5000 }],
    ['fractional remains', { remains: 12.5 }],
  ])('drops %s instead of writing it', async (_label, entry) => {
    const patches = await run(entry)
    expect(patches.every((p) => p.remains === undefined)).toBe(true)
  })

  it('drops a negative or fractional start count, and keeps good numbers', async () => {
    expect((await run({ startCount: -1 })).every((p) => p.start_count === undefined)).toBe(true)
    expect((await run({ startCount: 2.5 })).every((p) => p.start_count === undefined)).toBe(true)
    const ok = await run({ remains: 400, startCount: 10 })
    expect(ok.some((p) => p.remains === 400 && p.start_count === 10)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Issue #12: bounded body reading
// ---------------------------------------------------------------------------

describe('#12 request bodies are bounded while they are read', () => {
  const streamed = (chunks: number, onPull: () => void) =>
    new Request('http://localhost/fn', {
      method: 'POST', duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        pull(c) { onPull(); c.enqueue(new Uint8Array(1024).fill(97)); if (--chunks <= 0) c.close() },
      }),
    } as RequestInit)

  it('stops reading an oversized body long before it is all in memory', async () => {
    let pulled = 0
    const req = streamed(20_000, () => { pulled++ }) // 20 MB on offer
    expect(await readBoundedText(req, 4096)).toBeNull()
    expect(pulled).toBeLessThan(100)
  })

  it('readJson rejects an oversized body the same way and still parses a small one', async () => {
    let pulled = 0
    expect(await readJson(streamed(20_000, () => { pulled++ }), 4096)).toBeNull()
    expect(pulled).toBeLessThan(100)
    const ok = new Request('http://localhost/fn', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(await readJson(ok)).toEqual({ a: 1 })
  })

  it('refuses a body whose declared length is already too big, without reading it', async () => {
    const req = new Request('http://localhost/fn', { method: 'POST', body: 'x'.repeat(10_000), headers: { 'content-length': '10000' } })
    expect(await readBoundedText(req, 4096)).toBeNull()
  })

  it('is used by the unauthenticated entry points', () => {
    expect(read('supabase/functions/telegram-auth/index.ts')).not.toMatch(/req\.json\(\)/)
    expect(read('supabase/functions/telegram-auth/index.ts')).toMatch(/readBoundedText|readJson/)
    expect(read('supabase/functions/ad-webhook/index.ts')).not.toMatch(/req\.text\(\)/)
    expect(read('supabase/functions/ad-webhook/index.ts')).toMatch(/readBoundedText/)
    expect(read('supabase/functions/place-order/index.ts')).not.toMatch(/req\.text\(\)/)
  })
})

// ---------------------------------------------------------------------------
// Issue #13: a banned customer's payment is not credited
// ---------------------------------------------------------------------------

describe('#13 verify-deposit and banned customers', () => {
  const deposit: DepositRow = {
    id: 'd1', status: 'pending', memo: 'dep_' + 'a'.repeat(32), recipient_address: '0:' + 'ab'.repeat(32), amount_crypto: '2.000000000',
    asset: 'TON', network: 'mainnet', created_at: new Date(1_700_000_000_000).toISOString(), valid_until: new Date(1_700_001_800_000).toISOString(),
  }

  it('refuses before any chain lookup or credit', async () => {
    let looked = 0
    let credited = 0
    const out = await verifyDeposit(deposit, { network: 'mainnet', recipient: '0:' + 'ab'.repeat(32) }, {
      isBanned: async () => true,
      loadTransfers: async () => { looked++; return [] },
      completeDeposit: async () => { credited++ },
      flagIssue: async () => {},
    })
    expect(out).toMatchObject({ kind: 'rejected', httpStatus: 403, error: 'banned' })
    expect(looked + credited).toBe(0)
  })

  it('is wired in the Edge Function, and the ticket functions map the database refusal', () => {
    expect(read('supabase/functions/verify-deposit/index.ts')).toMatch(/is_banned/)
    expect(read('supabase/functions/_shared/tickets.ts')).toMatch(/user_banned/)
  })
})

// ---------------------------------------------------------------------------
// Issue #16, #19, #20
// ---------------------------------------------------------------------------

describe('#16 content security policy', () => {
  const csp = (): Record<string, string> => {
    const vercel = JSON.parse(read('vercel.json')) as { headers: { headers: { key: string; value: string }[] }[] }
    const value = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')?.value ?? ''
    return Object.fromEntries(value.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')]))
  }

  it('lists what may run and connect, keeps Telegram, TON Connect, Supabase and Google Fonts working', () => {
    const d = csp()
    expect(d['default-src']).toBe("'self'")
    expect(d['script-src']).toContain("'self'")
    expect(d['script-src']).toContain('https://telegram.org')
    expect(d['script-src']).not.toMatch(/unsafe-eval|unsafe-inline/)
    expect(d['connect-src']).toMatch(/\*\.supabase\.co/)
    expect(d['connect-src']).toMatch(/tonconnect|ton\.org|toncenter/)
    expect(d['style-src']).toContain('https://fonts.googleapis.com')
    expect(d['font-src']).toContain('https://fonts.gstatic.com')
    expect(d['img-src']).toMatch(/data:/)
    expect(d['frame-ancestors']).toMatch(/telegram\.org/)
    expect(d['object-src']).toBe("'none'")
    expect(d['form-action']).toBeDefined()
  })
})

describe('#19 mock mode never runs on a hosted project', () => {
  it('is on only when asked for AND not on a hosted Supabase project', () => {
    expect(mockModeEnabled({ get: (k) => ({ MOCK_MODE: 'true' } as Record<string, string>)[k] })).toBe(true)
    expect(mockModeEnabled({ get: (k) => ({ MOCK_MODE: 'true', SUPABASE_URL: 'http://127.0.0.1:54321' } as Record<string, string>)[k] })).toBe(true)
    expect(mockModeEnabled({ get: (k) => ({ MOCK_MODE: 'true', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' } as Record<string, string>)[k] })).toBe(false)
    expect(mockModeEnabled({ get: (k) => ({ MOCK_MODE: 'true', APP_ENV: 'production' } as Record<string, string>)[k] })).toBe(false)
    expect(mockModeEnabled({ get: () => undefined })).toBe(false)
    expect(mockModeEnabled({ get: (k) => ({ MOCK_MODE: 'yes' } as Record<string, string>)[k] })).toBe(false)
  })

  it('is the only place that reads MOCK_MODE from the environment', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts') && !rel.endsWith('_shared/mock-guard.ts') && /(?:env\.get|Deno\.env\.get)\(\s*['"]MOCK_MODE['"]\s*\)/.test(read(rel))) offenders.push(rel)
      }
    }
    walk('supabase/functions')
    expect(offenders).toEqual([])
  })
})

describe('#20 workers that must not overlap hold a lease', () => {
  it.each(['sync-catalog', 'provider-health-monitor'])('%s runs inside withWorkerLock', (fn) => {
    expect(read(`supabase/functions/${fn}/index.ts`)).toMatch(/withWorkerLock\(/)
  })
})
