import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { mapTreasuryError, parseTreasuryRequest } from '../supabase/functions/_shared/admin-treasury.ts'
import {
  BroadcastRejected,
  confirmProviderPayment,
  executeProviderPayment,
  mockBroadcastToBlockchain,
  type PaymentPorts,
} from '../supabase/functions/_shared/provider-payment-flow.ts'

const WALLET = `0:${'ab'.repeat(32)}`
const OTHER_WALLET = `0:${'ee'.repeat(32)}`
const PID = '11111111-1111-4111-8111-111111111111'

// ---------------------------------------------------------------------------
// The engine (pure, fake ports)
// ---------------------------------------------------------------------------

function fakePorts(opts: { recordFails?: number } = {}) {
  const calls: string[] = []
  let recordFails = opts.recordFails ?? 0
  const ports: PaymentPorts = {
    async createInstruction(id) { calls.push('create'); return { paymentId: id, destinationWallet: WALLET, amount: 10, asset: 'TON', network: 'mainnet', idempotencyKey: `proposal:${id}` } },
    async recordBroadcast(_id, tx) { calls.push(`record:${tx.startsWith('mock-') ? 'mock' : tx}`); if (recordFails-- > 0) throw new Error('db') },
    async markUnknown(_id, reason) { calls.push(`unknown:${reason.split(':')[0]}`) },
    async fail(_id, reason) { calls.push(`fail:${reason.split(':')[0]}`) },
    async advance(_id, to) { calls.push(`advance:${to}`) },
  }
  return { ports, calls }
}

describe('executeProviderPayment', () => {
  it('broadcast ok -> recorded (BROADCASTED)', async () => {
    const { ports, calls } = fakePorts()
    expect((await executeProviderPayment(PID, ports, mockBroadcastToBlockchain('ok'))).kind).toBe('broadcasted')
    expect(calls).toEqual(['create', 'record:mock'])
  })
  it('a definitive refusal fails the payment (money back), never marks it unknown', async () => {
    const { ports, calls } = fakePorts()
    expect(await executeProviderPayment(PID, ports, mockBroadcastToBlockchain('reject'))).toMatchObject({ kind: 'failed' })
    expect(calls).toEqual(['create', 'fail:broadcast rejected'])
  })
  it('a timeout is UNKNOWN (reconciliation), never failed and never re-sent', async () => {
    const { ports, calls } = fakePorts()
    let sends = 0
    const out = await executeProviderPayment(PID, ports, { broadcast: async () => { sends++; throw new Error('timeout') } })
    expect(out.kind).toBe('unknown')
    expect(sends).toBe(1)
    expect(calls).toEqual(['create', 'unknown:broadcast outcome unknown'])
  })
  it('if the hash cannot be recorded (twice) the payment goes to reconciliation with the hash, not failed', async () => {
    const { ports, calls } = fakePorts({ recordFails: 5 })
    const out = await executeProviderPayment(PID, ports, mockBroadcastToBlockchain('ok'))
    expect(out.kind).toBe('unknown')
    expect(calls.at(-1)).toMatch(/^unknown:broadcast succeeded as mock-\S+ but recording it failed$/)
    expect(calls.filter((c) => c.startsWith('fail'))).toEqual([])
  })
  it('the mock broadcaster is deterministic per payment (same key, same hash)', async () => {
    const b = mockBroadcastToBlockchain()
    const i = { paymentId: PID, destinationWallet: WALLET, amount: 1, asset: 'TON', network: 'mainnet', idempotencyKey: 'k' }
    expect((await b.broadcast(i)).txHash).toBe((await b.broadcast(i)).txHash)
    await expect(mockBroadcastToBlockchain('reject').broadcast(i)).rejects.toBeInstanceOf(BroadcastRejected)
  })
})

describe('confirmProviderPayment', () => {
  const pay = { id: PID, status: 'BROADCASTED', txHash: 'TX' }
  it('walks to COMPLETED when the chain and the provider balance agree', async () => {
    const { ports, calls } = fakePorts()
    expect(await confirmProviderPayment(pay, { chainConfirmed: async () => true, providerBalanceCredited: async () => true }, ports)).toEqual({ kind: 'completed' })
    expect(calls).toEqual(['advance:CONFIRMING', 'advance:CONFIRMED', 'advance:PROVIDER_BALANCE_VERIFIED', 'advance:COMPLETED'])
  })
  it('waits while the chain has no answer; fails (money back) only when the chain says it failed', async () => {
    const a = fakePorts()
    expect(await confirmProviderPayment(pay, { chainConfirmed: async () => null, providerBalanceCredited: async () => true }, a.ports)).toEqual({ kind: 'waiting', at: 'CONFIRMING' })
    const b = fakePorts()
    expect(await confirmProviderPayment(pay, { chainConfirmed: async () => false, providerBalanceCredited: async () => true }, b.ports)).toEqual({ kind: 'failed' })
    expect(b.calls).toEqual(['advance:CONFIRMING', 'fail:transaction failed on chain'])
  })
  it('confirmed on chain but not seen by the provider -> reconciliation, nothing reversed', async () => {
    const { ports, calls } = fakePorts()
    expect(await confirmProviderPayment(pay, { chainConfirmed: async () => true, providerBalanceCredited: async () => false }, ports)).toEqual({ kind: 'reconciliation' })
    expect(calls.filter((c) => c.startsWith('fail'))).toEqual([])
  })
})

describe('admin-treasury payment actions (parsing / errors)', () => {
  it('parses the new actions strictly', () => {
    expect(parseTreasuryRequest({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: ' abc= ' })).toEqual({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'abc=' })
    expect(parseTreasuryRequest({ action: 'ADVANCE_PAYMENT', paymentId: PID, to: 'COMPLETED' })).toMatchObject({ to: 'COMPLETED' })
    expect(parseTreasuryRequest({ action: 'CANCEL_PAYMENT', paymentId: PID, reason: 'wrong amount' })).toMatchObject({ reason: 'wrong amount' })
    for (const bad of [
      { action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'a b' }, { action: 'ADVANCE_PAYMENT', paymentId: PID, to: 'FAILED' },
      { action: 'FAIL_PAYMENT', paymentId: PID, reason: 'x' }, { action: 'CANCEL_PAYMENT', paymentId: 'nope', reason: 'valid reason' },
      // the client can never choose where money goes
      { action: 'APPROVE_PROPOSAL', proposalId: PID, destinationWallet: OTHER_WALLET },
    ]) {
      const r = parseTreasuryRequest(bad)
      if ('error' in r) continue
      expect(r).not.toHaveProperty('destinationWallet')
    }
  })
  it('maps every limit error to a 409 with its reason', () => {
    expect(mapTreasuryError('max_daily_topup_exceeded: used today 40, requested 20, limit 50')).toMatchObject({ status: 409, error: 'max_daily_topup_exceeded' })
    expect(mapTreasuryError('treasury_reserve_breached: balance 100, requested 70, minimum reserve 40')).toMatchObject({ status: 409, error: 'treasury_reserve_breached' })
    expect(mapTreasuryError('destination_not_allowed: x')).toMatchObject({ status: 409 })
    expect(mapTreasuryError('invalid provider payment transition COMPLETED -> FAILED')).toMatchObject({ status: 409, error: 'invalid_transition' })
  })
})

// ---------------------------------------------------------------------------
// The state machine and the money gate (real SQL)
// ---------------------------------------------------------------------------

describe('provider_payments (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, prov: string, prov2: string
  type R = Record<string, unknown>

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
    prov = await q(`insert into providers(name, api_url, allowed_destination_wallet, max_topup_per_tx, max_daily_topup) values ('P1', 'https://1', '${WALLET}', 30, 50) returning id`)
    prov2 = await q(`insert into providers(name, api_url, allowed_destination_wallet, max_topup_per_tx, max_daily_topup) values ('P2', 'https://2', '${OTHER_WALLET}', 100, 1000) returning id`)
    await db.exec(`select process_treasury_transaction('deposit', 200)`)
  }, 120_000)

  const one = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p)).rows[0].r
  /** An APPROVED payment, terms copied from the provider's server-side config. */
  async function approved(provider: string, amount: number) {
    const id = (await db.query<{ id: string }>(
      `insert into provider_payments(provider_id, amount, asset, network, destination_wallet, status, idempotency_key)
       select id, $2, payout_asset, payout_network, allowed_destination_wallet, 'PROPOSED', 'test:' || gen_random_uuid() from providers where id = $1 returning id`,
      [provider, amount])).rows[0].id
    await db.query(`update provider_payments set status = 'APPROVED' where id = $1`, [id])
    return id
  }
  const validate = (id: string, actor: string | null = admin) => one(`select validate_provider_payment($1::uuid, $2::uuid) r`, [id, actor])
  const treasury = async () => Number((await db.query<{ b: string }>(`select balance::text b from treasury_state`)).rows[0].b)
  const statusOf = async (id: string) => (await db.query<{ s: string; d: boolean; rv: boolean }>(`select status::text s, treasury_debited d, treasury_reversed rv from provider_payments where id = $1`, [id])).rows[0]

  describe('the money gate (APPROVED -> VALIDATED)', () => {
    it('debits the treasury once and records it', async () => {
      const id = await approved(prov, 25)
      expect(await validate(id)).toMatchObject({ status: 'VALIDATED', balance_after: 175 })
      expect(await statusOf(id)).toEqual({ s: 'VALIDATED', d: true, rv: false })
      expect(await validate(id)).toMatchObject({ already: true })
      expect(await treasury()).toBe(175)
    })

    it('max_topup_per_tx: 30 passes, 31 is refused (nothing debited)', async () => {
      await expect(validate(await approved(prov, 30.01))).rejects.toThrow(/max_topup_per_tx_exceeded/)
      expect(await treasury()).toBe(200)
      await validate(await approved(prov, 30))
    })

    it('max_daily_topup counts everything committed today, including payments not broadcast yet', async () => {
      await validate(await approved(prov, 30)) // VALIDATED only
      const second = await approved(prov, 20)
      await validate(second) // 50 = limit
      await expect(validate(await approved(prov, 0.01))).rejects.toThrow(/max_daily_topup_exceeded: used today 50.0000/)
      // another provider has its own budget
      await validate(await approved(prov2, 60))
    })

    it('a payment given back (failed / canceled) frees its share of the daily budget', async () => {
      const a = await approved(prov, 30)
      await validate(a)
      await one(`select cancel_provider_payment($1::uuid, 'operator changed mind', $2::uuid) r`, [a, admin])
      await validate(await approved(prov, 30))
      await validate(await approved(prov, 20)) // 30 canceled + 30 + 20 = 50 counted
    })

    it('minimum treasury reserve: the treasury may not fall below it', async () => {
      await one(`select set_config('request.jwt.sub', $1, false) r`, [admin])
      await db.exec(`set role authenticated`)
      await one(`select admin_set_treasury_reserve(150) r`)
      await db.exec('reset role')
      await validate(await approved(prov2, 50)) // 200 - 50 = 150, exactly the reserve
      await expect(validate(await approved(prov2, 0.01))).rejects.toThrow(/treasury_reserve_breached: balance 150.0000, requested 0.0100, minimum reserve 150.0000/)
      expect(await treasury()).toBe(150)
    })

    it('a destination that is not the provider\'s allowed wallet is refused', async () => {
      const id = (await db.query<{ id: string }>(
        `insert into provider_payments(provider_id, amount, asset, network, destination_wallet, status, idempotency_key) values ($1, 10, 'TON', 'mainnet', $2, 'APPROVED', 'evil') returning id`,
        [prov, OTHER_WALLET])).rows[0].id
      await expect(validate(id)).rejects.toThrow(/destination_not_allowed/)
      expect(await treasury()).toBe(200)
    })

    it('a config change after approval (wallet, network) blocks the payment', async () => {
      const id = await approved(prov, 10)
      await db.exec(`update providers set allowed_destination_wallet = '0:${'cc'.repeat(32)}' where id = '${prov}'`)
      await expect(validate(id)).rejects.toThrow(/destination_not_allowed/)
      await db.exec(`update providers set allowed_destination_wallet = '${WALLET}', payout_network = 'testnet' where id = '${prov}'`)
      await expect(validate(id)).rejects.toThrow(/payout_config_mismatch/)
    })

    it('fails closed when limits or the wallet are not configured', async () => {
      const id = await approved(prov, 10)
      await db.exec(`update providers set max_daily_topup = null where id = '${prov}'`)
      await expect(validate(id)).rejects.toThrow(/payout_limits_not_configured/)
      await db.exec(`update providers set max_daily_topup = 50, allowed_destination_wallet = null where id = '${prov}'`)
      await expect(validate(id)).rejects.toThrow(/payout_not_configured/)
    })

    it('only an APPROVED payment can be validated, and only by the system or a live admin', async () => {
      const id = await approved(prov, 10)
      await expect(validate(id, user)).rejects.toThrow(/forbidden/)
      await validate(id, null) // system worker
      const proposed = (await db.query<{ id: string }>(`insert into provider_payments(provider_id, amount, asset, network, destination_wallet, idempotency_key) values ($1, 5, 'TON', 'mainnet', $2, 'p') returning id`, [prov, WALLET])).rows[0].id
      await expect(validate(proposed)).rejects.toThrow(/payment_not_approved/)
    })
  })

  describe('the state machine', () => {
    it('walks the happy path to COMPLETED', async () => {
      const id = await approved(prov, 10)
      await validate(id)
      await one(`select create_provider_payment_instruction($1::uuid) r`, [id])
      await one(`select record_provider_payment_broadcast($1::uuid, 'TXHASH1') r`, [id])
      for (const to of ['CONFIRMING', 'CONFIRMED', 'PROVIDER_BALANCE_VERIFIED', 'COMPLETED']) await one(`select advance_provider_payment($1::uuid, $2::provider_payment_status_enum) r`, [id, to])
      expect((await statusOf(id)).s).toBe('COMPLETED')
      expect(await treasury()).toBe(190)
    })

    it('refuses invalid transitions and skipping steps', async () => {
      const id = await approved(prov, 10)
      await expect(db.query(`update provider_payments set status = 'BROADCASTED' where id = $1`, [id])).rejects.toThrow(/invalid provider payment transition APPROVED -> BROADCASTED/)
      await expect(one(`select advance_provider_payment($1::uuid, 'COMPLETED') r`, [id])).rejects.toThrow()
      await validate(id)
      await expect(one(`select record_provider_payment_broadcast($1::uuid, 'X') r`, [id])).rejects.toThrow(/invalid provider payment transition VALIDATED -> BROADCASTED/)
    })

    it('terms and a recorded hash are immutable; payments are never deleted', async () => {
      const id = await approved(prov, 10)
      await expect(db.query(`update provider_payments set amount = 1 where id = $1`, [id])).rejects.toThrow(/immutable/)
      await expect(db.query(`update provider_payments set destination_wallet = $2 where id = $1`, [id, OTHER_WALLET])).rejects.toThrow(/immutable/)
      await validate(id)
      await one(`select create_provider_payment_instruction($1::uuid) r`, [id])
      await one(`select record_provider_payment_broadcast($1::uuid, 'H1') r`, [id])
      await expect(db.query(`update provider_payments set tx_hash = 'H2' where id = $1`, [id])).rejects.toThrow(/cannot change/)
      await expect(db.query(`delete from provider_payments where id = $1`, [id])).rejects.toThrow(/cannot be deleted/)
    })

    it('one transaction hash can be recorded on one payment only', async () => {
      const a = await approved(prov2, 10), b = await approved(prov2, 10)
      for (const id of [a, b]) { await validate(id); await one(`select create_provider_payment_instruction($1::uuid) r`, [id]) }
      await one(`select record_provider_payment_broadcast($1::uuid, 'SAME') r`, [a])
      await expect(one(`select record_provider_payment_broadcast($1::uuid, 'SAME') r`, [b])).rejects.toThrow(/tx_already_used/)
    })

    it('FAILED gives the money back exactly once', async () => {
      const id = await approved(prov, 25)
      await validate(id)
      await one(`select create_provider_payment_instruction($1::uuid) r`, [id])
      await one(`select fail_provider_payment($1::uuid, 'signer refused', null) r`, [id])
      await one(`select fail_provider_payment($1::uuid, 'again', null) r`, [id])
      expect(await treasury()).toBe(200)
      expect(await statusOf(id)).toEqual({ s: 'FAILED', d: true, rv: true })
      expect((await db.query(`select 1 from treasury_transactions where reference_id = $1`, [`payment-reversal:${id}`])).rows).toHaveLength(1)
    })

    it('UNKNOWN goes to reconciliation, keeps the money out of the treasury and opens a case', async () => {
      const id = await approved(prov, 25)
      await validate(id)
      await one(`select create_provider_payment_instruction($1::uuid) r`, [id])
      expect(await one(`select mark_provider_payment_unknown($1::uuid, 'timeout after send') r`, [id])).toMatchObject({ status: 'RECONCILIATION_REQUIRED' })
      expect(await treasury()).toBe(175)
      expect((await db.query(`select 1 from reconciliation_cases where entity_type = 'provider_payment' and entity_id = $1 and status = 'open'`, [id])).rows).toHaveLength(1)
      // found on chain later: recorded, then completed; the case closes
      await one(`select record_provider_payment_broadcast($1::uuid, 'FOUND') r`, [id])
      for (const to of ['CONFIRMING', 'CONFIRMED', 'PROVIDER_BALANCE_VERIFIED', 'COMPLETED']) await one(`select advance_provider_payment($1::uuid, $2::provider_payment_status_enum) r`, [id, to])
      expect((await db.query(`select 1 from reconciliation_cases where entity_id = $1 and status = 'open'`, [id])).rows).toHaveLength(0)
    })

    it('a completed or broadcast payment cannot be canceled (only before anything is sent)', async () => {
      const id = await approved(prov, 10)
      await validate(id)
      await one(`select create_provider_payment_instruction($1::uuid) r`, [id])
      await one(`select record_provider_payment_broadcast($1::uuid, 'B1') r`, [id])
      await expect(one(`select cancel_provider_payment($1::uuid, 'too late', null) r`, [id])).rejects.toThrow(/invalid provider payment transition/)
      expect(await treasury()).toBe(190)
    })
  })

  describe('approving a proposal (the overhauled flow)', () => {
    it('creates the payment from the server-side config, validates it and leaves the proposal pending if a limit refuses', async () => {
      const p = await one(`select create_topup_proposal($1::uuid, 25) r`, [prov])
      const r = await one(`select approve_topup_proposal($1::uuid, $2::uuid) r`, [p.id, admin])
      expect(r).toMatchObject({ status: 'approved', payment_status: 'VALIDATED' })
      const big = await one(`select create_topup_proposal($1::uuid, 99) r`, [prov2])
      await db.exec(`update providers set max_topup_per_tx = 50 where id = '${prov2}'`)
      await expect(one(`select approve_topup_proposal($1::uuid, $2::uuid) r`, [big.id, admin])).rejects.toThrow(/max_topup_per_tx_exceeded/)
      expect((await db.query<{ s: string }>(`select status::text s from topup_proposals where id = $1`, [big.id])).rows[0].s).toBe('pending')
      expect((await db.query(`select 1 from provider_payments where proposal_id = $1`, [big.id])).rows).toHaveLength(0)
    })
  })

  describe('admin configuration and access', () => {
    it('the payout config and the reserve are admin-only and audited', async () => {
      await db.exec(`set role authenticated; select set_config('request.jwt.sub', '${user}', false)`)
      await expect(db.query(`select admin_set_treasury_reserve(10)`)).rejects.toThrow(/forbidden/)
      await expect(db.query(`select admin_set_provider_payout($1::uuid, 'x', 'mainnet', 'TON', 1, 2)`, [prov])).rejects.toThrow(/forbidden/)
      await db.exec(`select set_config('request.jwt.sub', '${admin}', false)`)
      await db.query(`select admin_set_provider_payout($1::uuid, $2, 'mainnet', 'TON', 5, 20)`, [prov, OTHER_WALLET])
      await expect(db.query(`select admin_set_provider_payout($1::uuid, $2, 'mainnet', 'TON', 50, 20)`, [prov, OTHER_WALLET])).rejects.toThrow() // daily < per tx
      await expect(db.query(`select admin_set_treasury_reserve(-1)`)).rejects.toThrow()
      await db.exec('reset role')
      expect((await db.query(`select 1 from admin_audit_log where action = 'set_provider_payout'`)).rows).toHaveLength(1)
    })

    it('clients can neither read payments nor call the engine', async () => {
      const id = await approved(prov, 10)
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`reset role; set role ${role}; select set_config('request.jwt.sub', '${admin}', false)`)
        await expect(db.query(`select * from provider_payments`)).rejects.toThrow()
        await expect(db.query(`select validate_provider_payment($1::uuid)`, [id])).rejects.toThrow()
        await expect(db.query(`select record_provider_payment_broadcast($1::uuid, 'x')`, [id])).rejects.toThrow()
      }
      await db.exec('reset role')
      expect((await statusOf(id)).s).toBe('APPROVED')
    })
  })
})
