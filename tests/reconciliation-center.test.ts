import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { recoverProviderOrderId } from '../supabase/functions/_shared/order-sync.ts'
import { caseSeverity, executeRetry, mapReconError, parseReconRequest, type RetryPorts } from '../supabase/functions/_shared/reconciliation.ts'
import { SMMProviderError } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { OrderStatus } from '../supabase/functions/_shared/types.ts'
import { createMockAdmin } from '../src/services/api/mock-admin'

const ID = '11111111-1111-4111-8111-111111111111'
const quiet = { warn() {}, error() {} }

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe('parseReconRequest', () => {
  it('parses every action', () => {
    expect(parseReconRequest(null)).toEqual({ action: 'GET_CASES' })
    expect(parseReconRequest({ action: 'get_cases' })).toEqual({ action: 'GET_CASES' })
    expect(parseReconRequest({ action: 'RESOLVE_REFUND', caseId: ID.toUpperCase(), reason: '  dup  ' })).toEqual({ action: 'RESOLVE_REFUND', caseId: ID, reason: 'dup' })
    expect(parseReconRequest({ action: 'RESOLVE_RETRY', caseId: ID })).toEqual({ action: 'RESOLVE_RETRY', caseId: ID })
    expect(parseReconRequest({ action: 'MARK_RESOLVED', caseId: ID, note: '', providerOrderId: ' 42 ' })).toEqual({ action: 'MARK_RESOLVED', caseId: ID, note: null, providerOrderId: '42' })
  })
  it.each([
    [[]], ['x'], [{ action: 'DROP' }], [{ action: 'RESOLVE_REFUND' }], [{ action: 'RESOLVE_RETRY', caseId: 'nope' }],
    [{ action: 'RESOLVE_REFUND', caseId: ID, reason: 5 }], [{ action: 'RESOLVE_REFUND', caseId: ID, reason: 'x'.repeat(201) }],
    [{ action: 'MARK_RESOLVED', caseId: ID, note: 'x'.repeat(301) }], [{ action: 'MARK_RESOLVED', caseId: ID, providerOrderId: {} }],
  ])('rejects %j', (b) => expect(parseReconRequest(b)).toHaveProperty('error'))
})

describe('mapReconError', () => {
  it('maps the business errors and hides the rest', () => {
    expect(mapReconError('retry_in_progress: another retry')).toMatchObject({ status: 409, error: 'retry_in_progress' })
    expect(mapReconError('case_not_open: x')).toMatchObject({ status: 409 })
    expect(mapReconError('not_retryable: x')).toMatchObject({ status: 409, error: 'not_retryable' })
    expect(mapReconError(`case ${ID} not found`)).toMatchObject({ status: 404 })
    expect(mapReconError('forbidden: actor is not an admin')).toMatchObject({ status: 403 })
    expect(mapReconError('the provider order id is required to resolve a processing order')).toMatchObject({ status: 400 })
    expect(mapReconError('connection refused at 10.0.0.1')).toMatchObject({ status: 500, message: 'Something went wrong. Please try again.' })
  })
})

describe('caseSeverity', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString()
  it('ranks money owed and old cases first', () => {
    expect(caseSeverity({ reason: 'needs_refund: x', createdAt: ago(0.2), amount: 1 }, now)).toBe('critical')
    expect(caseSeverity({ reason: 'needs_reconciliation: timeout', createdAt: ago(25), amount: 1 }, now)).toBe('critical')
    expect(caseSeverity({ reason: 'needs_reconciliation: timeout', createdAt: ago(3), amount: 1 }, now)).toBe('high')
    expect(caseSeverity({ reason: 'needs_reconciliation: timeout', createdAt: ago(0.5), amount: 75 }, now)).toBe('high')
    expect(caseSeverity({ reason: 'needs_reconciliation: timeout', createdAt: ago(0.5), amount: 5 }, now)).toBe('normal')
  })
})

describe('executeRetry', () => {
  const input = { externalServiceId: '9', link: 'https://t.me/x', quantity: 100 }
  const ports = (finishFailures = 0) => {
    const calls: string[] = []
    let failures = finishFailures
    const p: RetryPorts = {
      async finish(id) { calls.push(`finish:${id}`); if (failures-- > 0) throw new Error('db') },
      async release(note) { calls.push(`release:${note}`) },
    }
    return { p, calls }
  }
  const adapter = (fn: () => Promise<{ orderId: string }>) => ({ createOrder: fn })

  it('provider accepts -> finish (order submitted + case resolved)', async () => {
    const { p, calls } = ports()
    expect(await executeRetry(input, p, adapter(async () => ({ orderId: '777' })), quiet)).toEqual({ kind: 'submitted', providerOrderId: '777' })
    expect(calls).toEqual(['finish:777'])
  })

  it('a definitive refusal releases with a note and refunds nothing', async () => {
    const { p, calls } = ports()
    const r = await executeRetry(input, p, adapter(async () => { throw new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link' }) }), quiet)
    expect(r.kind).toBe('rejected')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^release:retry rejected by provider: /)
  })

  it('an unknown outcome (timeout) releases and warns: never concluded as failed', async () => {
    const { p, calls } = ports()
    const r = await executeRetry(input, p, adapter(async () => { throw new SMMProviderError('timeout', 'add: no response', { ambiguous: true }) }), quiet)
    expect(r.kind).toBe('unknown')
    expect(calls[0]).toMatch(/^release:retry outcome unknown: /)
  })

  it('a database hiccup after acceptance is retried once', async () => {
    const { p, calls } = ports(1)
    expect((await executeRetry(input, p, adapter(async () => ({ orderId: '5' })), quiet)).kind).toBe('submitted')
    expect(calls).toEqual(['finish:5', 'finish:5'])
  })

  it('if recording keeps failing, the provider id is kept in a note the sync worker recovers', async () => {
    const { p, calls } = ports(5)
    const r = await executeRetry(input, p, adapter(async () => ({ orderId: 'P-9001' })), quiet)
    expect(r.kind).toBe('unknown')
    const note = calls.at(-1)!.replace(/^release:/, '')
    expect(recoverProviderOrderId(`needs_reconciliation: ${note}`)).toBe('P-9001')
  })
})

describe('mock cases (dev mode)', () => {
  it('lists the demo queue as cases and resolves them', () => {
    const store = new Map<string, string>()
    const m = createMockAdmin({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) })
    const cases = m.getCases()
    expect(cases.length).toBeGreaterThan(0)
    const retryable = cases.find((c) => c.order?.canRetry)!
    m.retryCase(retryable.id)
    expect(m.getCases().some((c) => c.id === retryable.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SQL (real migrations on PGlite)
// ---------------------------------------------------------------------------

const CHAIN: Record<string, OrderStatus[]> = {
  processing: ['awaiting_payment', 'paid', 'processing'],
  failed: ['awaiting_payment', 'paid', 'failed'],
  submitted: ['awaiting_payment', 'paid', 'processing', 'submitted'],
  completed: ['awaiting_payment', 'paid', 'processing', 'submitted', 'completed'],
}

describe('Reconciliation Center (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string, customer: string, offerId: string

  type R = Record<string, unknown>
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ r: R }>(sql, params)).rows[0]?.r
  const balance = async () => Number((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [customer])).rows[0].b)
  const caseOf = async (orderId: string) => (await db.query<R>(`select * from reconciliation_cases where entity_type = 'order' and entity_id = $1 order by created_at`, [orderId])).rows
  const openCase = async (orderId: string) => (await caseOf(orderId)).find((c) => c.status === 'open') as R | undefined
  const order = async (id: string) => (await db.query<R>(`select * from orders where id = $1`, [id])).rows[0]

  /** A paid order moved through valid transitions, optionally backdated and noted. */
  async function newOrder(o: { status: keyof typeof CHAIN; charge?: number; ageMinutes?: number; note?: string | null; snapshot?: boolean }) {
    const charge = o.charge ?? 10
    const { id } = (await db.query<{ id: string }>(
      `insert into orders(user_id, service_id, target_url, quantity, charge_amount, cost_amount, provider_id, provider_offer_id)
       select $1, s.id, 'https://t.me/x', 1000, $2, 1, ps.provider_id, $3 from services s join provider_services ps on ps.id = s.primary_provider_service_id returning id`,
      [customer, charge, o.snapshot === false ? null : offerId])).rows[0]
    await db.query(`select process_wallet_transaction($1::uuid,'purchase',-$2::numeric,$3::uuid,'order','purchase:'||$3::text)`, [customer, charge, id])
    for (const s of CHAIN[o.status]) await db.query(`update orders set status = $2 where id = $1`, [id, s])
    await db.query(`update orders set error_message = $2 where id = $1`, [id, o.note ?? null])
    if (o.ageMinutes) await db.query(`update orders set created_at = now() - make_interval(mins => $2) where id = $1`, [id, o.ageMinutes])
    return id
  }
  const syncCases = () => one(`select sync_reconciliation_cases() r`)

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    banned = await q(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`)
    customer = await q(`insert into users(telegram_id) values (4) returning id`)
    await db.exec(`
      insert into providers(name, api_url) values ('p', 'https://x');
      insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'v');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        select id, '9', 's', 1, 1, 1000000 from providers;
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id, 'Views', ps.id, 10, 1, 1000000 from categories c, provider_services ps;`)
    offerId = (await db.query<{ id: string }>(`select id from provider_service_offers limit 1`)).rows[0].id
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',1000,null,'fund','fund-1')`, [customer])
  }, 120_000)

  describe('detection', () => {
    it('opens a case the moment an order is flagged needs_refund (trigger)', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: provider_rejected' })
      const c = await openCase(id)
      expect(c).toMatchObject({ entity_type: 'order', status: 'open', reason: 'needs_refund: provider_rejected' })
    })

    it('a fresh in-flight order is not a case; the detector opens one once it is stuck past the grace period', async () => {
      const id = await newOrder({ status: 'processing', note: 'needs_reconciliation: submission in flight' })
      expect(await openCase(id)).toBeUndefined()
      await db.query(`update orders set created_at = now() - interval '11 minutes' where id = $1`, [id])
      expect(await openCase(id)).toBeUndefined() // created_at is not watched by the trigger: time passing fires nothing
      expect(await syncCases()).toMatchObject({ opened: 1 })
      expect(await openCase(id)).toMatchObject({ status: 'open' })
    })

    it('keeps one open case per order however often it is flagged or synced', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: a' })
      await db.query(`update orders set error_message = 'needs_refund: b' where id = $1`, [id])
      await syncCases()
      await syncCases()
      const cases = await caseOf(id)
      expect(cases).toHaveLength(1)
      expect(cases[0].reason).toBe('needs_refund: b')
      await expect(db.query(`insert into reconciliation_cases(entity_type, entity_id, reason) values ('order', $1, 'dup')`, [id])).rejects.toThrow(/unique|duplicate/i)
    })

    it('healthy orders never become cases', async () => {
      await newOrder({ status: 'submitted', ageMinutes: 600 })
      await newOrder({ status: 'completed', ageMinutes: 600 })
      expect(await syncCases()).toMatchObject({ opened: 0 })
      expect((await db.query(`select 1 from reconciliation_cases`)).rows).toHaveLength(0)
    })

    it('closes a case automatically when the order was settled elsewhere (e.g. by the sync worker)', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: x' })
      await db.query(`select refund_order($1::uuid, null, 'worker')`, [id])
      await db.query(`update orders set error_message = null where id = $1`, [id])
      expect(await syncCases()).toMatchObject({ closed: 1 })
      expect((await caseOf(id))[0]).toMatchObject({ status: 'resolved', resolution: 'auto' })
    })

    it('uses the same rule as the existing admin queue', async () => {
      await newOrder({ status: 'processing', ageMinutes: 30, note: 'needs_reconciliation: timeout' })
      await newOrder({ status: 'processing', ageMinutes: 2, note: 'needs_reconciliation: submission in flight' })
      await newOrder({ status: 'failed', note: 'needs_refund: x' })
      await newOrder({ status: 'failed', note: 'provider_rejected: no' })
      await newOrder({ status: 'submitted', ageMinutes: 30 })
      await db.exec(`set role authenticated; select set_config('request.jwt.sub','${admin}',false)`)
      const queue = ((await db.query<{ q: { id: string }[] }>(`select admin_reconciliation_queue() q`)).rows[0].q).map((o) => o.id).sort()
      await db.exec('reset role')
      await syncCases()
      const cases = (await db.query<{ entity_id: string }>(`select entity_id from reconciliation_cases where status = 'open'`)).rows.map((r) => r.entity_id).sort()
      expect(cases).toEqual(queue)
      expect(cases).toHaveLength(2)
    })

    it('lists open cases with the order, customer and amount', async () => {
      const id = await newOrder({ status: 'processing', ageMinutes: 30, note: 'needs_reconciliation: timeout', charge: 12.5 })
      await syncCases()
      const list = (await db.query<{ r: R[] }>(`select list_reconciliation_cases() r`)).rows[0].r
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ entity_type: 'order', entity_id: id })
      expect(list[0].order).toMatchObject({ status: 'processing', charge_amount: 12.5, has_routing_snapshot: true, service_name: 'Views', telegram_id: 4 })
    })
  })

  describe('RESOLVE_REFUND', () => {
    const refund = (caseId: string, actor = admin) => one(`select resolve_case_refund($1::uuid, $2::uuid, 'checked panel') r`, [caseId, actor])

    it('refunds the full charge to the wallet, closes the order and the case, and audits it', async () => {
      const id = await newOrder({ status: 'processing', ageMinutes: 30, note: 'needs_reconciliation: timeout', charge: 25 })
      await syncCases()
      const c = (await openCase(id))!
      const before = await balance()
      expect(await refund(String(c.id))).toMatchObject({ status: 'resolved', resolution: 'refund', order_status: 'refunded' })
      expect(await balance()).toBe(before + 25)
      expect(await order(id)).toMatchObject({ status: 'refunded', error_message: null })
      expect((await caseOf(id))[0]).toMatchObject({ status: 'resolved', resolution: 'refund', resolved_by: admin, resolution_note: 'checked panel' })
      expect((await db.query(`select 1 from admin_audit_log where action = 'reconcile_refund'`)).rows).toHaveLength(1)
      expect(await openCase(id)).toBeUndefined() // no new case appeared while the order was edited
    })

    it('can never refund twice: a second call is a no-op', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: provider_rejected', charge: 10 })
      const c = (await openCase(id))!
      const before = await balance()
      await refund(String(c.id))
      expect(await refund(String(c.id))).toMatchObject({ already_resolved: true })
      expect(await balance()).toBe(before + 10)
      expect((await db.query(`select 1 from wallet_transactions where type = 'refund' and reference_id = $1`, [id])).rows).toHaveLength(1)
    })

    it('concurrent refund clicks pay once', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: x', charge: 7 })
      const c = (await openCase(id))!
      const before = await balance()
      await Promise.allSettled([refund(String(c.id)), refund(String(c.id)), refund(String(c.id))])
      expect(await balance()).toBe(before + 7)
    })

    it('an order already refunded elsewhere just closes the case, without paying again', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: x', charge: 9 })
      const c = (await openCase(id))!
      await db.query(`select refund_order($1::uuid, null, 'elsewhere')`, [id])
      const before = await balance()
      expect(await refund(String(c.id))).toMatchObject({ status: 'resolved' })
      expect(await balance()).toBe(before)
    })

    it('refuses an actor who is not a live admin, and changes nothing', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: x' })
      const c = (await openCase(id))!
      for (const actor of [user, banned]) await expect(refund(String(c.id), actor)).rejects.toThrow(/forbidden/)
      expect(await openCase(id)).toBeTruthy()
      expect((await order(id)).status).toBe('failed')
    })

    it('will not refund while a retry is being submitted', async () => {
      const id = await newOrder({ status: 'processing', ageMinutes: 30, note: 'needs_reconciliation: timeout' })
      await syncCases()
      const c = (await openCase(id))!
      await one(`select begin_case_retry($1::uuid, $2::uuid) r`, [c.id, admin])
      await expect(refund(String(c.id))).rejects.toThrow(/retry_in_progress/)
    })

    it('a refund that fails leaves everything as it was (one transaction)', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: x', charge: 5 })
      const c = (await openCase(id))!
      await db.exec(`create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
        create trigger trg_boom before update on reconciliation_cases for each row execute function pg_temp.boom();`)
      const before = await balance()
      await expect(refund(String(c.id))).rejects.toThrow(/boom/)
      await db.exec(`drop trigger trg_boom on reconciliation_cases`)
      expect(await balance()).toBe(before)
      expect((await order(id)).status).toBe('failed')
      expect(await openCase(id)).toBeTruthy()
    })

    it('deposit / provider_payment cases cannot be refunded here', async () => {
      const { id } = (await db.query<{ id: string }>(`insert into reconciliation_cases(entity_type, entity_id, reason) values ('deposit', 'd1', 'stuck') returning id`)).rows[0]
      await expect(refund(id)).rejects.toThrow(/unsupported_entity/)
    })
  })

  describe('RESOLVE_RETRY (database half; the provider call is covered by executeRetry)', () => {
    const begin = (caseId: string, actor = admin) => one(`select begin_case_retry($1::uuid, $2::uuid) r`, [caseId, actor])
    const finish = (caseId: string, pid: string) => one(`select finish_case_retry($1::uuid, $2::uuid, $3) r`, [caseId, admin, pid])

    async function heldCase(snapshot = true) {
      const id = await newOrder({ status: 'processing', ageMinutes: 30, note: 'needs_reconciliation: timeout', snapshot })
      await syncCases()
      return { id, caseId: String((await openCase(id))!.id) }
    }

    it('claims the retry, then records the provider id, submits the order and resolves the case atomically', async () => {
      const { id, caseId } = await heldCase()
      expect(await begin(caseId)).toMatchObject({ order_id: id, quantity: 1000, provider_offer_id: offerId })
      expect((await order(id)).error_message).toBe('needs_reconciliation: retry in progress')
      expect(await finish(caseId, '  P-77 ')).toMatchObject({ resolution: 'retry', order_status: 'submitted' })
      expect(await order(id)).toMatchObject({ status: 'submitted', provider_order_id: 'P-77', error_message: null })
      expect((await caseOf(id))[0]).toMatchObject({ status: 'resolved', resolution: 'retry', resolved_by: admin })
      expect((await db.query(`select 1 from admin_audit_log where action = 'reconcile_retry'`)).rows).toHaveLength(1)
    })

    it('only one retry at a time: a second claim is refused while the first runs', async () => {
      const { caseId } = await heldCase()
      await begin(caseId)
      await expect(begin(caseId)).rejects.toThrow(/retry_in_progress/)
    })

    it('a crashed retry does not block forever: the claim expires after 5 minutes', async () => {
      const { id, caseId } = await heldCase()
      await begin(caseId)
      await db.exec(`alter table orders disable trigger trg_orders_updated_at`)
      await db.query(`update orders set updated_at = now() - interval '6 minutes' where id = $1`, [id])
      await db.exec(`alter table orders enable trigger trg_orders_updated_at`)
      await expect(begin(caseId)).resolves.toBeTruthy()
    })

    it('finishing twice is a no-op, and a finished case cannot be retried again', async () => {
      const { caseId } = await heldCase()
      await begin(caseId)
      await finish(caseId, 'P-1')
      expect(await finish(caseId, 'P-2')).toMatchObject({ already_resolved: true })
      await expect(begin(caseId)).rejects.toThrow(/case_not_open/)
    })

    it('release keeps the case open with the reason and lets the admin retry again', async () => {
      const { id, caseId } = await heldCase()
      await begin(caseId)
      await db.query(`select release_case_retry($1::uuid, 'retry rejected by provider: invalid_link')`, [caseId])
      expect((await order(id)).error_message).toBe('needs_reconciliation: retry rejected by provider: invalid_link')
      expect(await openCase(id)).toBeTruthy()
      await expect(begin(caseId)).resolves.toBeTruthy()
    })

    it('refuses orders that cannot be retried safely', async () => {
      const failed = await newOrder({ status: 'failed', note: 'needs_refund: x' })
      await expect(begin(String((await openCase(failed))!.id))).rejects.toThrow(/not_retryable/)

      const { caseId: noSnap } = await heldCase(false)
      await expect(begin(noSnap)).rejects.toThrow(/not_retryable: this order has no routing snapshot/)

      const { caseId } = await heldCase()
      for (const actor of [user, banned]) await expect(begin(caseId, actor)).rejects.toThrow(/forbidden/)
    })
  })

  describe('MARK_RESOLVED', () => {
    const manual = (caseId: string, note: string | null, pid: string | null = null) => one(`select resolve_case_manual($1::uuid, $2::uuid, $3, $4) r`, [caseId, admin, note, pid])

    it('a held order needs the provider id; it then moves to submitted for the sync worker', async () => {
      const id = await newOrder({ status: 'processing', ageMinutes: 30, note: 'needs_reconciliation: timeout' })
      await syncCases()
      const c = String((await openCase(id))!.id)
      await expect(manual(c, 'checked')).rejects.toThrow(/provider order id is required/)
      await manual(c, null, 'P-5')
      expect(await order(id)).toMatchObject({ status: 'submitted', provider_order_id: 'P-5', error_message: null })
      expect((await caseOf(id))[0]).toMatchObject({ status: 'resolved', resolution: 'manual' })
    })

    it('an owed refund handled elsewhere needs a note, moves no money', async () => {
      const id = await newOrder({ status: 'failed', note: 'needs_refund: x', charge: 10 })
      const c = String((await openCase(id))!.id)
      const before = await balance()
      await expect(manual(c, null)).rejects.toThrow(/note is required/)
      await manual(c, 'paid back by bank transfer')
      expect(await balance()).toBe(before)
      expect(await order(id)).toMatchObject({ status: 'failed', error_message: null })
      expect(await syncCases()).toMatchObject({ opened: 0 }) // it does not come back
    })

    it('other entities close with a note; closing is idempotent', async () => {
      const { id } = (await db.query<{ id: string }>(`insert into reconciliation_cases(entity_type, entity_id, reason) values ('provider_payment', 'tx-1', 'unmatched') returning id`)).rows[0]
      await expect(manual(id, null)).rejects.toThrow(/note is required/)
      await manual(id, 'matched by hand')
      expect(await manual(id, 'again')).toMatchObject({ already_resolved: true })
    })
  })

  it('clients can neither read cases nor call any resolver', async () => {
    const id = await newOrder({ status: 'failed', note: 'needs_refund: x' })
    const c = String((await openCase(id))!.id)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}; select set_config('request.jwt.sub','${admin}',false)`)
      await expect(db.query(`select * from reconciliation_cases`)).rejects.toThrow()
      await expect(db.query(`select resolve_case_refund($1::uuid, $2::uuid)`, [c, admin])).rejects.toThrow()
      await expect(db.query(`select begin_case_retry($1::uuid, $2::uuid)`, [c, admin])).rejects.toThrow()
      await expect(db.query(`select resolve_case_manual($1::uuid, $2::uuid, 'x')`, [c, admin])).rejects.toThrow()
      await expect(db.query(`select list_reconciliation_cases()`)).rejects.toThrow()
    }
    await db.exec('reset role')
    expect(await openCase(id)).toBeTruthy()
  })
})
