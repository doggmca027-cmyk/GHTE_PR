// Provider payment reconciliation detector. Pure TypeScript twin of public.provider_payment_issue() (migration
// 20261027000000_payment_reconciliation.sql): same rules, same thresholds, same reason text, and a parity test runs both
// on the same payments. The database copy is the one that opens cases: sync_reconciliation_cases() runs it every
// 5 minutes (pg_cron) and on every load of the Reconciliation tab. This copy lets admin-treasury show the same verdict
// live next to each payment.
//
//   Rule A  CONFIRMED for over 30 minutes and still not COMPLETED. The reason states whether the provider balance rose
//           in proportion to the amount (at least 90% of it, adding back what orders charged to that provider since the
//           snapshot taken when the transfer was prepared), did not, or cannot be compared.
//   Rule B  BROADCASTED or CONFIRMING for over 4 hours (time since the broadcast was recorded).
//   Always  UNKNOWN / RECONCILIATION_REQUIRED: the outcome is unknown until an admin decides.

export const CONFIRMED_GRACE_MINUTES = 30
export const LIMBO_HOURS = 4
/** At least this share of the amount must show up on the provider balance to count as credited (fees, rate rounding). */
export const MIN_CREDIT_PERCENT = 90

export type PaymentIssueRule = 'confirmed_not_completed' | 'stuck_in_limbo' | 'outcome_unknown'
export type CreditVerdict = 'credited' | 'not_credited' | 'unverifiable'

export interface PaymentIssue {
  rule: PaymentIssueRule
  /** Rule A only: what the provider balance says. */
  verdict?: CreditVerdict
  /** The discrepancy in plain language (stored as the case reason). */
  reason: string
}

/** Everything the detector looks at (one row of list_provider_payments). */
export interface PaymentEvidence {
  status: string
  amount: number
  currency: string
  failureReason: string | null
  broadcastedAt: string | null
  confirmedAt: string | null
  updatedAt: string
  /** The provider's cached balance when the transfer instruction was created; null if it had never been read. */
  providerBalanceBefore: number | null
  providerBalance: number
  providerCurrency: string
  providerBalanceSyncedAt: string | null
  /** Provider cost of the orders placed with this provider since that snapshot (they lower its balance meanwhile). */
  spentSince: number
}

const MINUTE = 60_000

/** "$12.30", "-$1.05"; signed: "+$4.00". Half away from zero to the cent, like SQL round(x, 2) (recon_money). */
export function reconMoney(amount: number, signed = false): string {
  const cents = Math.round(Number((Math.abs(amount) * 100).toFixed(6)))
  const sign = amount < 0 && cents > 0 ? '-' : signed ? '+' : ''
  return `${sign}$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** "2026-10-07 12:00 UTC", seconds dropped (recon_utc). */
export const reconUtc = (iso: string): string => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** Amounts are numeric(14,4): compare them as exact integers of 1/10000, never as floats. */
const units = (x: number) => Math.round(Number((x * 10_000).toFixed(2)))

/** null = nothing to reconcile. `now` in epoch ms. */
export function detectPaymentIssue(p: PaymentEvidence, now: number = Date.now()): PaymentIssue | null {
  if (p.status === 'UNKNOWN' || p.status === 'RECONCILIATION_REQUIRED') {
    return { rule: 'outcome_unknown', reason: `outcome unknown: ${p.failureReason ?? ''}`.slice(0, 500) }
  }

  // Rule B: the transfer left (a hash was recorded) but the chain never confirmed it
  if (p.status === 'BROADCASTED' || p.status === 'CONFIRMING') {
    const at = p.broadcastedAt ?? p.updatedAt
    if (now - Date.parse(at) <= LIMBO_HOURS * 60 * MINUTE) return null
    return {
      rule: 'stuck_in_limbo',
      reason: `Stuck in ${p.status} for over ${LIMBO_HOURS} h: broadcast recorded at ${reconUtc(at)} and never confirmed on chain. Check the transaction in an explorer, then advance the payment or mark it failed.`,
    }
  }

  // Rule A: final on chain, but nobody verified that the provider credited it
  if (p.status !== 'CONFIRMED') return null
  const at = p.confirmedAt ?? p.updatedAt
  if (now - Date.parse(at) <= CONFIRMED_GRACE_MINUTES * MINUTE) return null
  const head = `Confirmed on chain at ${reconUtc(at)} but not completed after ${CONFIRMED_GRACE_MINUTES} min`

  const before = p.providerBalanceBefore
  const why =
    before === null ? 'no balance reading before the transfer'
    : p.providerCurrency !== p.currency ? `provider balance in ${p.providerCurrency}, payment in ${p.currency}`
    : p.providerBalanceSyncedAt === null || Date.parse(p.providerBalanceSyncedAt) <= Date.parse(at) ? 'balance not read since the confirmation'
    : null
  if (before === null || why !== null) {
    return {
      rule: 'confirmed_not_completed',
      verdict: 'unverifiable',
      reason: `${head}. The provider credit cannot be checked automatically (${why}): compare the provider panel with the ${reconMoney(p.amount)} paid.`,
    }
  }

  const net = units(p.providerBalance) - units(before) + units(p.spentSince)
  const credited = reconMoney(net / 10_000, true)
  if (net * 100 >= units(p.amount) * MIN_CREDIT_PERCENT) {
    return {
      rule: 'confirmed_not_completed',
      verdict: 'credited',
      reason: `${head}. The provider balance rose in proportion (${credited} of the ${reconMoney(p.amount)} paid): verify it and complete the payment.`,
    }
  }
  return {
    rule: 'confirmed_not_completed',
    verdict: 'not_credited',
    reason: `${head}, and the provider balance did not rise in proportion: ${credited} of the ${reconMoney(p.amount)} paid (balance ${reconMoney(before)} -> ${reconMoney(p.providerBalance)}, orders since ${reconMoney(p.spentSince)}).`,
  }
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** A list_provider_payments row (snake_case JSON) -> the detector's input. */
export function evidenceFromRow(r: Record<string, unknown>): PaymentEvidence {
  return {
    status: String(r.status),
    amount: Number(r.amount ?? 0),
    currency: String(r.currency ?? 'USD'),
    failureReason: text(r.failure_reason),
    broadcastedAt: text(r.broadcasted_at),
    confirmedAt: text(r.confirmed_at),
    updatedAt: String(r.updated_at),
    providerBalanceBefore: r.provider_balance_before === null || r.provider_balance_before === undefined ? null : Number(r.provider_balance_before),
    providerBalance: Number(r.provider_balance ?? 0),
    providerCurrency: String(r.provider_currency ?? 'USD'),
    providerBalanceSyncedAt: text(r.provider_balance_synced_at),
    spentSince: Number(r.spent_since ?? 0),
  }
}
