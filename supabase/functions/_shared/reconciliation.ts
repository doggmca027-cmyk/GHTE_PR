// Pure parts of the admin-reconciliation Edge Function: request validation, error mapping, case severity and the
// retry algorithm (all I/O injected, so every outcome is unit-testable).
import { classifyProviderError } from './place-order-flow.ts'
import type { ISMMProviderAdapter } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ReconRequest =
  | { action: 'GET_CASES' }
  | { action: 'RESOLVE_REFUND'; caseId: string; reason: string | null }
  | { action: 'RESOLVE_RETRY'; caseId: string }
  | { action: 'MARK_RESOLVED'; caseId: string; note: string | null; providerOrderId: string | null }

export function parseReconRequest(body: unknown): ReconRequest | { error: string } {
  if (body === null || body === undefined) return { action: 'GET_CASES' }
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'GET_CASES'
  if (action === 'GET_CASES') return { action: 'GET_CASES' }

  if (action !== 'RESOLVE_REFUND' && action !== 'RESOLVE_RETRY' && action !== 'MARK_RESOLVED') return { error: 'Unknown action.' }
  if (typeof b.caseId !== 'string' || !UUID.test(b.caseId)) return { error: 'caseId must be a UUID.' }
  const caseId = b.caseId.toLowerCase()

  const text = (key: string, max: number): string | null | 'invalid' => {
    const v = b[key]
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') return 'invalid'
    const t = v.trim()
    if (t.length > max) return 'invalid'
    return t === '' ? null : t
  }
  if (action === 'RESOLVE_RETRY') return { action, caseId }
  if (action === 'RESOLVE_REFUND') {
    const reason = text('reason', 200)
    if (reason === 'invalid') return { error: 'reason must be text of at most 200 characters.' }
    return { action, caseId, reason }
  }
  const note = text('note', 300)
  const providerOrderId = text('providerOrderId', 100)
  if (note === 'invalid') return { error: 'note must be text of at most 300 characters.' }
  if (providerOrderId === 'invalid') return { error: 'providerOrderId must be text of at most 100 characters.' }
  return { action, caseId, note, providerOrderId }
}

/** Database errors of the resolver functions -> HTTP. Anything unrecognised is a generic 500 (nothing internal leaks). */
export function mapReconError(message: string): { status: number; error: string; message: string } {
  if (/forbidden/.test(message)) return { status: 403, error: 'forbidden', message: 'Admin access required.' }
  if (/case .* not found|order .* not found/.test(message)) return { status: 404, error: 'not_found', message: 'Case not found.' }
  if (/retry_in_progress/.test(message)) return { status: 409, error: 'retry_in_progress', message: 'A retry is already running for this order. Wait a moment and refresh.' }
  if (/case_not_open/.test(message)) return { status: 409, error: 'case_not_open', message: 'This case was already resolved.' }
  if (/not_retryable/.test(message)) return { status: 409, error: 'not_retryable', message: 'This order cannot be retried. Refund it or mark it resolved.' }
  if (/unsupported_entity/.test(message)) return { status: 409, error: 'unsupported_entity', message: 'This kind of case can only be closed manually.' }
  if (/payment_unresolved/.test(message)) {
    const status = /payment is ([A-Z_]+)/.exec(message)?.[1]
    return {
      status: 409,
      error: 'payment_unresolved',
      message: `The payment${status ? ` (${status})` : ''} still needs a decision. In Treasury -> Provider payments, advance it or mark it failed; the case then closes by itself.`,
    }
  }
  if (/not in the reconciliation queue/.test(message)) return { status: 409, error: 'not_in_queue', message: 'This order no longer needs attention. Refresh the list.' }
  if (/insufficient_funds/.test(message)) return { status: 409, error: 'refund_failed', message: 'The refund could not be booked.' }
  if (/provider order id is required/.test(message)) return { status: 400, error: 'invalid_input', message: 'The provider order id is required to resolve a processing order.' }
  if (/note is required/.test(message)) return { status: 400, error: 'invalid_input', message: 'A note is required.' }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

export { caseSeverity, type Severity } from './recon-severity.ts'

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryPorts {
  /** finish_case_retry: order -> submitted + case -> resolved, atomically. Rejects on a database failure. */
  finish(providerOrderId: string): Promise<void>
  /** release_case_retry: drop the in-progress marker and record why. Never throws into the caller. */
  release(note: string): Promise<void>
}

export type RetryOutcome =
  /** The provider accepted the order and the case is resolved. */
  | { kind: 'submitted'; providerOrderId: string }
  /** The provider definitively refused (it did not create the order). The case stays open: refund it. */
  | { kind: 'rejected'; message: string }
  /** Outcome unknown again (timeout, 5xx...) or the provider accepted but we could not record it. Do NOT retry blindly. */
  | { kind: 'unknown'; message: string }

/**
 * Re-submits ONE held order to the provider it was charged for. Money rules mirror executePlaceOrder:
 * never conclude "failed" from uncertainty, and never lose a provider id the provider has already accepted.
 * Nothing here refunds: after a rejection the admin chooses.
 */
export async function executeRetry(
  input: { externalServiceId: string; link: string; quantity: number },
  ports: RetryPorts,
  adapter: Pick<ISMMProviderAdapter, 'createOrder'>,
  log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void } = console,
): Promise<RetryOutcome> {
  let providerOrderId: string
  try {
    providerOrderId = (await adapter.createOrder({ serviceId: input.externalServiceId, link: input.link, quantity: input.quantity })).orderId
  } catch (e) {
    const cls = classifyProviderError(e)
    if (cls.outcome === 'hold') {
      log.warn(`reconciliation retry: outcome unknown again: ${cls.reason}`)
      await ports.release(`retry outcome unknown: ${cls.reason}`)
      return { kind: 'unknown', message: 'The provider did not answer clearly. It may or may not have created the order: check its panel before doing anything else.' }
    }
    log.warn(`reconciliation retry: provider refused: ${cls.reason}`)
    await ports.release(`retry rejected by provider: ${cls.reason}`)
    return { kind: 'rejected', message: cls.userMessage || 'The provider refused the order.' }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ports.finish(providerOrderId)
      return { kind: 'submitted', providerOrderId }
    } catch (e) {
      log.error(`reconciliation retry: could not record provider order ${providerOrderId} (attempt ${attempt + 1})`, e)
    }
  }
  // The provider HAS the order. The note uses the exact phrase the sync worker recovers the id from (order-sync.ts
  // recoverProviderOrderId), so it attaches the id by itself; "Mark resolved" with that id also finishes the job.
  await ports.release(`provider accepted as ${providerOrderId} but database update failed`)
  return { kind: 'unknown', message: `The provider accepted this order as #${providerOrderId} but saving it failed. Use "Mark resolved" with that id.` }
}
