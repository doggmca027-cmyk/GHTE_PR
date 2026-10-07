import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { mapTreasuryError, parseTreasuryRequest } from '../supabase/functions/_shared/admin-treasury.ts'
import { topupAmount } from '../supabase/functions/_shared/health-monitor.ts'
import { AdminApiError } from '../src/services/api/mock-admin'
import { createMockTreasury } from '../src/services/api/mock-treasury'

const ID = '11111111-1111-4111-8111-111111111111'

describe('proposal requests', () => {
  it('parses approve / reject', () => {
    expect(parseTreasuryRequest({ action: 'approve_proposal', proposalId: ID.toUpperCase() })).toEqual({ action: 'APPROVE_PROPOSAL', proposalId: ID })
    expect(parseTreasuryRequest({ action: 'REJECT_PROPOSAL', proposalId: ID })).toEqual({ action: 'REJECT_PROPOSAL', proposalId: ID })
  })
  it.each([[{ action: 'APPROVE_PROPOSAL' }], [{ action: 'APPROVE_PROPOSAL', proposalId: 'x' }], [{ action: 'REJECT_PROPOSAL', proposalId: 5 }], [{ action: 'APPROVE_PROPOSAL', proposalId: `${ID}; drop` }]])(
    'rejects %j', (b) => expect(parseTreasuryRequest(b)).toHaveProperty('error'))

  it('maps proposal errors', () => {
    expect(mapTreasuryError('proposal_not_pending: already approved')).toMatchObject({ status: 409, error: 'proposal_not_pending' })
    expect(mapTreasuryError('unsupported_currency: the treasury is held in USD, the proposal is in EUR')).toMatchObject({ status: 409, error: 'unsupported_currency' })
    expect(mapTreasuryError(`proposal ${ID} not found`)).toMatchObject({ status: 404 })
  })
})

describe('topupAmount', () => {
  it('is target - balance, never negative', () => {
    expect(topupAmount(100, 4.5)).toBe(95.5)
    expect(topupAmount(100, 0.00004)).toBe(100)
    expect(topupAmount(50, 50)).toBe(0)
    expect(topupAmount(50, 60)).toBe(0)
  })
})

describe('mock treasury proposals (dev mode)', () => {
  it('approve debits the treasury, reject does not, both remove the proposal', () => {
    const m = createMockTreasury()
    const before = m.page(null)
    const [p] = before.proposals
    m.decide(p.id, 'approve')
    const after = m.page(null)
    expect(after.balance).toBe(Math.round((before.balance - p.amount) * 10_000) / 10_000)
    expect(after.proposals).toEqual([])
    expect(after.transactions[0]).toMatchObject({ type: 'provider_topup', amount: -p.amount })
    expect(() => m.decide(p.id, 'approve')).toThrow(AdminApiError) // already decided
  })
})

// ---------------------------------------------------------------------------
// SQL: proposals, approval atomicity
// ---------------------------------------------------------------------------

describe('topup proposals (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  let prov: string, prov2: string, eur: string

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
    prov = await q(`insert into providers(name, api_url) values ('P1', 'https://1') returning id`)
    prov2 = await q(`insert into providers(name, api_url) values ('P2', 'https://2') returning id`)
    eur = await q(`insert into providers(name, api_url, currency) values ('Euro', 'https://e', 'EUR') returning id`)
    // Phase 6: approving now creates an outbound payment, which needs the provider's payout config (fail closed without it)
    await db.exec(`update providers set allowed_destination_wallet = '0:' || repeat('ab', 32), max_topup_per_tx = 1000, max_daily_topup = 10000`)
  }, 120_000)

  const create = async (provider: string, amount: number | null) =>
    (await db.query<{ r: { id: string; amount: number; created: boolean; currency: string } }>(`select create_topup_proposal($1::uuid, $2::numeric) r`, [provider, amount])).rows[0].r
  const approve = (id: string, actor: string | null) => db.query<{ r: Record<string, unknown> }>(`select approve_topup_proposal($1::uuid, $2::uuid) r`, [id, actor])
  const reject = (id: string, actor: string | null) => db.query(`select reject_topup_proposal($1::uuid, $2::uuid) r`, [id, actor])
  const fund = (amount: number) => db.query(`select process_treasury_transaction('deposit', $1)`, [amount])
  const treasury = async () => Number((await db.query<{ b: string }>(`select balance::text b from treasury_state`)).rows[0].b)
  const status = async (id: string) => (await db.query<{ s: string }>(`select status::text s from topup_proposals where id = $1`, [id])).rows[0].s

  describe('creating', () => {
    it('files a pending proposal and is idempotent per provider', async () => {
      const a = await create(prov, 95.5)
      expect(a).toMatchObject({ amount: 95.5, created: true, currency: 'USD' })
      const b = await create(prov, 40) // another amount while one is pending: the pending one wins untouched
      expect(b).toMatchObject({ id: a.id, amount: 95.5, created: false })
      expect((await db.query(`select 1 from topup_proposals`)).rows).toHaveLength(1)
      expect((await create(prov2, 10)).created).toBe(true) // a different provider is independent
    })

    it('the database itself allows only one pending proposal per provider', async () => {
      await create(prov, 10)
      await expect(db.exec(`insert into topup_proposals(provider_id, amount) values ('${prov}', 5)`)).rejects.toThrow(/unique|duplicate/i)
    })

    it('allows a new proposal once the previous one was decided', async () => {
      const a = await create(prov, 10)
      await reject(a.id, admin)
      expect((await create(prov, 20)).created).toBe(true)
    })

    it.each([[0], [-5], [null], [1e9]])('rejects amount %s', async (amt) => {
      await expect(create(prov, amt)).rejects.toThrow()
    })

    it('rejects an unknown provider and non-positive table values', async () => {
      await expect(create('00000000-0000-0000-0000-000000000000', 5)).rejects.toThrow(/not found/)
      await expect(db.exec(`insert into topup_proposals(provider_id, amount) values ('${prov}', 0)`)).rejects.toThrow()
    })

    it('is deleted together with its provider', async () => {
      await create(prov, 10)
      await db.exec(`delete from providers where id = '${prov}'`)
      expect((await db.query(`select 1 from topup_proposals`)).rows).toHaveLength(0)
    })
  })

  describe('approving', () => {
    it('Phase 6: a provider without payout config cannot be paid (fail closed); nothing changes', async () => {
      await fund(500)
      await db.exec(`update providers set allowed_destination_wallet = null where id = '${prov}'`)
      const p = await create(prov, 10)
      await expect(approve(p.id, admin)).rejects.toThrow(/payout_not_configured/)
      expect(await treasury()).toBe(500)
      expect(await status(p.id)).toBe('pending')
      await db.exec(`update providers set allowed_destination_wallet = '0:' || repeat('ab', 32), max_topup_per_tx = null, max_daily_topup = null where id = '${prov}'`)
      await expect(approve(p.id, admin)).rejects.toThrow(/payout_limits_not_configured/)
      expect(await treasury()).toBe(500)
    })

    it('Phase 6: approval creates a VALIDATED provider payment with the server-side destination', async () => {
      await fund(500)
      const p = await create(prov, 40)
      const r = (await approve(p.id, admin)).rows[0].r
      expect(r).toMatchObject({ status: 'approved', payment_status: 'VALIDATED' })
      const pay = (await db.query<Record<string, unknown>>(`select status::text, amount::text, destination_wallet, asset, network, treasury_debited, proposal_id from provider_payments where id = $1`, [r.payment_id])).rows[0]
      expect(pay).toEqual({ status: 'VALIDATED', amount: '40.0000', destination_wallet: '0:' + 'ab'.repeat(32), asset: 'TON', network: 'mainnet', treasury_debited: true, proposal_id: p.id })
    })

    it('debits the treasury exactly once, marks the proposal and audits it', async () => {
      await fund(500)
      const p = await create(prov, 95.5)
      const r = (await approve(p.id, admin)).rows[0].r
      expect(r).toMatchObject({ status: 'approved', amount: 95.5, balance_after: 404.5 })
      expect(await treasury()).toBe(404.5)
      expect(await status(p.id)).toBe('approved')
      const tx = (await db.query<{ type: string; amount: string; reference_id: string; description: string }>(`select type::text, amount::text, reference_id, description from treasury_transactions where type = 'provider_topup'`)).rows
      expect(tx).toEqual([{ type: 'provider_topup', amount: '-95.5000', reference_id: p.id, description: 'Top-up of P1' }])
      const decided = (await db.query<{ decided_by: string; decided_at: string | null }>(`select decided_by, decided_at from topup_proposals where id = '${p.id}'`)).rows[0]
      expect(decided.decided_by).toBe(admin)
      expect(decided.decided_at).not.toBeNull()
      expect((await db.query(`select 1 from admin_audit_log where action = 'treasury_provider_topup' and admin_id = '${admin}'`)).rows).toHaveLength(1)
    })

    it('a second approval is refused and does not debit again', async () => {
      await fund(500)
      const p = await create(prov, 100)
      await approve(p.id, admin)
      await expect(approve(p.id, admin)).rejects.toThrow(/proposal_not_pending/)
      expect(await treasury()).toBe(400)
    })

    it('with insufficient funds nothing changes and the proposal stays pending', async () => {
      await fund(50)
      const p = await create(prov, 95.5)
      await expect(approve(p.id, admin)).rejects.toThrow(/insufficient_treasury_funds/)
      expect(await treasury()).toBe(50)
      expect(await status(p.id)).toBe('pending')
      expect((await db.query(`select 1 from treasury_transactions where type = 'provider_topup'`)).rows).toHaveLength(0)
      // after funding the same proposal can be approved
      await fund(100)
      await approve(p.id, admin)
      expect(await treasury()).toBe(54.5)
    })

    it('rolls back the debit if marking the proposal fails (single transaction)', async () => {
      await fund(500)
      const p = await create(prov, 100)
      // simulate a failure after the treasury step: the status update trips a trigger
      await db.exec(`
        create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
        create trigger trg_boom before update on topup_proposals for each row execute function pg_temp.boom();`)
      await expect(approve(p.id, admin)).rejects.toThrow(/boom/)
      await db.exec(`drop trigger trg_boom on topup_proposals`)
      expect(await treasury()).toBe(500)
      expect(await status(p.id)).toBe('pending')
      expect((await db.query(`select 1 from treasury_transactions where type = 'provider_topup'`)).rows).toHaveLength(0)
    })

    it('cannot approve a proposal in a currency the treasury does not hold', async () => {
      await fund(500)
      const p = await create(eur, 50)
      expect(p.currency).toBe('EUR')
      await expect(approve(p.id, admin)).rejects.toThrow(/unsupported_currency/)
      expect(await treasury()).toBe(500)
    })

    it('concurrent approvals debit once', async () => {
      await fund(500)
      const p = await create(prov, 100)
      const results = await Promise.allSettled([approve(p.id, admin), approve(p.id, admin), approve(p.id, admin)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(await treasury()).toBe(400)
    })

    it('two proposals together cannot overdraw the treasury', async () => {
      await fund(150)
      const a = await create(prov, 100)
      const b = await create(prov2, 100)
      const results = await Promise.allSettled([approve(a.id, admin), approve(b.id, admin)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(await treasury()).toBe(50)
    })

    it('refuses an unknown proposal and any actor that is not a live admin', async () => {
      await fund(500)
      const p = await create(prov, 10)
      await expect(approve('00000000-0000-0000-0000-000000000000', admin)).rejects.toThrow(/not found/)
      for (const actor of [user, banned, null]) await expect(approve(p.id, actor)).rejects.toThrow(/forbidden/)
      expect(await treasury()).toBe(500)
      expect(await status(p.id)).toBe('pending')
    })
  })

  describe('rejecting', () => {
    it('only changes the status, never the treasury, and is audited', async () => {
      await fund(500)
      const p = await create(prov, 100)
      await reject(p.id, admin)
      expect(await status(p.id)).toBe('rejected')
      expect(await treasury()).toBe(500)
      expect((await db.query(`select 1 from admin_audit_log where action = 'reject_topup_proposal'`)).rows).toHaveLength(1)
    })

    it('cannot reject what is already decided, and an approved one cannot be rejected', async () => {
      await fund(500)
      const p = await create(prov, 100)
      await approve(p.id, admin)
      await expect(reject(p.id, admin)).rejects.toThrow(/proposal_not_pending/)
      const q = await create(prov2, 10)
      await reject(q.id, admin)
      await expect(approve(q.id, admin)).rejects.toThrow(/proposal_not_pending/)
    })

    it('requires a live admin', async () => {
      const p = await create(prov, 10)
      for (const actor of [user, banned, null]) await expect(reject(p.id, actor)).rejects.toThrow(/forbidden/)
    })
  })

  it('anon and signed-in users cannot touch proposals or call the functions', async () => {
    await fund(500)
    const p = await create(prov, 10)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`)
      await expect(db.query(`select * from topup_proposals`)).rejects.toThrow()
      await expect(db.query(`update topup_proposals set status = 'approved'`)).rejects.toThrow()
      await expect(approve(p.id, admin)).rejects.toThrow()
      await expect(reject(p.id, admin)).rejects.toThrow()
      await expect(create(prov, 5)).rejects.toThrow()
    }
    await db.exec('reset role')
    expect(await status(p.id)).toBe('pending')
    expect(await treasury()).toBe(500)
  })
})
