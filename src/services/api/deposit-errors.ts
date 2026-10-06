export type DepositErrorCode =
  | 'invalid_input'
  | 'asset_unavailable'
  | 'rate_unavailable'
  | 'deposits_unavailable'
  | 'too_many_pending'
  | 'banned'
  | 'unauthorized'
  | 'underpaid'
  | 'payment_expired'
  | 'tx_already_used'
  | 'chain_unavailable'
  | 'network'
  | 'server'

export class DepositApiError extends Error {
  readonly code: DepositErrorCode
  constructor(code: DepositErrorCode, message: string) {
    super(message)
    this.name = 'DepositApiError'
    this.code = code
  }
}
