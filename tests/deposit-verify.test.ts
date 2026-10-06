import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { amountToNano, verifyDeposit, type DepositRow, type VerifyPorts } from '../supabase/functions/_shared/deposit-verify.ts'
import type { ChainTransfer } from '../supabase/functions/_shared/ton.ts'

const RECIPIENT = `0:${'ab'.repeat(32)}`
const MEMO = `dep_${'1'.repeat(32)}`
const NOW = Math.floor(Date.now() / 1000)
const TON = 1_000_000_000n

const deposit = (over: Partial<DepositRow> = {}): DepositRow => ({
  id: 'd1', status: 'pending', memo: MEMO, recipient_address: RECIPIENT, amount_crypto: '10.000000000', asset: 'TON', network: 'mainnet',
  created_at: new Date((NOW - 60) * 1000).toISOString(), valid_until: new Date((NOW + 1800) * 1000).toISOString(), ...over,
})
const transfer = (over: Partial<ChainTransfer> = {}): ChainTransfer => ({
  hash: 'H1', utime: NOW, source: `0:${'cd'.repeat(32)}`, destination: RECIPIENT, valueBase: 10n * TON, comment: MEMO, success: true, ...over,
})
function ports(transfers: ChainTransfer[] | Error, completeError?: string) {
  const calls = { complete: [] as unknown[], flags: [] as string[] }
  const p: VerifyPorts = {
    loadTransfers: async () => { if (transfers instanceof Error) throw transfers; return transfers },
    completeDeposit: async (a) => { calls.complete.push(a); if (completeError) throw new Error(completeError) },
    flagIssue: async (_id, reason) => { calls.flags.push(reason) },
  }
  return { p, calls }
}
const CONFIG = { network: 'mainnet' as const, recipient: RECIPIENT }

describe('verifyDeposit (the decision verify-deposit runs)', () => {
  it('credits a matching transfer, passing the RECEIVED amount to the database', async () => {
    const { p, calls } = ports([transfer({ valueBase: 12n * TON })])
    expect(await verifyDeposit(deposit(), CONFIG, p)).toEqual({ kind: 'completed', already: false, txHash: 'H1' })
    expect(calls.complete).toEqual([{ depositId: 'd1', txHash: 'H1', senderRaw: `0:${'cd'.repeat(32)}`, receivedNano: 12n * TON }])
  })

  it('an already completed deposit is a no-op (no chain lookup, no credit)', async () => {
    const { p, calls } = ports(new Error('must not be called'))
    expect(await verifyDeposit(deposit({ status: 'completed' }), CONFIG, p)).toEqual({ kind: 'completed', already: true })
    expect(calls.complete).toEqual([])
  })

  it('refuses a deposit created for another network', async () => {
    const { p, calls } = ports([transfer()])
    expect(await verifyDeposit(deposit({ network: 'testnet' }), CONFIG, p)).toMatchObject({ kind: 'rejected', error: 'network_mismatch', httpStatus: 409 })
    expect(calls.complete).toEqual([])
  })

  it('refuses when the intent was made out to a different recipient than ours', async () => {
    const { p } = ports([transfer()])
    expect(await verifyDeposit(deposit({ recipient_address: `0:${'ff'.repeat(32)}` }), CONFIG, p)).toMatchObject({ error: 'server_misconfigured' })
  })

  it('underpaid: no credit, flagged with what was received', async () => {
    const { p, calls } = ports([transfer({ valueBase: 5n * TON })])
    expect(await verifyDeposit(deposit(), CONFIG, p)).toMatchObject({ kind: 'rejected', error: 'underpaid', flagged: true, extra: { received: '5.000000000', required: '10.000000000' } })
    expect(calls.complete).toEqual([])
    expect(calls.flags[0]).toMatch(/^underpaid: received 5.000000000 TON of 10.000000000 in tx H1/)
  })

  it('missing or wrong memo: stays pending, never credits', async () => {
    for (const comment of [null, `dep_${'2'.repeat(32)}`, MEMO.toUpperCase(), ` ${MEMO}`]) {
      const { p, calls } = ports([transfer({ comment })])
      expect(await verifyDeposit(deposit(), CONFIG, p)).toEqual({ kind: 'pending' })
      expect(calls.complete).toEqual([])
    }
  })

  it('late payment: rejected and flagged', async () => {
    const { p, calls } = ports([transfer({ utime: NOW + 7200 })])
    expect(await verifyDeposit(deposit(), CONFIG, p)).toMatchObject({ error: 'payment_expired', flagged: true })
    expect(calls.flags).toHaveLength(1)
  })

  it('a hash already used by another deposit is rejected and flagged (also the raw unique-index error)', async () => {
    for (const msg of ['tx_already_used: transaction already credited', 'duplicate key value violates unique constraint "deposits_tx_hash_key"']) {
      const { p, calls } = ports([transfer()], msg)
      expect(await verifyDeposit(deposit(), CONFIG, p)).toMatchObject({ error: 'tx_already_used', httpStatus: 409, flagged: true })
      expect(calls.flags).toHaveLength(1)
    }
  })

  it('the database refusing an underpayment is reported as underpaid', async () => {
    const { p } = ports([transfer()], 'underpaid: received 1 nanoton, required 10000000000')
    expect(await verifyDeposit(deposit(), CONFIG, p)).toMatchObject({ error: 'underpaid' })
  })

  it('an unreachable chain API is a 502, nothing credited; unknown database errors propagate', async () => {
    expect(await verifyDeposit(deposit(), CONFIG, ports(new Error('timeout')).p)).toMatchObject({ httpStatus: 502, error: 'chain_unavailable' })
    await expect(verifyDeposit(deposit(), CONFIG, ports([transfer()], 'connection reset').p)).rejects.toThrow('connection reset')
  })

  it('amountToNano parses NUMERIC(20,9) exactly', () => {
    expect(amountToNano('10')).toBe(10n * TON)
    expect(amountToNano('0.000000001')).toBe(1n)
    expect(amountToNano('1.5')).toBe(1_500_000_000n)
    expect(() => amountToNano('1e3')).toThrow()
  })
})

describe('complete_deposit / flag_deposit_issue (real SQL)', () => {
  let db: PGlite
  let user: string
  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (1) returning id`)).rows[0].id
  }, 120_000)

  const newDeposit = async (memo: string) => (await db.query<{ id: string }>(
    `insert into deposits(user_id, amount_usd, amount_crypto, rate_usd, memo, recipient_address, valid_until) values ($1, 50, 10, 5, $2, $3, now() + interval '30 minutes') returning id`,
    [user, memo, RECIPIENT])).rows[0].id
  const balance = async () => Number((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [user])).rows[0].b)

  it('credits once, refuses underpayment by itself and keeps old 3-argument calls working', async () => {
    const d = await newDeposit(MEMO)
    await expect(db.query(`select complete_deposit($1::uuid, 'H', null, 9999999999)`, [d])).rejects.toThrow(/underpaid/)
    expect(await balance()).toBe(0)
    await db.query(`select complete_deposit($1::uuid, 'H', null, 10000000000)`, [d])
    await db.query(`select complete_deposit($1::uuid, 'H')`, [d]) // replay, 3 args
    expect(await balance()).toBe(50)
  })

  it('validates the transaction hash and refuses a hash used by another deposit', async () => {
    const d1 = await newDeposit(MEMO)
    const d2 = await newDeposit(`dep_${'2'.repeat(32)}`)
    for (const bad of ['', 'a b', 'x'.repeat(129)]) await expect(db.query(`select complete_deposit($1::uuid, $2)`, [d1, bad])).rejects.toThrow(/tx hash/)
    await db.query(`select complete_deposit($1::uuid, 'SAME')`, [d1])
    await expect(db.query(`select complete_deposit($1::uuid, 'SAME')`, [d2])).rejects.toThrow(/tx_already_used/)
  })

  it('flag_deposit_issue opens one open case per deposit and refreshes its reason', async () => {
    const d = await newDeposit(MEMO)
    await db.query(`select flag_deposit_issue($1::uuid, 'underpaid: first')`, [d])
    await db.query(`select flag_deposit_issue($1::uuid, 'underpaid: second')`, [d])
    const cases = (await db.query<{ reason: string }>(`select reason from reconciliation_cases where entity_type = 'deposit' and entity_id = $1`, [d])).rows
    expect(cases).toEqual([{ reason: 'underpaid: second' }])
    await expect(db.query(`select flag_deposit_issue(gen_random_uuid(), 'x')`)).rejects.toThrow(/not found/)
  })

  it('clients cannot call either function', async () => {
    await db.exec(`set role authenticated`)
    await expect(db.query(`select complete_deposit(gen_random_uuid(), 'H')`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select flag_deposit_issue(gen_random_uuid(), 'x')`)).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
  })
})
