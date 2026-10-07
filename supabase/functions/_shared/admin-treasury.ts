// Pure parts of the admin-treasury Edge Function: request validation, error mapping and the payment view.

import { detectPaymentIssue, evidenceFromRow, type PaymentIssue } from './reconciliation-detectors.ts'

export const DEFAULT_PAGE = 50
export const MAX_PAGE = 200
const MAX_AMOUNT = 1_000_000_000
const KEY = /^[A-Za-z0-9_-]{8,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TreasuryRequest =
  | { action: 'GET'; limit: number; beforeSeq: number | null }
  | { action: 'MANUAL_ADJUSTMENT'; amount: number; description: string; idempotencyKey: string }
  | { action: 'APPROVE_PROPOSAL' | 'REJECT_PROPOSAL'; proposalId: string }
  | { action: 'CREATE_INSTRUCTION'; paymentId: string }
  | { action: 'RECORD_PAYMENT_BROADCAST'; paymentId: string; txHash: string; markConfirming?: true }
  | { action: 'ADVANCE_PAYMENT'; paymentId: string; to: 'CONFIRMING' | 'CONFIRMED' | 'PROVIDER_BALANCE_VERIFIED' | 'COMPLETED' }
  | { action: 'FAIL_PAYMENT' | 'CANCEL_PAYMENT'; paymentId: string; reason: string }

/**
 * Validates the body. `amount` is signed: positive adds funds, negative removes them. A description (the why) and an
 * idempotency key (so a double click or a retry books the movement once) are mandatory for money movements.
 */
export function parseTreasuryRequest(body: unknown): TreasuryRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'GET'

  if (action === 'GET') {
    let limit = DEFAULT_PAGE
    if (b.limit !== undefined) {
      if (typeof b.limit !== 'number' || !Number.isInteger(b.limit) || b.limit < 1) return { error: 'limit must be a positive integer.' }
      limit = Math.min(b.limit, MAX_PAGE)
    }
    let beforeSeq: number | null = null
    if (b.beforeSeq !== undefined && b.beforeSeq !== null) {
      if (typeof b.beforeSeq !== 'number' || !Number.isSafeInteger(b.beforeSeq) || b.beforeSeq < 1) return { error: 'beforeSeq must be a positive integer.' }
      beforeSeq = b.beforeSeq
    }
    return { action: 'GET', limit, beforeSeq }
  }

  if (action === 'MANUAL_ADJUSTMENT') {
    if (typeof b.amount !== 'number' || !Number.isFinite(b.amount)) return { error: 'amount must be a number.' }
    const amount = Math.round(b.amount * 10_000) / 10_000
    if (amount === 0) return { error: 'amount must not be zero.' }
    if (Math.abs(amount) >= MAX_AMOUNT) return { error: 'amount is out of range.' }
    const description = typeof b.description === 'string' ? b.description.trim() : ''
    if (description.length < 3 || description.length > 200) return { error: 'description must be 3 to 200 characters.' }
    if (typeof b.idempotencyKey !== 'string' || !KEY.test(b.idempotencyKey)) return { error: 'idempotencyKey must be 8 to 64 characters (letters, digits, - and _).' }
    return { action: 'MANUAL_ADJUSTMENT', amount, description, idempotencyKey: b.idempotencyKey }
  }
  if (action === 'APPROVE_PROPOSAL' || action === 'REJECT_PROPOSAL') {
    if (typeof b.proposalId !== 'string' || !UUID.test(b.proposalId)) return { error: 'proposalId must be a UUID.' }
    return { action, proposalId: b.proposalId.toLowerCase() }
  }
  if (action === 'CREATE_INSTRUCTION' || action === 'RECORD_PAYMENT_BROADCAST' || action === 'ADVANCE_PAYMENT' || action === 'FAIL_PAYMENT' || action === 'CANCEL_PAYMENT') {
    if (typeof b.paymentId !== 'string' || !UUID.test(b.paymentId)) return { error: 'paymentId must be a UUID.' }
    const paymentId = b.paymentId.toLowerCase()
    if (action === 'CREATE_INSTRUCTION') return { action, paymentId }
    if (action === 'RECORD_PAYMENT_BROADCAST') {
      const tx = typeof b.txHash === 'string' ? b.txHash.trim() : ''
      if (!tx || tx.length > 200 || /\s/.test(tx)) return { error: 'txHash must be one token of at most 200 characters.' }
      if (b.markConfirming !== undefined && typeof b.markConfirming !== 'boolean') return { error: 'markConfirming must be a boolean.' }
      // the hash says the transfer was sent; CONFIRMING (visible on chain, not final yet) is the admin's call
      return { action, paymentId, txHash: tx, ...(b.markConfirming === true ? { markConfirming: true as const } : {}) }
    }
    if (action === 'ADVANCE_PAYMENT') {
      const to = b.to
      if (to !== 'CONFIRMING' && to !== 'CONFIRMED' && to !== 'PROVIDER_BALANCE_VERIFIED' && to !== 'COMPLETED') return { error: 'to must be CONFIRMING, CONFIRMED, PROVIDER_BALANCE_VERIFIED or COMPLETED.' }
      return { action, paymentId, to }
    }
    const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
    if (reason.length < 3 || reason.length > 300) return { error: 'reason must be 3 to 300 characters.' }
    return { action, paymentId, reason }
  }
  return { error: 'Unknown action.' }
}

/** Database errors of process_treasury_transaction -> HTTP. Anything unrecognised stays a generic 500 (no internals leak). */
export function mapTreasuryError(message: string): { status: number; error: string; message: string } {
  const funds = /insufficient_treasury_funds: available (-?[\d.]+), required (-?[\d.]+)/.exec(message)
  if (funds) return { status: 409, error: 'insufficient_treasury_funds', message: `Insufficient treasury funds: ${funds[1]} available, ${funds[2]} required.` }
  const limit = /(max_topup_per_tx_exceeded|max_daily_topup_exceeded|treasury_reserve_breached|payout_limits_not_configured|payout_not_configured|destination_not_allowed|payout_config_mismatch): ?(.*)/.exec(message)
  if (limit) return { status: 409, error: limit[1], message: limit[2] || limit[1] }
  if (/cannot complete without a transaction hash/.test(message)) return { status: 409, error: 'tx_hash_required', message: 'Record the transaction hash before completing the payment.' }
  if (/invalid provider payment transition|payment_not_approved/.test(message)) return { status: 409, error: 'invalid_transition', message: 'The payment is not in a state that allows this.' }
  if (/tx_already_used/.test(message)) return { status: 409, error: 'tx_already_used', message: 'This transaction hash is already recorded on another payment.' }
  if (/payment .* not found/.test(message)) return { status: 404, error: 'not_found', message: 'Payment not found.' }
  if (/proposal_not_pending/.test(message)) return { status: 409, error: 'proposal_not_pending', message: 'This proposal was already decided.' }
  if (/unsupported_currency/.test(message)) return { status: 409, error: 'unsupported_currency', message: 'The treasury is held in USD; this provider is paid in another currency.' }
  if (/proposal .* not found/.test(message)) return { status: 404, error: 'not_found', message: 'Proposal not found.' }
  if (/was already used with a different amount/.test(message)) return { status: 409, error: 'idempotency_conflict', message: 'This request id was already used for a different amount.' }
  if (/the transaction hash is required/.test(message)) return { status: 400, error: 'invalid_input', message: 'The transaction hash is required.' }
  if (/invalid_parameter_value|amount (is out of range|must be non-zero|is required)|sign does not match/.test(message)) return { status: 400, error: 'invalid_input', message: 'Invalid amount.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

/** A provider payment as Admin -> Treasury shows it. */
export interface PaymentView {
  id: string
  providerId: string
  providerName: string
  amount: number
  currency: string
  asset: string
  network: string
  /** Fixed server-side from the provider's payout config when the payment was created; never from the client. */
  destinationWallet: string
  txHash: string | null
  status: string
  failureReason: string | null
  /** The treasury got the amount back (failed / canceled). */
  treasuryReversed: boolean
  createdAt: string
  updatedAt: string
  broadcastedAt: string | null
  confirmedAt: string | null
  completedAt: string | null
  openCaseId: string | null
  /** The reconciliation detector's verdict right now (same rules as the cron), or null. */
  issue: PaymentIssue | null
}

const opt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** One list_provider_payments row -> the view, with the live detector verdict. */
export function paymentView(r: Record<string, unknown>, now: number = Date.now()): PaymentView {
  return {
    id: String(r.id), providerId: String(r.provider_id), providerName: String(r.provider_name ?? 'Provider'),
    amount: Number(r.amount), currency: String(r.currency ?? 'USD'), asset: String(r.asset), network: String(r.network),
    destinationWallet: String(r.destination_wallet), txHash: opt(r.tx_hash), status: String(r.status), failureReason: opt(r.failure_reason),
    treasuryReversed: r.treasury_reversed === true, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    broadcastedAt: opt(r.broadcasted_at), confirmedAt: opt(r.confirmed_at), completedAt: opt(r.completed_at), openCaseId: opt(r.open_case_id),
    issue: detectPaymentIssue(evidenceFromRow(r), now),
  }
}
