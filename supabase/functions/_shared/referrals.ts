// Pure logic of the referrals Edge Function: request parsing, mapping database errors to HTTP answers and the response shapes.
// No I/O, so it is unit-testable. The rules themselves (self-referral, loops, locked referrer, rewards, withdrawal) live in SQL
// (apply_referral, guard_user_referral, transfer_affiliate_balance_to_wallet); this file only translates.

export const MAX_AMOUNT = 1_000_000_000

export type ParsedReferralRequest =
  | { action: 'SUMMARY' }
  | { action: 'APPLY_CODE'; code: string }
  | { action: 'TRANSFER'; amount: number | null; idempotencyKey: string | null }

type Obj = Record<string, unknown>

/** Accepts a bare code or the Telegram start parameter ("ref_<code>"). */
export function normalizeReferralCode(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/^ref[_-]/, '')
  return /^[a-z0-9]{6,32}$/.test(text) ? text : null
}

export function parseReferralRequest(body: unknown): ParsedReferralRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : ''

  if (action === 'SUMMARY') return { action }

  if (action === 'APPLY_CODE') {
    if (typeof b.code !== 'string') return { error: 'code must be text.' }
    const code = normalizeReferralCode(b.code)
    return code ? { action, code } : { error: 'That is not a valid referral code.' }
  }

  if (action === 'TRANSFER') {
    let amount: number | null = null
    if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
      if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount <= 0 || b.amount > MAX_AMOUNT) {
        return { error: 'amount must be a number greater than 0.' }
      }
      amount = Math.round(b.amount * 10_000) / 10_000
      if (amount <= 0) return { error: 'amount is too small.' }
    }
    let idempotencyKey: string | null = null
    if (b.idempotencyKey !== undefined && b.idempotencyKey !== null && b.idempotencyKey !== '') {
      if (typeof b.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.idempotencyKey)) {
        return { error: 'idempotencyKey must be 8 to 64 letters, digits, "-" or "_".' }
      }
      idempotencyKey = b.idempotencyKey
    }
    return { action, amount, idempotencyKey }
  }

  return { error: 'Unknown action.' }
}

/** A database error (message of the SQL exception) -> the HTTP answer. 500 means "not a business error". */
export function mapReferralError(message: string): { status: number; error: string; message: string } {
  if (/feature_paused/.test(message)) return { status: 503, error: 'feature_paused', message: 'Transfers are temporarily unavailable. Please try again later.' }
  if (/referral_code_not_found/.test(message)) return { status: 404, error: 'referral_code_not_found', message: 'That referral code does not exist.' }
  if (/self_referral/.test(message)) return { status: 409, error: 'self_referral', message: 'You cannot use your own referral code.' }
  if (/circular_referral/.test(message)) return { status: 409, error: 'circular_referral', message: 'This referral link cannot be used.' }
  if (/already_referred|referrer_locked/.test(message)) return { status: 409, error: 'already_referred', message: 'A referrer is already set and cannot be changed.' }
  if (/referral_too_late/.test(message)) return { status: 409, error: 'referral_too_late', message: 'Referral codes can only be applied before your first order.' }
  if (/referrer_unavailable/.test(message)) return { status: 409, error: 'referrer_unavailable', message: 'This referral link cannot be used.' }
  if (/insufficient_affiliate_balance/.test(message)) return { status: 409, error: 'insufficient_affiliate_balance', message: 'There is not enough available affiliate balance.' }
  if (/idempotency_conflict/.test(message)) return { status: 409, error: 'idempotency_conflict', message: 'This request key was already used.' }
  if (/user_banned/.test(message)) return { status: 403, error: 'banned', message: 'Your account is suspended.' }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: message.replace(/^.*invalid_parameter_value: ?/, '') || 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

const n = (v: unknown) => Number(v ?? 0)

/** referral_summary() -> the camelCase answer. Money is rounded to the platform's 1e-4 unit. */
export function toSummaryDto(r: Obj) {
  const balance = (r.balance ?? {}) as Obj
  const recent = Array.isArray(r.recent) ? (r.recent as Obj[]) : []
  return {
    code: String(r.code),
    /** The Telegram start parameter that carries this code. */
    startParam: `ref_${String(r.code)}`,
    referred: r.referred === true,
    percentage: n(r.percentage),
    holdDays: n(r.hold_days),
    invitees: n(r.invitees),
    balance: { total: n(balance.total), pending: n(balance.pending), available: n(balance.available) },
    recent: recent.map((e) => ({
      id: String(e.id), type: String(e.type), amount: n(e.amount), orderId: (e.order_id as string | null) ?? null,
      availableAt: (e.available_at as string | null) ?? null, createdAt: String(e.created_at),
    })),
  }
}
