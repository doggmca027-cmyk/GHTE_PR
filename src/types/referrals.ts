// Request / response shapes of the referrals Edge Function (POST, signed-in users). No UI uses them yet.
// The affiliate balance is never stored: it is the sum of the append-only referral ledger.

export interface AffiliateBalance {
  /** Everything earned and not yet withdrawn or clawed back. Can be negative after a late clawback; it is then recovered from new rewards. */
  total: number
  /** Rewards still inside the hold period (a late provider failure can still claw them back). */
  pending: number
  /** What TRANSFER can move to the wallet right now. */
  available: number
}

export type ReferralEntryType = 'reward' | 'clawback' | 'transfer_to_wallet'

export interface ReferralEntry {
  id: string
  type: ReferralEntryType
  /** Signed: rewards are positive, clawbacks and transfers negative. */
  amount: number
  orderId: string | null
  availableAt: string | null
  createdAt: string
}

export interface ReferralSummaryRequest {
  action: 'SUMMARY'
}

export interface ReferralSummaryResponse {
  success: true
  /** Your own invite code. */
  code: string
  /** The Telegram start parameter that carries it: https://t.me/<bot>?startapp=<startParam>. */
  startParam: string
  /** You were invited by someone (the referrer cannot be changed). */
  referred: boolean
  /** Your reward rate in percent of the final charge of an invitee's order. */
  percentage: number
  holdDays: number
  invitees: number
  balance: AffiliateBalance
  recent: ReferralEntry[]
}

/** The code, or the Telegram start parameter ("ref_<code>"). Only valid before your first order. */
export interface ApplyReferralRequest {
  action: 'APPLY_CODE'
  code: string
}

export interface ApplyReferralResponse {
  success: true
  applied: true
  /** The same referrer was already set: nothing changed. */
  alreadyApplied: boolean
}

export interface TransferAffiliateRequest {
  action: 'TRANSFER'
  /** Omitted = everything available. */
  amount?: number
  /** 8-64 characters; a retry with the same key moves the money once. */
  idempotencyKey?: string
}

export interface TransferAffiliateResponse {
  success: true
  transferred: number
  replayed: boolean
  walletBalance: number | null
  balance: AffiliateBalance
}

export type ReferralsRequest = ReferralSummaryRequest | ApplyReferralRequest | TransferAffiliateRequest
