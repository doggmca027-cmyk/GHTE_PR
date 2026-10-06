// Client-side view of the deposit primitives. The SAME module the Edge Functions use, so the
// amount maths and the memo payload the wallet signs match what the server verifies.
import { buildCommentBocBase64 } from '../../supabase/functions/_shared/ton.ts'
export {
  DEPOSIT_VALIDITY_SECONDS,
  MAX_DEPOSIT_USD,
  MIN_DEPOSIT_USD,
  buildCommentBocBase64,
  formatBaseUnits,
  generateMemo,
  parseUsdInput,
  quoteDeposit,
  validateDepositAmountUsd,
} from '../../supabase/functions/_shared/ton.ts'

export const DEPOSIT_PRESETS_USD = [5, 10, 25, 50, 100] as const

/** "UQBv…x4Zk" */
export function shortAddress(address: string, head = 4, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
}

/** "2.000000000" -> "2" / "0.1234500" -> "0.12345" for display. */
export function trimCrypto(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount
}

/** TON Connect network ids (CHAIN.MAINNET / CHAIN.TESTNET). */
export const TON_CHAIN = { mainnet: '-239', testnet: '-3' } as const

export interface TonTransactionRequest {
  /** Unix seconds after which the wallet must refuse to sign. */
  validUntil: number
  network: (typeof TON_CHAIN)[keyof typeof TON_CHAIN]
  messages: { address: string; amount: string; payload: string }[]
}

/**
 * The exact request handed to `tonConnectUI.sendTransaction`:
 *   - address: OUR recipient, as returned by the server (never typed by the user)
 *   - amount:  nanoton as a decimal string, as quoted by the server
 *   - payload: base64 BOC of a text comment = the deposit memo (how the server recognises the payment)
 */
export function buildTransactionRequest(
  intent: { recipientAddress: string; amountNano: string; memo: string; validUntil: number; network: 'mainnet' | 'testnet' },
  nowSec: number = Math.floor(Date.now() / 1000),
): TonTransactionRequest {
  return {
    validUntil: Math.min(intent.validUntil, nowSec + 10 * 60),
    network: TON_CHAIN[intent.network],
    messages: [{ address: intent.recipientAddress, amount: intent.amountNano, payload: buildCommentBocBase64(intent.memo) }],
  }
}
