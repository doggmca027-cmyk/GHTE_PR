// TON deposit primitives. Pure and dependency-free (no @ton/core), so the same code runs in
// Deno Edge Functions, Node tests and the browser bundle. All money maths uses BigInt.

// ---------------------------------------------------------------------------
// Assets, limits, validation
// ---------------------------------------------------------------------------

export type DepositAsset = 'TON' | 'USDT'
/** Base units per whole asset: TON has 9 decimals (nanoton), USDT on TON (jetton) has 6. */
export const ASSET_DECIMALS: Record<DepositAsset, number> = { TON: 9, USDT: 6 }

export const MIN_DEPOSIT_USD = 1
export const MAX_DEPOSIT_USD = 500
/** How long a quote (and its memo) accepts payments. */
export const DEPOSIT_VALIDITY_SECONDS = 30 * 60
export const MAX_PENDING_DEPOSITS = 5
/** Sanity bounds for the USD price of 1 TON; anything outside is treated as a bad feed. */
export const TON_RATE_BOUNDS = { min: 0.1, max: 1000 }

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

/** Whole cents (integer) from a USD amount with at most 2 decimals, within [MIN, MAX]. */
export function validateDepositAmountUsd(amountUsd: unknown): Validation<number> {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) return { ok: false, error: 'Enter a deposit amount' }
  const cents = Math.round(amountUsd * 100)
  if (Math.abs(cents / 100 - amountUsd) > 1e-9) return { ok: false, error: 'Use at most 2 decimal places' }
  if (cents < MIN_DEPOSIT_USD * 100) return { ok: false, error: `Minimum deposit is $${MIN_DEPOSIT_USD.toFixed(2)}` }
  if (cents > MAX_DEPOSIT_USD * 100) return { ok: false, error: `Maximum deposit is $${MAX_DEPOSIT_USD.toFixed(2)}` }
  return { ok: true, value: cents }
}

/** Parses user text such as "12", "12.5", "$12.50" into a number for validateDepositAmountUsd. */
export function parseUsdInput(raw: string): number | null {
  const t = raw.replace(/[$,\s]/g, '')
  return /^\d+(\.\d{1,})?$/.test(t) ? Number(t) : null
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export interface DepositQuote {
  asset: DepositAsset
  amountUsd: number
  /** Exact decimal string, e.g. "2.000000000". Stored in deposits.amount_crypto (NUMERIC(20,9)). */
  amountCrypto: string
  /** Exact base units (nanoton for TON). Sent on chain; stringified for JSON. */
  amountBase: bigint
  /** USD per 1 whole asset used for the quote. */
  rateUsd: number
}

/** Formats base units as a plain decimal with exactly `decimals` fraction digits (no floats). */
export function formatBaseUnits(base: bigint, decimals: number): string {
  const s = base.toString().padStart(decimals + 1, '0')
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`
}

/**
 * crypto = usd / rate, rounded UP to the smallest unit so the user never underpays the quote.
 *   baseUnits = ceil(cents/100 / rate * 10^decimals) = ceil(cents * 10^(decimals+6-2) / rateMicro)
 * with rateMicro = round(rate * 1e6) as an integer.
 */
export function quoteDeposit(amountUsd: number, rateUsd: number, asset: DepositAsset = 'TON'): DepositQuote {
  const amount = validateDepositAmountUsd(amountUsd)
  if (!amount.ok) throw new RangeError(amount.error)
  if (!Number.isFinite(rateUsd) || rateUsd <= 0) throw new RangeError('rate must be positive')

  const rateMicro = BigInt(Math.round(rateUsd * 1e6))
  if (rateMicro <= 0n) throw new RangeError('rate is too small')
  const decimals = ASSET_DECIMALS[asset]
  const numerator = BigInt(amount.value) * 10n ** BigInt(decimals + 4)
  const amountBase = (numerator + rateMicro - 1n) / rateMicro
  return { asset, amountUsd: amount.value / 100, amountCrypto: formatBaseUnits(amountBase, decimals), amountBase, rateUsd }
}

export function parseCoinGeckoTonUsd(json: unknown): number | null {
  const rate = (json as { 'the-open-network'?: { usd?: unknown } } | null)?.['the-open-network']?.usd
  return typeof rate === 'number' && rate >= TON_RATE_BOUNDS.min && rate <= TON_RATE_BOUNDS.max ? rate : null
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

export const MEMO_RE = /^dep_[0-9a-f]{32}$/

/** "dep_" + 128 random bits (hex). Unguessable, and unique in practice; the DB UNIQUE constraint is the guarantee. */
export function generateMemo(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `dep_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

// ---------------------------------------------------------------------------
// Addresses (raw "0:<hex>" and user-friendly base64 "EQ…/UQ…")
// ---------------------------------------------------------------------------

export interface TonAddress {
  workchain: number
  /** 64 lowercase hex chars. */
  hash: string
}

function crc16(bytes: Uint8Array): number {
  let crc = 0
  for (const b of bytes) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

export function parseTonAddress(input: string): TonAddress {
  const text = input.trim()
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(text)
  if (raw) return { workchain: Number(raw[1]), hash: raw[2].toLowerCase() }

  if (!/^[A-Za-z0-9_\-+/]{48}$/.test(text)) throw new Error('invalid TON address')
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  if (bytes.length !== 36) throw new Error('invalid TON address length')
  const tag = bytes[0] & 0x7f // strip the testnet-only bit
  if (tag !== 0x11 && tag !== 0x51) throw new Error('invalid TON address tag')
  if (crc16(bytes.subarray(0, 34)) !== ((bytes[34] << 8) | bytes[35])) throw new Error('invalid TON address checksum')
  const workchain = bytes[1] === 0xff ? -1 : bytes[1]
  const hash = Array.from(bytes.subarray(2, 34), (b) => b.toString(16).padStart(2, '0')).join('')
  return { workchain, hash }
}

export const toRawAddress = (a: TonAddress | string): string => {
  const p = typeof a === 'string' ? parseTonAddress(a) : a
  return `${p.workchain}:${p.hash}`
}

export function addressesEqual(a: string, b: string): boolean {
  try {
    return toRawAddress(a) === toRawAddress(b)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Transaction payload: text comment as a base64 BOC
// ---------------------------------------------------------------------------

/**
 * Base64 BOC of a single cell holding a standard text comment:  uint32(0) ++ utf8(text).
 * This is what a wallet puts in the message body so the recipient sees `text` as the comment.
 * Hand-built (one cell, no refs) to avoid shipping a BOC library + Buffer polyfill to the
 * browser; tests cross-check it against @ton/core.
 */
export function buildCommentBocBase64(text: string): string {
  const utf8 = new TextEncoder().encode(text)
  const data = new Uint8Array(4 + utf8.length) // first 4 bytes stay 0x00000000 = "text comment" opcode
  data.set(utf8, 4)
  if (data.length > 127) throw new RangeError('comment too long for a single cell (max 123 bytes)')

  const cell = [0x00, data.length * 2, ...data] // d1 = 0 refs, d2 = 2 * byte length (whole bytes)
  const boc = [
    0xb5, 0xee, 0x9c, 0x72, // magic
    0x01, //  has_idx=0 crc32=0 cache=0 flags=0 size=1 byte
    0x01, //  offset size = 1 byte
    0x01, //  1 cell
    0x01, //  1 root
    0x00, //  0 absent
    cell.length, // total cells size
    0x00, //  root index
    ...cell,
  ]
  let bin = ''
  for (const b of boc) bin += String.fromCharCode(b)
  return btoa(bin)
}

// ---------------------------------------------------------------------------
// On-chain data (Toncenter API v3)
// ---------------------------------------------------------------------------

export interface ChainTransfer {
  /** Transaction hash exactly as the API reports it (stored in deposits.tx_hash). */
  hash: string
  /** Unix seconds. */
  utime: number
  /** Raw "wc:hex" or friendly; compare with addressesEqual(). */
  source: string | null
  destination: string | null
  valueBase: bigint
  comment: string | null
  /** True when the VALUE reached our account (see normalizeToncenterTransactions for the exact rule). */
  success: boolean
}

interface ToncenterTx {
  hash?: unknown
  now?: unknown
  description?: { aborted?: unknown }
  in_msg?: {
    source?: unknown
    destination?: unknown
    value?: unknown
    bounce?: unknown
    bounced?: unknown
    message_content?: { decoded?: { type?: unknown; comment?: unknown } | null } | null
  } | null
}

/**
 * Normalises `GET /api/v3/transactions?account=…` into incoming transfers.
 * Shape per Toncenter v3 docs (in_msg.value in nanoton as string, in_msg.message_content.decoded
 * = { type: "text_comment", comment }). Validate against testnet before going live.
 */
export function normalizeToncenterTransactions(json: unknown): ChainTransfer[] {
  const list = (json as { transactions?: unknown })?.transactions
  if (!Array.isArray(list)) throw new Error('unexpected Toncenter response')
  const out: ChainTransfer[] = []
  for (const tx of list as ToncenterTx[]) {
    const m = tx?.in_msg
    // Only internal messages carry value (external-in messages have no source and no value).
    if (typeof tx?.hash !== 'string' || typeof tx.now !== 'number' || !m || typeof m.source !== 'string') continue
    let value: bigint
    try {
      value = BigInt(String(m.value ?? '0'))
    } catch {
      continue
    }
    const d = m.message_content?.decoded
    out.push({
      hash: tx.hash,
      utime: tx.now,
      source: m.source,
      destination: typeof m.destination === 'string' ? m.destination : null,
      valueBase: value,
      comment: d && d.type === 'text_comment' && typeof d.comment === 'string' ? d.comment : null,
      // "Did our account RECEIVE the value?" is NOT the same as "did the transaction succeed" (verified on real
      // Toncenter data): transfers to a fresh/uninitialised wallet, or non-bounceable ones the wallet code rejected,
      // are flagged aborted:true yet the funds ARE credited. The protocol rules:
      //   - a message that is itself a bounce coming back (bounced:true) is a refund to us, never a payment;
      //   - non-bounceable (bounce:false): the value is credited whatever the compute phase did;
      //   - bounceable: a failed/aborted transaction bounces the value back to the sender, so it only counts if not aborted.
      // Anything unclear (fields missing) falls back to the strict rule: require aborted === false.
      success: m.bounced !== true && (m.bounce === false || tx.description?.aborted === false),
    })
  }
  return out
}

export interface DepositForMatch {
  memo: string
  recipientAddress: string
  amountBase: bigint
  createdAtSec: number
  validUntilSec: number
}

export type MatchResult =
  | { found: true; transfer: ChainTransfer }
  | { found: false; reason: 'not_found' | 'underpaid' | 'outside_window'; transfer?: ChainTransfer }

const CLOCK_SKEW_SECONDS = 120

/**
 * Finds the transfer that pays `deposit`. ALL of these must hold:
 *   - transaction succeeded (not aborted / bounced)
 *   - destination is OUR recipient address (not merely "some address")
 *   - comment is EXACTLY the deposit's memo
 *   - value >= quoted amount
 *   - it happened inside the quote window [created - skew, valid_until + skew]
 * When several transfers qualify the earliest wins (the rest stay unclaimed on chain).
 */
export function findMatchingTransfer(transfers: ChainTransfer[], deposit: DepositForMatch): MatchResult {
  const withMemo = transfers
    .filter((t) => t.success && t.comment === deposit.memo && t.destination && addressesEqual(t.destination, deposit.recipientAddress))
    .sort((a, b) => a.utime - b.utime)
  if (withMemo.length === 0) return { found: false, reason: 'not_found' }

  const inWindow = withMemo.filter(
    (t) => t.utime >= deposit.createdAtSec - CLOCK_SKEW_SECONDS && t.utime <= deposit.validUntilSec + CLOCK_SKEW_SECONDS,
  )
  if (inWindow.length === 0) return { found: false, reason: 'outside_window', transfer: withMemo[0] }

  const paid = inWindow.find((t) => t.valueBase >= deposit.amountBase)
  if (paid) return { found: true, transfer: paid }
  return { found: false, reason: 'underpaid', transfer: inWindow[0] }
}

export async function fetchRecentTransfers(opts: {
  baseUrl: string
  account: string
  sinceUtime: number
  apiKey?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<ChainTransfer[]> {
  const url = new URL('/api/v3/transactions', opts.baseUrl)
  url.searchParams.set('account', toRawAddress(opts.account))
  url.searchParams.set('start_utime', String(Math.max(0, opts.sinceUtime)))
  url.searchParams.set('limit', '100')
  url.searchParams.set('sort', 'desc')
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { Accept: 'application/json', ...(opts.apiKey ? { 'X-API-Key': opts.apiKey } : {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  })
  if (!res.ok) throw new Error(`Toncenter responded with HTTP ${res.status}`)
  return normalizeToncenterTransactions(await res.json())
}

/**
 * Flags encoded in a user-friendly address (EQ.. / UQ.. / kQ.. / 0Q..), or null for the raw "wc:hex" form
 * (which carries none). Throws on an invalid address. Used by deployment checks to catch a testnet
 * address configured with TON_NETWORK=mainnet.
 */
export function tonAddressFlags(input: string): { testOnly: boolean; bounceable: boolean } | null {
  const text = input.trim()
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(text)) return null
  parseTonAddress(text) // validates length, tag and checksum
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const tag = bin.charCodeAt(0)
  return { testOnly: (tag & 0x80) !== 0, bounceable: (tag & 0x7f) === 0x11 }
}
