// Pure parts of the admin-treasury Edge Function: request validation and error mapping.

export const DEFAULT_PAGE = 50
export const MAX_PAGE = 200
const MAX_AMOUNT = 1_000_000_000
const KEY = /^[A-Za-z0-9_-]{8,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TreasuryRequest =
  | { action: 'GET'; limit: number; beforeSeq: number | null }
  | { action: 'MANUAL_ADJUSTMENT'; amount: number; description: string; idempotencyKey: string }
  | { action: 'APPROVE_PROPOSAL' | 'REJECT_PROPOSAL'; proposalId: string }

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
  return { error: 'Unknown action.' }
}

/** Database errors of process_treasury_transaction -> HTTP. Anything unrecognised stays a generic 500 (no internals leak). */
export function mapTreasuryError(message: string): { status: number; error: string; message: string } {
  const funds = /insufficient_treasury_funds: available (-?[\d.]+), required (-?[\d.]+)/.exec(message)
  if (funds) return { status: 409, error: 'insufficient_treasury_funds', message: `Insufficient treasury funds: ${funds[1]} available, ${funds[2]} required.` }
  if (/proposal_not_pending/.test(message)) return { status: 409, error: 'proposal_not_pending', message: 'This proposal was already decided.' }
  if (/unsupported_currency/.test(message)) return { status: 409, error: 'unsupported_currency', message: 'The treasury is held in USD; this provider is paid in another currency.' }
  if (/proposal .* not found/.test(message)) return { status: 404, error: 'not_found', message: 'Proposal not found.' }
  if (/was already used with a different amount/.test(message)) return { status: 409, error: 'idempotency_conflict', message: 'This request id was already used for a different amount.' }
  if (/invalid_parameter_value|amount (is out of range|must be non-zero|is required)|sign does not match/.test(message)) return { status: 400, error: 'invalid_input', message: 'Invalid amount.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}
