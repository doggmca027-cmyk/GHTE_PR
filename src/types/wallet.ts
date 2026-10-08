import type { IWallet } from './smm'

export type DepositAsset = 'TON' | 'USDT'

export type LedgerType = 'deposit' | 'purchase' | 'refund' | 'bonus' | 'manual_adjustment' | 'ad_reward'
export type LedgerStatus = 'pending' | 'completed' | 'failed' | 'canceled'

/** A wallet_transactions row (or a pending deposit shown alongside the ledger). */
export interface LedgerEntry {
  id: string
  type: LedgerType
  status: LedgerStatus
  /** Signed USD delta: positive credits, negative debits. */
  amount: number
  balanceAfter: number | null
  description: string | null
  createdAt: string
  /** Set on pending-deposit rows; lets the wallet re-check them against the chain. */
  depositId?: string
}

export type LedgerFilter = 'all' | 'deposits' | 'purchases' | 'refunds'

export interface DepositQuote {
  asset: DepositAsset
  amountUsd: number
  /** Exact decimal string, e.g. "2.000000000". */
  amountCrypto: string
  /** Exact base units (nanoton) as a string. */
  amountNano: string
  /** USD per 1 whole asset. */
  rateUsd: number
  network: 'mainnet' | 'testnet'
}

export interface DepositIntent extends DepositQuote {
  depositId: string
  memo: string
  recipientAddress: string
  /** Unix seconds. */
  validUntil: number
}

export interface VerifyResult {
  status: 'completed' | 'pending'
  wallet?: IWallet
}
