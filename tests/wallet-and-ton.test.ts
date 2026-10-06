import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { Address, Cell, beginCell } from '@ton/core'
import { describe, expect, it } from 'vitest'
import {
  ASSET_DECIMALS,
  MAX_DEPOSIT_USD,
  addressesEqual,
  buildCommentBocBase64,
  findMatchingTransfer,
  formatBaseUnits,
  generateMemo,
  normalizeToncenterTransactions,
  parseCoinGeckoTonUsd,
  parseTonAddress,
  parseUsdInput,
  quoteDeposit,
  toRawAddress,
  validateDepositAmountUsd,
  MEMO_RE,
  type ChainTransfer,
  type DepositForMatch,
} from '../supabase/functions/_shared/ton.ts'
import { LEDGER_FILTERS, matchesLedgerFilter } from '../src/lib/ledger-view'
import { buildTransactionRequest, shortAddress, trimCrypto } from '../src/lib/ton'
import { DepositApiError } from '../src/services/api/deposit-errors'
import { OrderApiError } from '../src/services/api/order-errors'
import { createMockBackend, MOCK_TON_USD_RATE } from '../src/services/api/mock-orders'
import { MOCK_CATALOG } from '../src/constants/dev'
import type { LedgerType } from '../src/types/wallet'

// ---------------------------------------------------------------------------
// 1. Amount conversions and nanoton calculations
// ---------------------------------------------------------------------------

describe('deposit amount validation', () => {
  it.each([
    [1, true], [10, true], [12.5, true], [499.99, true], [500, true],
    [0.99, false], [0, false], [-5, false], [500.01, false], [1000, false],
    [10.005, false], [1.234, false], [Number.NaN, false], [Number.POSITIVE_INFINITY, false],
  ])('$%s -> ok=%s', (usd, ok) => {
    expect(validateDepositAmountUsd(usd).ok).toBe(ok)
  })

  it('rejects non-numbers and returns whole cents', () => {
    for (const bad of ['10', null, undefined, {}, [10]]) expect(validateDepositAmountUsd(bad).ok).toBe(false)
    expect(validateDepositAmountUsd(12.34)).toEqual({ ok: true, value: 1234 })
    expect(validateDepositAmountUsd(0.1 + 0.2 + 1)).toEqual({ ok: true, value: 130 }) // float noise is not a 3rd decimal
  })

  it('parses user input', () => {
    expect(parseUsdInput('10')).toBe(10)
    expect(parseUsdInput('$12.50')).toBe(12.5)
    expect(parseUsdInput(' 1,000 ')).toBe(1000)
    for (const bad of ['', 'abc', '1.2.3', '-5', '.5']) expect(parseUsdInput(bad)).toBeNull()
  })
})

describe('quoteDeposit: USD -> crypto in exact base units', () => {
  it('$10 at $5/TON = 2 TON = 2,000,000,000 nanoton', () => {
    const q = quoteDeposit(10, 5)
    expect(q.amountBase).toBe(2_000_000_000n)
    expect(q.amountCrypto).toBe('2.000000000')
    expect(q).toMatchObject({ asset: 'TON', amountUsd: 10, rateUsd: 5 })
  })

  it.each([
    [1, 5, 200_000_000n],
    [25, 5, 5_000_000_000n],
    [100, 2.5, 40_000_000_000n],
    [7.5, 3, 2_500_000_000n],
    [500, 4, 125_000_000_000n],
  ] as [number, number, bigint][])('$%s at $%s/TON -> %s nano', (usd, rate, nano) => {
    expect(quoteDeposit(usd, rate).amountBase).toBe(nano)
  })

  it('rounds UP to the next nanoton, so the user can never underpay the quote', () => {
    const q = quoteDeposit(1, 3) // 1/3 TON = 333,333,333.33 nano
    expect(q.amountBase).toBe(333_333_334n)
    expect(q.amountCrypto).toBe('0.333333334')
  })

  it('never underpays and overshoots by less than one unit (randomised)', () => {
    let seed = 42
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32)
    for (let i = 0; i < 500; i++) {
      const cents = 100 + Math.floor(rnd() * 49_901)
      const rate = Math.round((0.5 + rnd() * 40) * 1e6) / 1e6
      const q = quoteDeposit(cents / 100, rate)
      const rateMicro = BigInt(Math.round(rate * 1e6))
      const exact = BigInt(cents) * 10n ** 13n // value * rateMicro must reach this
      expect(q.amountBase * rateMicro >= exact).toBe(true)
      expect((q.amountBase - 1n) * rateMicro < exact).toBe(true)
    }
  })

  it('supports USDT (6 decimals) for future use', () => {
    const q = quoteDeposit(10, 1, 'USDT')
    expect(q.amountBase).toBe(10_000_000n)
    expect(q.amountCrypto).toBe('10.000000')
    expect(ASSET_DECIMALS).toEqual({ TON: 9, USDT: 6 })
  })

  it('rejects out-of-range amounts and bad rates', () => {
    expect(() => quoteDeposit(0.5, 5)).toThrow(RangeError)
    expect(() => quoteDeposit(MAX_DEPOSIT_USD + 1, 5)).toThrow(RangeError)
    expect(() => quoteDeposit(10, 0)).toThrow(RangeError)
    expect(() => quoteDeposit(10, -1)).toThrow(RangeError)
    expect(() => quoteDeposit(10, Number.NaN)).toThrow(RangeError)
  })

  it('formats base units without floats', () => {
    expect(formatBaseUnits(1n, 9)).toBe('0.000000001')
    expect(formatBaseUnits(123_456_789_012n, 9)).toBe('123.456789012')
    expect(formatBaseUnits(5n, 6)).toBe('0.000005')
    expect(trimCrypto('2.000000000')).toBe('2')
    expect(trimCrypto('0.123450000')).toBe('0.12345')
  })

  it('accepts only sane CoinGecko rates', () => {
    expect(parseCoinGeckoTonUsd({ 'the-open-network': { usd: 5.12 } })).toBe(5.12)
    for (const bad of [{}, null, { 'the-open-network': {} }, { 'the-open-network': { usd: 0 } }, { 'the-open-network': { usd: 1e9 } }, { 'the-open-network': { usd: '5' } }]) {
      expect(parseCoinGeckoTonUsd(bad)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Memo uniqueness and verification logic
// ---------------------------------------------------------------------------

describe('memo generation', () => {
  it('has the dep_<32 hex> format and is unique across many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i++) {
      const memo = generateMemo()
      expect(memo).toMatch(MEMO_RE)
      seen.add(memo)
    }
    expect(seen.size).toBe(20_000)
  })
})

const RECIPIENT = Address.parse('EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2').toString({ bounceable: false })
const RECIPIENT_RAW = Address.parse(RECIPIENT).toRawString()
const OTHER = new Address(0, Buffer.alloc(32, 7)).toString({ bounceable: false })
const SENDER_RAW = new Address(0, Buffer.alloc(32, 9)).toRawString()

const MEMO = 'dep_' + 'a'.repeat(32)
const T0 = 1_800_000_000
const deposit = (over: Partial<DepositForMatch> = {}): DepositForMatch => ({
  memo: MEMO, recipientAddress: RECIPIENT, amountBase: 2_000_000_000n, createdAtSec: T0, validUntilSec: T0 + 1800, ...over,
})
const transfer = (over: Partial<ChainTransfer> = {}): ChainTransfer => ({
  hash: 'HASH-1', utime: T0 + 60, source: SENDER_RAW, destination: RECIPIENT_RAW,
  valueBase: 2_000_000_000n, comment: MEMO, success: true, ...over,
})

describe('findMatchingTransfer (memo / recipient / amount / window)', () => {
  it('matches an exact, successful, correctly addressed and sufficient payment', () => {
    const r = findMatchingTransfer([transfer()], deposit())
    expect(r).toMatchObject({ found: true, transfer: { hash: 'HASH-1' } })
  })

  it('accepts overpayment and any address format of the same wallet', () => {
    expect(findMatchingTransfer([transfer({ valueBase: 9_000_000_000n })], deposit()).found).toBe(true)
    expect(findMatchingTransfer([transfer({ destination: RECIPIENT })], deposit({ recipientAddress: RECIPIENT_RAW })).found).toBe(true)
    expect(findMatchingTransfer([transfer({ destination: Address.parse(RECIPIENT).toString({ bounceable: true }) })], deposit()).found).toBe(true)
  })

  describe('rejects everything that is not exactly this deposit', () => {
    it.each([
      ['no comment', transfer({ comment: null })],
      ['empty comment', transfer({ comment: '' })],
      ['another deposit\'s memo', transfer({ comment: 'dep_' + 'b'.repeat(32) })],
      ['memo with different case', transfer({ comment: MEMO.toUpperCase() })],
      ['memo with extra suffix', transfer({ comment: MEMO + 'x' })],
      ['memo with surrounding space', transfer({ comment: ` ${MEMO} ` })],
      ['memo as a prefix of a longer text', transfer({ comment: `${MEMO} thanks` })],
      ['plain random transfer', transfer({ comment: 'hello' })],
      ['paid to someone else', transfer({ destination: OTHER })],
      ['no destination', transfer({ destination: null })],
      ['aborted / failed tx', transfer({ success: false })],
    ])('%s', (_name, t) => {
      expect(findMatchingTransfer([t], deposit())).toMatchObject({ found: false, reason: 'not_found' })
    })
  })

  it('reports underpayment instead of crediting', () => {
    const r = findMatchingTransfer([transfer({ valueBase: 1_999_999_999n })], deposit())
    expect(r).toMatchObject({ found: false, reason: 'underpaid' })
  })

  it('enforces the time window (with a small clock-skew allowance)', () => {
    expect(findMatchingTransfer([transfer({ utime: T0 - 60 })], deposit()).found).toBe(true) // within skew
    expect(findMatchingTransfer([transfer({ utime: T0 - 3600 })], deposit())).toMatchObject({ found: false, reason: 'outside_window' })
    expect(findMatchingTransfer([transfer({ utime: T0 + 1800 + 60 })], deposit()).found).toBe(true)
    expect(findMatchingTransfer([transfer({ utime: T0 + 1800 + 3600 })], deposit())).toMatchObject({ found: false, reason: 'outside_window' })
  })

  it('picks the earliest valid payment when the memo was paid more than once', () => {
    const r = findMatchingTransfer([transfer({ hash: 'LATE', utime: T0 + 500 }), transfer({ hash: 'EARLY', utime: T0 + 100 })], deposit())
    expect(r).toMatchObject({ found: true, transfer: { hash: 'EARLY' } })
  })

  it('a transaction paying deposit A can never satisfy deposit B', () => {
    const paysA = transfer({ comment: MEMO })
    const depositB = deposit({ memo: 'dep_' + 'c'.repeat(32) })
    expect(findMatchingTransfer([paysA], depositB).found).toBe(false)
  })

  it('falls back to a later valid payment if an earlier one was underpaid', () => {
    const r = findMatchingTransfer([transfer({ hash: 'SMALL', utime: T0 + 10, valueBase: 1n }), transfer({ hash: 'FULL', utime: T0 + 20 })], deposit())
    expect(r).toMatchObject({ found: true, transfer: { hash: 'FULL' } })
  })
})

describe('Toncenter response normalisation', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    hash: 'abc=', now: T0 + 5, description: { aborted: false },
    in_msg: { source: SENDER_RAW, destination: RECIPIENT_RAW, value: '2000000000', message_content: { decoded: { type: 'text_comment', comment: MEMO } } },
    ...over,
  })

  it('maps a text-comment transfer', () => {
    expect(normalizeToncenterTransactions({ transactions: [tx()] })).toEqual([
      { hash: 'abc=', utime: T0 + 5, source: SENDER_RAW, destination: RECIPIENT_RAW, valueBase: 2_000_000_000n, comment: MEMO, success: true },
    ])
  })

  it('skips external messages, flags aborted txs and ignores non-text bodies', () => {
    const external = tx({ in_msg: { source: null, destination: RECIPIENT_RAW, value: null } })
    const aborted = tx({ hash: 'bad', description: { aborted: true } })
    const binary = tx({ hash: 'bin', in_msg: { source: SENDER_RAW, destination: RECIPIENT_RAW, value: '5', message_content: { decoded: { type: 'jetton_notify' } } } })
    const out = normalizeToncenterTransactions({ transactions: [external, aborted, binary] })
    expect(out.map((t) => t.hash)).toEqual(['bad', 'bin'])
    expect(out[0].success).toBe(false)
    expect(out[1].comment).toBeNull()
  })

  it('treats a missing aborted flag as NOT successful (fail closed) and bad values as invalid', () => {
    const noFlag = tx({ description: {} })
    expect(normalizeToncenterTransactions({ transactions: [noFlag] })[0].success).toBe(false)
    expect(normalizeToncenterTransactions({ transactions: [tx({ in_msg: { source: SENDER_RAW, destination: RECIPIENT_RAW, value: 'NaN' } })] })).toEqual([])
  })

  describe('what counts as "the value reached our wallet" (rule verified against real Toncenter data)', () => {
    const incoming = (inMsg: Record<string, unknown>, description: Record<string, unknown>) =>
      normalizeToncenterTransactions({
        transactions: [{
          hash: 'h=', now: T0 + 5, description,
          in_msg: { source: SENDER_RAW, destination: RECIPIENT_RAW, value: '2883568391', message_content: { decoded: { type: 'text_comment', comment: MEMO } }, ...inMsg },
        }],
      })[0]

    it('non-bounceable transfer to a fresh / uninitialised wallet: aborted=true, compute skipped, yet the funds ARE credited', () => {
      const t = incoming({ bounce: false, bounced: false }, { aborted: true, compute_ph: { type: 'skipped', skipped_reason: 'no_state' } })
      expect(t.success).toBe(true)
    })

    it('non-bounceable transfer that the wallet code rejected (compute failed): still credited', () => {
      expect(incoming({ bounce: false, bounced: false }, { aborted: true, compute_ph: { success: false } }).success).toBe(true)
    })

    it('bounceable transfer: counts only when the transaction was not aborted (otherwise it bounced back to the sender)', () => {
      expect(incoming({ bounce: true, bounced: false }, { aborted: false, compute_ph: { success: true } }).success).toBe(true)
      expect(incoming({ bounce: true, bounced: false }, { aborted: true, compute_ph: { type: 'skipped', skipped_reason: 'no_state' } }).success).toBe(false)
    })

    it('a message that is itself a bounce coming back is a refund to us, never a payment', () => {
      expect(incoming({ bounce: false, bounced: true }, { aborted: false }).success).toBe(false)
      expect(incoming({ bounced: true }, { aborted: false }).success).toBe(false)
    })

    it('unclear data (no bounce flag) falls back to the strict rule', () => {
      expect(incoming({}, { aborted: true }).success).toBe(false)
      expect(incoming({}, { aborted: false }).success).toBe(true)
      expect(incoming({}, {}).success).toBe(false)
    })

    it('end to end: a deposit sent to a brand-new wallet is matched, a bounced-back copy of it is not', () => {
      const deposit = { memo: MEMO, recipientAddress: RECIPIENT, amountBase: 2_000_000_000n, createdAtSec: T0, validUntilSec: T0 + 1800 }
      const paid = incoming({ bounce: false, bounced: false }, { aborted: true, compute_ph: { type: 'skipped', skipped_reason: 'no_state' } })
      expect(findMatchingTransfer([paid], deposit)).toMatchObject({ found: true })
      const refundedBack = incoming({ bounce: false, bounced: true }, { aborted: false })
      expect(findMatchingTransfer([refundedBack], deposit)).toMatchObject({ found: false, reason: 'not_found' })
    })
  })

  it('throws on an unexpected payload', () => {
    expect(() => normalizeToncenterTransactions({ error: 'rate limited' })).toThrow()
    expect(() => normalizeToncenterTransactions(null)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// TON primitives cross-checked against the reference library
// ---------------------------------------------------------------------------

describe('TON addresses (cross-checked with @ton/core)', () => {
  const variants = (a: Address) => [
    a.toString({ bounceable: true }), a.toString({ bounceable: false }),
    a.toString({ bounceable: true, testOnly: true }), a.toString({ urlSafe: false }), a.toRawString(),
  ]
  it.each([new Address(0, Buffer.from('11'.repeat(32), 'hex')), new Address(-1, Buffer.from('ab'.repeat(32), 'hex')), Address.parse(RECIPIENT)])(
    'parses every format of %s',
    (addr) => {
      for (const s of variants(addr)) {
        expect(toRawAddress(s)).toBe(addr.toRawString().toLowerCase())
        expect(parseTonAddress(s).hash).toBe(addr.hash.toString('hex'))
      }
    },
  )

  it('compares across formats and rejects corrupted or foreign addresses', () => {
    const a = Address.parse(RECIPIENT)
    expect(addressesEqual(a.toString({ bounceable: true }), a.toRawString())).toBe(true)
    expect(addressesEqual(a.toRawString(), OTHER)).toBe(false)
    const friendly = a.toString()
    const corrupted = friendly.slice(0, -2) + (friendly.endsWith('A') ? 'BB' : 'AA')
    expect(() => parseTonAddress(corrupted)).toThrow()
    for (const junk of ['', 'hello', '0:xyz', 'EQ' + 'A'.repeat(46)]) expect(() => parseTonAddress(junk)).toThrow()
    expect(addressesEqual('junk', a.toRawString())).toBe(false)
  })

  it('shortens addresses for display', () => {
    expect(shortAddress('UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG')).toBe('UQBv…ggGG')
    expect(shortAddress('short')).toBe('short')
  })
})

describe('comment payload BOC (cross-checked with @ton/core)', () => {
  const decode = (b64: string) => {
    const slice = Cell.fromBase64(b64).beginParse()
    expect(slice.loadUint(32)).toBe(0) // text-comment opcode
    return slice.loadStringTail()
  }

  it.each([MEMO, 'dep_' + '0123456789abcdef'.repeat(2), 'x', 'Привіт 👋', 'a'.repeat(123)])('round-trips %j', (text) => {
    expect(decode(buildCommentBocBase64(text))).toBe(text)
  })

  it('is byte-identical to what @ton/core produces', () => {
    const reference = beginCell().storeUint(0, 32).storeStringTail(MEMO).endCell().toBoc({ idx: false, crc32: false }).toString('base64')
    expect(buildCommentBocBase64(MEMO)).toBe(reference)
  })

  it('refuses text that does not fit one cell', () => {
    expect(() => buildCommentBocBase64('a'.repeat(124))).toThrow(RangeError)
  })
})

describe('Tonkeeper sendTransaction request', () => {
  const intent = { recipientAddress: RECIPIENT, amountNano: '2000000000', memo: MEMO, validUntil: 2_000_000_000, network: 'mainnet' as const }

  it('targets our recipient with the quoted nanoton amount and the memo as comment payload', () => {
    const req = buildTransactionRequest(intent, 1_900_000_000)
    expect(req.network).toBe('-239')
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]).toMatchObject({ address: RECIPIENT, amount: '2000000000' })
    expect(Cell.fromBase64(req.messages[0].payload).beginParse().skip(32).loadStringTail()).toBe(MEMO)
  })

  it('caps validity at 10 minutes, uses the testnet id on testnet, and keeps amounts as strings', () => {
    expect(buildTransactionRequest(intent, 2_000_000_000 - 100).validUntil).toBe(2_000_000_000)
    expect(buildTransactionRequest(intent, 1_000).validUntil).toBe(1_600)
    expect(buildTransactionRequest({ ...intent, network: 'testnet' }, 1).network).toBe('-3')
    expect(typeof buildTransactionRequest(intent).messages[0].amount).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// 3. Replay protection: the real migrations, executed in an in-process Postgres
// ---------------------------------------------------------------------------

async function freshDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  return db
}

describe('deposit crediting in the database (replay attack prevention)', () => {
  const memo = (n: number) => `dep_${n.toString(16).padStart(32, '0')}`

  async function setup() {
    const db = await freshDb()
    const users = (await db.query<{ id: string }>(`insert into users(telegram_id) values (1),(2) returning id`)).rows.map((r) => r.id)
    const mk = async (user: string, n: number, usd = 10) =>
      (await db.query<{ id: string }>(
        `insert into deposits(user_id,amount_usd,amount_crypto,rate_usd,memo,recipient_address,valid_until)
         values ($1,$2,2,5,$3,'UQrecipient', now()+interval '30 minutes') returning id`, [user, usd, memo(n)])).rows[0].id
    const balance = async (user: string) => (await db.query<{ b: string }>(`select balance::text b from wallets where user_id=$1`, [user])).rows[0].b
    const complete = (id: string, hash: string) => db.query(`select * from complete_deposit($1,$2,'0:sender')`, [id, hash])
    return { db, users, mk, balance, complete }
  }

  it('credits exactly once, atomically with a ledger entry; re-verifying is idempotent', async () => {
    const { db, users, mk, balance, complete } = await setup()
    const d = await mk(users[0], 1, 10)
    expect(await balance(users[0])).toBe('0.0000') // an intent alone credits nothing

    await complete(d, 'TX-1')
    await complete(d, 'TX-1')
    await complete(d, 'TX-ANOTHER') // even a different hash cannot re-credit a completed deposit
    expect(await balance(users[0])).toBe('10.0000')

    const ledger = (await db.query<{ type: string; amount: string; reference_id: string; idempotency_key: string }>(
      `select type, amount::text, reference_id, idempotency_key from wallet_transactions`)).rows
    expect(ledger).toEqual([{ type: 'deposit', amount: '10.0000', reference_id: d, idempotency_key: `deposit:${d}` }])
    expect((await db.query<{ tx_hash: string }>(`select tx_hash from deposits where id=$1`, [d])).rows[0].tx_hash).toBe('TX-1')
  }, 60_000)

  it('blocks the same tx_hash from crediting a second deposit (same user or another user)', async () => {
    const { users, mk, balance, complete } = await setup()
    const a = await mk(users[0], 1, 10)
    const sameUser = await mk(users[0], 2, 10)
    const otherUser = await mk(users[1], 3, 10)
    await complete(a, 'TX-1')

    await expect(complete(sameUser, 'TX-1')).rejects.toThrow(/tx_already_used/)
    await expect(complete(otherUser, 'TX-1')).rejects.toThrow(/tx_already_used/)
    expect(await balance(users[0])).toBe('10.0000')
    expect(await balance(users[1])).toBe('0.0000')
  }, 60_000)

  it('the UNIQUE constraint holds even if the function is bypassed', async () => {
    const { db, users, mk, complete } = await setup()
    const a = await mk(users[0], 1)
    const b = await mk(users[0], 2)
    await complete(a, 'TX-1')
    await expect(db.query(`update deposits set tx_hash='TX-1' where id=$1`, [b])).rejects.toThrow(/unique|duplicate/i)
  }, 60_000)

  it('a failed credit rolls back the status change (no "completed but not credited")', async () => {
    const { db, users, mk, balance } = await setup()
    const d = await mk(users[0], 1)
    await db.query(`alter table wallet_transactions add constraint boom check (amount < 0)`) // force the ledger insert to fail
    await expect(db.query(`select * from complete_deposit($1,'TX-9','0:s')`, [d])).rejects.toThrow()
    expect((await db.query<{ status: string; tx_hash: string | null }>(`select status, tx_hash from deposits where id=$1`, [d])).rows[0]).toEqual({ status: 'pending', tx_hash: null })
    expect(await balance(users[0])).toBe('0.0000')
  }, 60_000)

  it('memos must be unique and well-formed; completed rows are immutable', async () => {
    const { db, users, mk, complete } = await setup()
    const d = await mk(users[0], 1)
    await expect(mk(users[0], 1)).rejects.toThrow(/unique|duplicate/i)
    await expect(db.query(`update deposits set memo='dep_short' where id=$1`, [d])).rejects.toThrow()
    await complete(d, 'TX-1')
    await expect(db.query(`update deposits set status='pending' where id=$1`, [d])).rejects.toThrow(/immutable/)
  }, 60_000)

  it('clients can read only their own deposits and cannot write or credit anything', async () => {
    const { db, users, mk } = await setup()
    await mk(users[0], 1)
    await mk(users[1], 2)
    await db.exec(`set role authenticated; select set_config('request.jwt.sub','${users[0]}',false)`)
    expect((await db.query(`select id from deposits`)).rows).toHaveLength(1)
    await expect(db.query(`insert into deposits(user_id,amount_usd,amount_crypto,rate_usd,memo,recipient_address,valid_until) values ('${users[0]}',1,1,1,'${memo(99)}','x',now())`)).rejects.toThrow(/permission/)
    await expect(db.query(`update deposits set status='completed'`)).rejects.toThrow(/permission/)
    await expect(db.query(`select * from complete_deposit(gen_random_uuid(),'H')`)).rejects.toThrow(/permission/)
    await expect(db.query(`select process_wallet_transaction('${users[0]}','deposit',500)`)).rejects.toThrow(/permission/)
    await db.exec(`reset role`)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Dev mock mode: the offline wallet flow
// ---------------------------------------------------------------------------

describe('mock backend: deposits and ledger', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }

  it('quotes at the fixed dev rate and rejects invalid input / USDT', () => {
    const b = createMockBackend(memory())
    expect(b.quoteDeposit(10, 'TON')).toMatchObject({ amountCrypto: '2.000000000', amountNano: '2000000000', rateUsd: MOCK_TON_USD_RATE })
    expect(() => b.quoteDeposit(0.5, 'TON')).toThrow(DepositApiError)
    expect(() => b.quoteDeposit(10, 'USDT')).toThrow(/not available/)
  })

  it('creates a pending intent (no credit), then Simulate credits once and adds a ledger entry', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t)
    const intent = b.createDeposit(25, 'TON')
    expect(intent.memo).toMatch(MEMO_RE)
    expect(intent.amountNano).toBe('5000000000')
    expect(b.getWallet().balance).toBe(24.5)
    expect(b.verifyDeposit(intent.depositId)).toEqual({ status: 'pending' })
    expect(b.listLedger()[0]).toMatchObject({ type: 'deposit', status: 'pending', amount: 25, depositId: intent.depositId })

    t += 5_000
    const done = b.completeDeposit(intent.depositId)
    expect(done).toEqual({ status: 'completed', wallet: { balance: 49.5, currency: 'USD' } })
    b.completeDeposit(intent.depositId) // idempotent
    expect(b.getWallet().balance).toBe(49.5)
    expect(b.verifyDeposit(intent.depositId).status).toBe('completed')

    const ledger = b.listLedger()
    expect(ledger).toHaveLength(1) // the pending row is replaced by the completed entry
    expect(ledger[0]).toMatchObject({ type: 'deposit', status: 'completed', amount: 25, balanceAfter: 49.5, description: 'Deposit via Tonkeeper (TON)' })
  })

  it('records purchases in the same ledger and keeps deposits and orders consistent', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t)
    const members = MOCK_CATALOG.services.find((s) => s.name.includes('Channel Members'))!
    t += 1_000
    b.createOrder({ serviceId: members.id, targetUrl: 'https://t.me/x', quantity: 1000, idempotencyKey: 'key-0001' }) // $5.40
    t += 1_000
    b.completeDeposit(b.createDeposit(10, 'TON').depositId)

    expect(b.getWallet().balance).toBe(29.1) // 24.50 - 5.40 + 10
    const entries = b.listLedger()
    expect(entries.map((e) => [e.type, e.amount, e.balanceAfter])).toEqual([['deposit', 10, 29.1], ['purchase', -5.4, 19.1]])
  })

  it('persists across reloads and survives pre-wallet saved state', () => {
    const store = memory()
    const first = createMockBackend(store)
    first.completeDeposit(first.createDeposit(5, 'TON').depositId)
    expect(createMockBackend(store).getWallet().balance).toBe(29.5)

    const legacy = memory() // state written before the ledger existed
    legacy.setItem('smm_mock_backend_v1', JSON.stringify({ balanceUnits: 100_000, orders: [] }))
    const b = createMockBackend(legacy)
    expect(b.getWallet().balance).toBe(10)
    expect(b.listLedger()).toEqual([])
  })

  it('does not know unknown deposits', () => {
    const b = createMockBackend(memory())
    expect(() => b.completeDeposit('nope')).toThrow(DepositApiError)
    expect(() => b.verifyDeposit('nope')).toThrow(DepositApiError)
  })

  it('still rejects insufficient funds after deposits are accounted for', () => {
    const b = createMockBackend(memory())
    const members = MOCK_CATALOG.services.find((s) => s.name.includes('Channel Members'))!
    expect(() => b.createOrder({ serviceId: members.id, targetUrl: 'https://t.me/x', quantity: 5000, idempotencyKey: 'key-0001' })).toThrow(OrderApiError)
    b.completeDeposit(b.createDeposit(5, 'TON').depositId)
    expect(b.createOrder({ serviceId: members.id, targetUrl: 'https://t.me/x', quantity: 5000, idempotencyKey: 'key-0001' }).order.chargeAmount).toBe(27) // $27.00 <= $29.50
  })
})

describe('ledger filters', () => {
  const types: LedgerType[] = ['deposit', 'purchase', 'refund', 'bonus', 'manual_adjustment']
  it('groups entries into All / Deposits / Purchases / Refunds', () => {
    const pick = (f: Parameters<typeof matchesLedgerFilter>[1]) => types.filter((t) => matchesLedgerFilter(t, f))
    expect(pick('all')).toEqual(types)
    expect(pick('deposits')).toEqual(['deposit'])
    expect(pick('purchases')).toEqual(['purchase'])
    expect(pick('refunds')).toEqual(['refund'])
    expect(LEDGER_FILTERS.map((f) => f.label)).toEqual(['All', 'Deposits', 'Purchases', 'Refunds'])
  })
})
