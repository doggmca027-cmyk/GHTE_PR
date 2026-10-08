import type { IWallet } from '@/types'

export type OrderErrorCode =
  | 'invalid_input'
  | 'insufficient_funds'
  | 'service_unavailable'
  | 'provider_rejected'
  | 'refund_pending'
  | 'banned'
  | 'unauthorized'
  | 'idempotency_conflict'
  | 'promo_not_found'
  | 'promo_expired'
  | 'promo_exhausted'
  | 'promo_already_used'
  | 'promo_not_applicable'
  /** Connection lost / timed out: the order MAY have been created. Retrying with the same key is safe. */
  | 'network'
  | 'server'

export class OrderApiError extends Error {
  readonly code: OrderErrorCode
  /** Missing funds (insufficient_funds only). */
  readonly shortfall?: number
  /** Latest wallet, when the server returned one (e.g. after an automatic refund). */
  readonly wallet?: IWallet

  constructor(code: OrderErrorCode, message: string, extra: { shortfall?: number; wallet?: IWallet } = {}) {
    super(message)
    this.name = 'OrderApiError'
    this.code = code
    this.shortfall = extra.shortfall
    this.wallet = extra.wallet
  }

  /** After these the previous idempotency key is spent / unknown and must NOT be reused for new input. */
  get isDefinitive(): boolean {
    return this.code !== 'network' && this.code !== 'server'
  }
}
