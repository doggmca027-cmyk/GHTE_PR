// The verify-deposit decision, with all I/O injected (ports), so the Edge Function and scripts/ton-e2e.ts run the SAME
// code. The client is never the source of truth: the payment is looked up on chain by the server and must match the
// deposit intent exactly.
//
// Rules (Phase 5 audit):
//   * network   : the deposit's network must be the network this server verifies on (no testnet coins for a mainnet
//                 intent after a config switch)
//   * recipient : the intent's recipient must be our configured address, and the transfer must be addressed to it
//   * memo      : the transfer comment must equal the intent's unique memo exactly (missing / wrong memo = no match)
//   * amount    : received >= quoted amount; less is never credited (the database checks it again)
//   * window    : paid between creation and expiry (with clock skew)
//   * replay    : one transaction hash funds at most one deposit (UNIQUE in the database); the ledger credit is keyed
//                 per deposit, so concurrent or repeated verifications credit exactly once
// Payments that reached our wallet but cannot be credited (underpaid, late, already used) are flagged as a
// reconciliation case, so the money is never silently stuck.

import { addressesEqual, findMatchingTransfer, formatBaseUnits, toRawAddress, type ChainTransfer } from './ton.ts'

export interface DepositRow {
  id: string
  status: string
  memo: string
  recipient_address: string
  amount_crypto: string | number
  asset: string
  network: string
  created_at: string
  valid_until: string
}

export interface VerifyConfig {
  network: 'mainnet' | 'testnet'
  recipient: string
}

export interface VerifyPorts {
  /** complete_deposit(): lock, claim the tx hash, credit the ledger, all in one transaction. Throws with the DB message. */
  completeDeposit(args: { depositId: string; txHash: string; senderRaw: string | null; receivedNano: bigint }): Promise<void>
  /** Opens (or refreshes) a reconciliation case for this deposit. Best effort. */
  flagIssue(depositId: string, reason: string): Promise<void>
  /** Incoming transfers to our recipient since the deposit was created. Throws when the chain API is unreachable. */
  loadTransfers(sinceUtime: number): Promise<ChainTransfer[]>
}

export type VerifyOutcome =
  | { kind: 'completed'; already: boolean; txHash?: string }
  | { kind: 'pending' }
  | { kind: 'rejected'; httpStatus: number; error: string; message: string; flagged: boolean; extra?: Record<string, unknown> }

/** NUMERIC(20,9) text -> nanoton, exactly (no floats). */
export function amountToNano(text: string | number): bigint {
  const s = String(text)
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`unexpected amount format: ${s}`)
  const [whole, frac = ''] = s.split('.')
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0').slice(0, 9))
}

const reject = (httpStatus: number, error: string, message: string, flagged = false, extra?: Record<string, unknown>): VerifyOutcome =>
  ({ kind: 'rejected', httpStatus, error, message, flagged, extra })

export async function verifyDeposit(deposit: DepositRow, config: VerifyConfig, ports: VerifyPorts): Promise<VerifyOutcome> {
  if (deposit.status === 'completed') return { kind: 'completed', already: true }
  if (deposit.status === 'failed') return reject(409, 'deposit_failed', 'This deposit has failed.')
  if (deposit.asset !== 'TON') return reject(400, 'asset_unavailable', 'Only TON deposits can be verified right now.')
  if (deposit.network !== config.network) {
    return reject(409, 'network_mismatch', `This deposit was created for TON ${deposit.network} and cannot be paid on ${config.network}.`)
  }
  if (!addressesEqual(deposit.recipient_address, config.recipient)) {
    return reject(500, 'server_misconfigured', 'Server is not configured.')
  }

  const createdAtSec = Math.floor(Date.parse(deposit.created_at) / 1000)
  const validUntilSec = Math.floor(Date.parse(deposit.valid_until) / 1000)
  const amountBase = amountToNano(deposit.amount_crypto)
  let transfers: ChainTransfer[]
  try {
    transfers = await ports.loadTransfers(createdAtSec - 300)
  } catch {
    return reject(502, 'chain_unavailable', 'Could not reach the TON network. Please try again shortly.')
  }

  const match = findMatchingTransfer(transfers, { memo: deposit.memo, recipientAddress: config.recipient, amountBase, createdAtSec, validUntilSec })
  if (!match.found) {
    if (match.reason === 'underpaid') {
      const received = match.transfer ? formatBaseUnits(match.transfer.valueBase, 9) : '?'
      await ports.flagIssue(deposit.id, `underpaid: received ${received} TON of ${String(deposit.amount_crypto)} in tx ${match.transfer?.hash ?? '?'}`).catch(() => {})
      return reject(422, 'underpaid', 'We received less than the required amount. Please contact support with your deposit ID.', true,
        { received, required: String(deposit.amount_crypto) })
    }
    if (match.reason === 'outside_window') {
      await ports.flagIssue(deposit.id, `paid outside the validity window in tx ${match.transfer?.hash ?? '?'}`).catch(() => {})
      return reject(422, 'payment_expired', 'The payment arrived after this deposit expired. Please contact support with your deposit ID.', true)
    }
    // Not indexed yet, or no transfer with this memo at all (a missing / wrong memo never matches).
    return { kind: 'pending' }
  }

  const t = match.transfer
  try {
    await ports.completeDeposit({ depositId: deposit.id, txHash: t.hash, senderRaw: t.source ? toRawAddress(t.source) : null, receivedNano: t.valueBase })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // (the raw unique-index error too, in case an older database function is still deployed)
    if (/tx_already_used|deposits_tx_hash_key/.test(message)) {
      await ports.flagIssue(deposit.id, `tx ${t.hash} was already credited to another deposit`).catch(() => {})
      return reject(409, 'tx_already_used', 'This transaction was already credited.', true)
    }
    if (/underpaid/.test(message)) {
      await ports.flagIssue(deposit.id, `underpaid (database check) in tx ${t.hash}`).catch(() => {})
      return reject(422, 'underpaid', 'We received less than the required amount. Please contact support with your deposit ID.', true)
    }
    throw e
  }
  return { kind: 'completed', already: false, txHash: t.hash }
}
