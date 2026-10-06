// TON deposit verification E2E: the PRODUCTION decision code (supabase/functions/_shared/deposit-verify.ts, the same
// module verify-deposit runs) against a REAL PostgreSQL, fed with simulated Toncenter v3 responses.
//
//   npm run test:ton
//
// Nothing touches a blockchain or a real wallet: hashes and addresses are mock values, the chain API is replaced by
// Toncenter-shaped JSON that goes through the real normaliser. The database is a throwaway PostgreSQL 17 (or a LOCAL
// Supabase via CONCURRENCY_DB_URL), see scripts/lib/real-postgres.ts. Exit code 1 if any check fails.

import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { verifyDeposit, type DepositRow, type VerifyOutcome, type VerifyPorts } from '../supabase/functions/_shared/deposit-verify.ts'
import { normalizeToncenterTransactions } from '../supabase/functions/_shared/ton.ts'
import { migrate, openDatabase } from './lib/real-postgres.ts'

const RECIPIENT = `0:${'ab'.repeat(32)}` // our (mock) deposit wallet
const ATTACKER_WALLET = `0:${'ee'.repeat(32)}`
const SENDER = `0:${'cd'.repeat(32)}`
const CONFIG = { network: 'mainnet' as const, recipient: RECIPIENT }
const TON = 1_000_000_000n
const HOLD_MS = 20

// ---------------------------------------------------------------------------
// Simulated chain: Toncenter /api/v3/transactions shape, normalised by the production code
// ---------------------------------------------------------------------------

const mockHash = () => randomBytes(32).toString('base64')
interface FakeTx { hash?: string; memo?: string | null; nano: bigint; to?: string; at?: number; bounced?: boolean; aborted?: boolean; bounce?: boolean }
function chain(...txs: FakeTx[]) {
  const json = {
    transactions: txs.map((t) => ({
      hash: t.hash ?? mockHash(),
      now: t.at ?? Math.floor(Date.now() / 1000),
      description: { aborted: t.aborted ?? false },
      in_msg: {
        source: SENDER, destination: t.to ?? RECIPIENT, value: t.nano.toString(), bounce: t.bounce ?? true, bounced: t.bounced ?? false,
        message_content: { decoded: t.memo === null || t.memo === undefined ? null : { type: 'text_comment', comment: t.memo } },
      },
    })),
  }
  return normalizeToncenterTransactions(json)
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

let admin: pg.Client
let pool: pg.Pool

async function newUser() {
  return (await admin.query<{ id: string }>(`insert into users(telegram_id) values ($1) returning id`, [Math.floor(Math.random() * 9e12) + 1e12])).rows[0].id
}
const memo = () => `dep_${randomBytes(16).toString('hex')}`
async function newDeposit(user: string, o: { ton?: string; usd?: number; network?: string; ageMin?: number; validMin?: number } = {}): Promise<DepositRow> {
  const r = await admin.query<DepositRow>(
    `insert into deposits(user_id, amount_usd, amount_crypto, asset, rate_usd, network, memo, recipient_address, valid_until, created_at)
     values ($1, $2, $3, 'TON', 5, $4, $5, $6, now() + make_interval(mins => $7), now() - make_interval(mins => $8))
     returning id, status, memo, recipient_address, amount_crypto::text, asset, network, created_at::text, valid_until::text`,
    [user, o.usd ?? 50, o.ton ?? '10', o.network ?? 'mainnet', memo(), RECIPIENT, o.validMin ?? 30, o.ageMin ?? 1])
  return r.rows[0]
}
const balance = async (user: string) => Number((await admin.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [user])).rows[0].b)
const depositState = async (id: string) => (await admin.query<{ status: string; tx_hash: string | null }>(`select status, tx_hash from deposits where id = $1`, [id])).rows[0]
const credits = async (id: string) => (await admin.query<{ n: number }>(`select count(*)::int n from wallet_transactions where reference_id = $1 and type = 'deposit'`, [id])).rows[0].n
const openCase = async (id: string) => (await admin.query<{ reason: string }>(`select reason from reconciliation_cases where entity_type = 'deposit' and entity_id = $1 and status = 'open'`, [id])).rows[0]?.reason ?? null

/** The verify-deposit ports, wired to the real database. Each completion runs on its own connection, in a
 *  transaction that holds its locks for HOLD_MS so concurrent verifications really overlap. */
function ports(transfers: ReturnType<typeof chain>): VerifyPorts {
  return {
    loadTransfers: async () => transfers,
    async completeDeposit({ depositId, txHash, senderRaw, receivedNano }) {
      const c = await pool.connect()
      try {
        await c.query('begin')
        await c.query(`select complete_deposit($1::uuid, $2, $3, $4::numeric)`, [depositId, txHash, senderRaw, receivedNano.toString()])
        await c.query('select pg_sleep($1)', [HOLD_MS / 1000])
        await c.query('commit')
      } catch (e) {
        await c.query('rollback').catch(() => {})
        throw e
      } finally {
        c.release()
      }
    },
    async flagIssue(depositId, reason) {
      await admin.query(`select flag_deposit_issue($1::uuid, $2)`, [depositId, reason])
    },
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(64)} ${JSON.stringify(actual)}${pass ? '' : `   (expected ${JSON.stringify(expected)})`}`)
}
const kind = (o: VerifyOutcome) => (o.kind === 'rejected' ? `rejected:${o.error}` : o.kind === 'completed' ? (o.already ? 'completed(already)' : 'completed') : o.kind)

// ---------------------------------------------------------------------------

async function main() {
  const db = await openDatabase()
  admin = new pg.Client({ connectionString: db.url })
  await admin.connect()
  pool = new pg.Pool({ connectionString: db.url, max: 40 })
  try {
    const version = (await admin.query<{ v: string }>(`select current_setting('server_version') v`)).rows[0].v
    const migrations = db.embedded ? await migrate(admin) : 'already applied (local Supabase)'
    console.log(`Real PostgreSQL ${version} (${db.embedded ? 'embedded, throwaway' : 'local Supabase'}), migrations: ${migrations}`)
    console.log('Chain: simulated Toncenter v3 payloads (mock hashes/addresses) through the production normaliser and verifyDeposit()\n')

    // ---- A. valid deposit ----------------------------------------------------------------------
    console.log('A. Valid deposit: intent 10 TON / $50, transfer of exactly 10 TON with the right memo')
    const uA = await newUser()
    const dA = await newDeposit(uA)
    const txA = mockHash()
    const oA = await verifyDeposit(dA, CONFIG, ports(chain({ hash: txA, memo: dA.memo, nano: 10n * TON })))
    check('outcome', kind(oA), 'completed')
    check('wallet credited with the quoted USD amount', await balance(uA), 50)
    check('deposit completed with the chain tx hash', await depositState(dA.id), { status: 'completed', tx_hash: txA })
    check('ledger deposit entries', await credits(dA.id), 1)

    // ---- B. replay -----------------------------------------------------------------------------
    console.log('\nB. Replay: the same transaction hash used again')
    const reA = { ...dA, status: (await depositState(dA.id)).status }
    check('re-verifying the credited deposit is a no-op', kind(await verifyDeposit(reA, CONFIG, ports(chain({ hash: txA, memo: dA.memo, nano: 10n * TON })))), 'completed(already)')
    check('...and credits nothing more', [await balance(uA), await credits(dA.id)], [50, 1])
    const uB = await newUser()
    const dB = await newDeposit(uB)
    // the attacker's chain view: a transfer carrying B's memo but A's (already used) hash
    const oB = await verifyDeposit(dB, CONFIG, ports(chain({ hash: txA, memo: dB.memo, nano: 10n * TON })))
    check('a second deposit claiming an used tx hash is rejected', kind(oB), 'rejected:tx_already_used')
    check('...nothing credited, deposit still pending', [await balance(uB), (await depositState(dB.id)).status], [0, 'pending'])
    check('...and it is flagged for reconciliation', (await openCase(dB.id))?.startsWith(`tx ${txA}`) ?? false, true)
    let direct = ''
    try { await admin.query(`select complete_deposit($1::uuid, $2)`, [dB.id, txA]) } catch (e) { direct = (e as Error).message }
    check('direct database call with the used hash also refused', /tx_already_used/.test(direct), true)
    // client-supplied hashes are never trusted: A's tx (A's memo) cannot pay B
    check("A's transfer (A's memo) never matches B's intent", kind(await verifyDeposit(dB, CONFIG, ports(chain({ hash: txA, memo: dA.memo, nano: 10n * TON })))), 'pending')

    // ---- C. wrong amount -----------------------------------------------------------------------
    console.log('\nC. Wrong amount: intent 10 TON, transfer of 5 TON')
    const uC = await newUser()
    const dC = await newDeposit(uC)
    const oC = await verifyDeposit(dC, CONFIG, ports(chain({ memo: dC.memo, nano: 5n * TON })))
    check('outcome', kind(oC), 'rejected:underpaid')
    check('NOTHING credited (not 5 TON worth, not 10)', [await balance(uC), await credits(dC.id)], [0, 0])
    check('deposit stays pending', (await depositState(dC.id)).status, 'pending')
    check('flagged for reconciliation, naming what was received', /^underpaid: received 5(\.0+)? TON of 10/.test((await openCase(dC.id)) ?? ''), true)
    let dbUnder = ''
    try { await admin.query(`select complete_deposit($1::uuid, $2, null, $3::numeric)`, [dC.id, mockHash(), (5n * TON).toString()]) } catch (e) { dbUnder = (e as Error).message }
    check('database refuses an underpaid completion by itself', /underpaid/.test(dbUnder), true)
    check('one nanoton short is still underpaid', kind(await verifyDeposit(dC, CONFIG, ports(chain({ memo: dC.memo, nano: 10n * TON - 1n })))), 'rejected:underpaid')
    const uC2 = await newUser()
    const dC2 = await newDeposit(uC2)
    check('overpayment (12 TON) is accepted...', kind(await verifyDeposit(dC2, CONFIG, ports(chain({ memo: dC2.memo, nano: 12n * TON })))), 'completed')
    check('...and credits exactly the quoted $50, no more', await balance(uC2), 50)

    // ---- D. wrong / missing memo and other mismatches ------------------------------------------
    console.log('\nD. Wrong or missing memo, wrong recipient, wrong network, bounced, late')
    const uD = await newUser()
    const dD = await newDeposit(uD)
    const pendingFor = async (label: string, ...txs: FakeTx[]) => check(label, kind(await verifyDeposit(dD, CONFIG, ports(chain(...txs)))), 'pending')
    await pendingFor('no memo at all', { memo: null, nano: 10n * TON })
    await pendingFor('another memo', { memo: memo(), nano: 10n * TON })
    await pendingFor('the memo in upper case', { memo: dD.memo.toUpperCase(), nano: 10n * TON })
    await pendingFor('the memo with a trailing space', { memo: `${dD.memo} `, nano: 10n * TON })
    await pendingFor('right memo, sent to another wallet', { memo: dD.memo, nano: 10n * TON, to: ATTACKER_WALLET })
    await pendingFor('right memo, bounced back to the sender', { memo: dD.memo, nano: 10n * TON, bounced: true })
    await pendingFor('right memo, bounceable and aborted (value bounced)', { memo: dD.memo, nano: 10n * TON, aborted: true, bounce: true })
    check('none of these credited anything', [await balance(uD), (await depositState(dD.id)).status], [0, 'pending'])
    const uN = await newUser()
    const dN = await newDeposit(uN, { network: 'testnet' })
    check('a testnet intent cannot be paid while verifying on mainnet', kind(await verifyDeposit(dN, CONFIG, ports(chain({ memo: dN.memo, nano: 10n * TON })))), 'rejected:network_mismatch')
    check('...nothing credited', await balance(uN), 0)
    const uL = await newUser()
    const dL = await newDeposit(uL, { ageMin: 120, validMin: -90 }) // expired 90 minutes ago
    check('a payment after expiry is rejected', kind(await verifyDeposit(dL, CONFIG, ports(chain({ memo: dL.memo, nano: 10n * TON })))), 'rejected:payment_expired')
    check('...nothing credited, flagged for reconciliation', [await balance(uL), (await openCase(dL.id))?.startsWith('paid outside') ?? false], [0, true])

    // ---- E. concurrency ------------------------------------------------------------------------
    console.log(`\nE. Concurrency: 10 simultaneous verifications of the same unverified deposit (each completion holds its locks ${HOLD_MS} ms)`)
    const uE = await newUser()
    const dE = await newDeposit(uE)
    const txE = chain({ memo: dE.memo, nano: 10n * TON })
    let peakWaiters = 0
    let sampling = true
    const sampler = new pg.Client({ connectionString: db.url })
    await sampler.connect()
    const sample = (async () => {
      while (sampling) {
        const r = await sampler.query<{ n: number }>(`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)
        peakWaiters = Math.max(peakWaiters, r.rows[0].n)
      }
    })()
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => verifyDeposit(dE, CONFIG, ports(txE))))
    sampling = false
    await sample
    await sampler.end()
    const kinds = results.map((r) => (r.status === 'fulfilled' ? kind(r.value) : `error:${(r.reason as Error).message}`))
    console.log(`  outcomes: ${JSON.stringify(Object.fromEntries([...new Set(kinds)].map((k) => [k, kinds.filter((x) => x === k).length])))} | peak sessions waiting on a lock: ${peakWaiters}`)
    check('every request ends "completed" (none errors)', kinds.every((k) => k === 'completed'), true)
    check('wallet credited exactly once', await balance(uE), 50)
    check('exactly one ledger credit', await credits(dE.id), 1)
    check('deposit completed', (await depositState(dE.id)).status, 'completed')

    console.log('\nE2. Two different deposits racing for the same transaction hash (10 attempts each, interleaved)')
    const u1 = await newUser(), u2 = await newUser()
    const d1 = await newDeposit(u1), d2 = await newDeposit(u2)
    const shared = mockHash()
    const r2 = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => {
      const d = i % 2 ? d1 : d2
      return verifyDeposit(d, CONFIG, ports(chain({ hash: shared, memo: d.memo, nano: 10n * TON })))
    }))
    const k2 = r2.map((r) => (r.status === 'fulfilled' ? kind(r.value) : 'error'))
    console.log(`  outcomes: ${JSON.stringify(Object.fromEntries([...new Set(k2)].map((k) => [k, k2.filter((x) => x === k).length])))}`)
    const won = [(await depositState(d1.id)).status, (await depositState(d2.id)).status].filter((s) => s === 'completed').length
    check('exactly one of the two deposits got the transaction', won, 1)
    check('total credited across both users = one deposit ($50)', (await balance(u1)) + (await balance(u2)), 50)
    check('no request crashed', k2.includes('error'), false)

    // ---- ledger integrity ----------------------------------------------------------------------
    console.log('\nLedger integrity')
    const bad = await admin.query<{ n: number }>(
      `select count(*)::int n from wallets w where w.balance < 0 or w.balance <> (select coalesce(sum(amount), 0) from wallet_transactions t where t.wallet_id = w.id and t.status = 'completed')`)
    check('every wallet = sum of its ledger, none negative', bad.rows[0].n, 0)
    const dup = await admin.query<{ n: number }>(`select count(*)::int n from (select tx_hash from deposits where tx_hash is not null group by tx_hash having count(*) > 1) x`)
    check('no transaction hash funds two deposits', dup.rows[0].n, 0)
  } finally {
    await pool.end().catch(() => {})
    await admin.end().catch(() => {})
    await db.stop()
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ton e2e crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})

