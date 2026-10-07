// Provider payment engine: drives a VALIDATED provider_payment through the outbound transfer, with all I/O injected
// (database ports + a broadcaster), so every outcome is unit-testable. The money gate itself (limits, reserve, treasury
// debit) is validate_provider_payment() in the database; nothing here can move money without it.
//
// Money rules (same as orders):
//   * a definitive refusal BEFORE anything was sent  -> FAILED, the treasury gets the money back
//   * anything uncertain after sending (timeout, lost connection, the hash could not be saved) -> UNKNOWN ->
//     RECONCILIATION_REQUIRED; nothing is given back and nothing is re-sent automatically
//   * a broadcast is never repeated: the payment's idempotency key goes with every request

export interface PaymentInstruction {
  paymentId: string
  destinationWallet: string
  amount: number
  asset: string
  network: string
  idempotencyKey: string
}

export interface PaymentBroadcaster {
  /** Sends the transfer. Resolves with the transaction hash; throws BroadcastRejected if it definitively did not go out. */
  broadcast(instruction: PaymentInstruction): Promise<{ txHash: string }>
}

/** The transfer definitively did NOT leave (e.g. the signer refused, invalid destination). Safe to give the money back. */
export class BroadcastRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BroadcastRejected'
  }
}

export interface PaymentPorts {
  /** VALIDATED -> PAYMENT_CREATED; returns the instruction built from the payment's server-side terms. */
  createInstruction(paymentId: string): Promise<PaymentInstruction>
  recordBroadcast(paymentId: string, txHash: string): Promise<void>
  markUnknown(paymentId: string, reason: string): Promise<void>
  fail(paymentId: string, reason: string): Promise<void>
  advance(paymentId: string, to: 'CONFIRMING' | 'CONFIRMED' | 'PROVIDER_BALANCE_VERIFIED' | 'COMPLETED'): Promise<void>
}

export type ExecuteOutcome =
  | { kind: 'broadcasted'; txHash: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown'; reason: string }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** PAYMENT_CREATED -> BROADCASTED | FAILED (money back) | RECONCILIATION_REQUIRED (unknown). */
export async function executeProviderPayment(paymentId: string, ports: PaymentPorts, broadcaster: PaymentBroadcaster): Promise<ExecuteOutcome> {
  const instruction = await ports.createInstruction(paymentId)
  let txHash: string
  try {
    txHash = (await broadcaster.broadcast(instruction)).txHash
  } catch (e) {
    if (e instanceof BroadcastRejected) {
      await ports.fail(paymentId, `broadcast rejected: ${msg(e)}`)
      return { kind: 'failed', reason: msg(e) }
    }
    const reason = `broadcast outcome unknown: ${msg(e)}`
    await ports.markUnknown(paymentId, reason)
    return { kind: 'unknown', reason }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ports.recordBroadcast(paymentId, txHash)
      return { kind: 'broadcasted', txHash }
    } catch {
      // retried once below; the hash must not be lost
    }
  }
  const reason = `broadcast succeeded as ${txHash} but recording it failed`
  await ports.markUnknown(paymentId, reason)
  return { kind: 'unknown', reason }
}

export interface ConfirmChecks {
  /** true = confirmed on chain, false = definitively failed on chain, null = not known yet. */
  chainConfirmed(txHash: string): Promise<boolean | null>
  /** Has the provider's balance at the panel risen by (about) the paid amount? null = cannot tell yet. */
  providerBalanceCredited(): Promise<boolean | null>
}

export type ConfirmOutcome = { kind: 'completed' } | { kind: 'waiting'; at: string } | { kind: 'failed' } | { kind: 'reconciliation' }

/** BROADCASTED -> CONFIRMING -> CONFIRMED -> PROVIDER_BALANCE_VERIFIED -> COMPLETED, one safe step at a time. */
export async function confirmProviderPayment(
  payment: { id: string; status: string; txHash: string | null },
  checks: ConfirmChecks,
  ports: PaymentPorts,
): Promise<ConfirmOutcome> {
  let status = payment.status
  if (!payment.txHash) return { kind: 'waiting', at: status }
  if (status === 'BROADCASTED') {
    await ports.advance(payment.id, 'CONFIRMING')
    status = 'CONFIRMING'
  }
  if (status === 'CONFIRMING') {
    const confirmed = await checks.chainConfirmed(payment.txHash)
    if (confirmed === null) return { kind: 'waiting', at: status }
    if (confirmed === false) {
      await ports.fail(payment.id, 'transaction failed on chain')
      return { kind: 'failed' }
    }
    await ports.advance(payment.id, 'CONFIRMED')
    status = 'CONFIRMED'
  }
  if (status === 'CONFIRMED') {
    const credited = await checks.providerBalanceCredited()
    if (credited === null) return { kind: 'waiting', at: status }
    if (credited === false) {
      // the money left us (confirmed on chain) but the provider does not show it: a human must look, nothing is reversed
      await ports.markUnknown(payment.id, 'confirmed on chain but the provider balance did not increase')
      return { kind: 'reconciliation' }
    }
    await ports.advance(payment.id, 'PROVIDER_BALANCE_VERIFIED')
    status = 'PROVIDER_BALANCE_VERIFIED'
  }
  if (status === 'PROVIDER_BALANCE_VERIFIED') {
    await ports.advance(payment.id, 'COMPLETED')
    return { kind: 'completed' }
  }
  return { kind: 'waiting', at: status }
}

/**
 * Simulated broadcaster (tests and MOCK_MODE only): never touches a blockchain. The hash is derived from the idempotency
 * key, so a repeated call for the same payment returns the same hash.
 */
export function mockBroadcastToBlockchain(behaviour: 'ok' | 'reject' | 'timeout' = 'ok'): PaymentBroadcaster {
  return {
    async broadcast(i) {
      if (behaviour === 'reject') throw new BroadcastRejected('mock signer refused')
      if (behaviour === 'timeout') throw new Error('mock broadcast timed out')
      let h = 0
      for (const c of i.idempotencyKey) h = (h * 31 + c.charCodeAt(0)) >>> 0
      return { txHash: `mock-${h.toString(16).padStart(8, '0')}-${i.paymentId.slice(0, 8)}` }
    },
  }
}
