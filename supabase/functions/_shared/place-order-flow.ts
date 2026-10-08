// Order execution flow, with all I/O injected (PlaceOrderPorts) so every failure path is
// unit-testable. The place-order Edge Function wires the ports to Supabase.
//
// Money safety rules:
//   1. The wallet is debited atomically by the DB (place_order) BEFORE the provider is called.
//   2. Only ONE caller may submit an order: the paid -> processing transition is an atomic claim.
//   3. REFUND only on a definitive "the provider did not create it" signal.
//      HOLD (never refund) whenever the outcome is unknown: timeout, network loss, 5xx,
//      garbled response, or any unexpected error. A held order is flagged `needs_reconciliation`.

import { SMMProviderError } from './providers/contract.ts'
import type { ISMMProviderAdapter, OrderStatus } from './types.ts'

export const NEEDS_RECONCILIATION = 'needs_reconciliation'
/** Written at claim time, so even a crash mid-submission leaves a discoverable marker. */
export const IN_FLIGHT_NOTE = `${NEEDS_RECONCILIATION}: submission in flight`

export interface OrderRecord {
  id: string
  user_id: string
  service_id: string
  target_url: string
  quantity: number
  charge_amount: number
  status: OrderStatus
  provider_order_id: string | null
  error_message: string | null
  /** Routing snapshot written by place_order (null only on orders created before Phase 1C). */
  provider_offer_id?: string | null
  provider_id?: string | null
}

export class PlaceOrderDbError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'PlaceOrderDbError'
    this.code = code
  }
}

export interface OrderPatch {
  status: OrderStatus
  provider_order_id?: string
  error_message?: string | null
}

/** What place_order receives: the request plus the routing decision. */
export interface PlaceOrderArgs {
  userId: string
  serviceId: string
  targetUrl: string
  quantity: number
  idempotencyKey: string
  providerOfferId: string
  providerId: string
  providerServiceId: string
  /** Provider cost of this order: round(offer.costPer1000 * quantity / 1000, 4). */
  costAmount: number
}

export interface PlaceOrderPorts {
  /** DB function place_order(): validates the chosen offer, snapshots it, creates + pays the order atomically (idempotent per key). */
  placeOrder(args: PlaceOrderArgs): Promise<OrderRecord>
  /** Atomic `paid -> processing` (+ in-flight note). Resolves null if someone else already claimed it. */
  claim(orderId: string): Promise<OrderRecord | null>
  get(orderId: string): Promise<OrderRecord>
  update(orderId: string, patch: OrderPatch): Promise<OrderRecord>
  /** DB function refund_order(): credits the wallet once and moves the order to `refunded`. */
  refund(orderId: string, comment: string): Promise<OrderRecord>
  /**
   * DB function release_provider_reservation(): gives the provider-balance reservation back after a CLEAN rejection
   * (the provider did not create the order). Idempotent. Optional so older callers keep working.
   */
  releaseReservation?(orderId: string): Promise<void>
}

export type PlaceOrderResult =
  /** Provider accepted the order. */
  | { kind: 'submitted'; order: OrderRecord }
  /** Outcome unknown (or DB bookkeeping failed after provider success): funds are held, flagged for reconciliation. */
  | { kind: 'pending'; order: OrderRecord; reason: string }
  /** Provider definitively rejected it; the user was refunded. */
  | { kind: 'rejected'; order: OrderRecord; message: string }
  /** Provider rejected it but the automatic refund failed: needs manual attention. */
  | { kind: 'refund_failed'; order: OrderRecord; message: string }
  /** Idempotent replay (or lost claim race): nothing was sent to the provider by this call. */
  | { kind: 'replayed'; order: OrderRecord }

export interface ProviderErrorClass {
  outcome: 'refund' | 'hold'
  /** Stored in orders.error_message (never contains secrets: adapter messages are sanitised). */
  reason: string
  /** Safe to show the user. */
  userMessage: string
}

const USER_MESSAGES: Record<string, string> = {
  invalid_link: 'The provider rejected this link. Please check it and try again.',
  invalid_quantity: 'The provider rejected this quantity. Please try a different amount.',
  invalid_service: 'This service is temporarily unavailable.',
}

export function classifyProviderError(e: unknown): ProviderErrorClass {
  if (!(e instanceof SMMProviderError)) {
    // Unknown failure after we may already have sent the request: never refund on uncertainty.
    return { outcome: 'hold', reason: `unexpected: ${e instanceof Error ? e.message : 'unknown'}`.slice(0, 300), userMessage: '' }
  }
  if (e.ambiguous) {
    return { outcome: 'hold', reason: `${e.kind}${e.httpStatus ? ` ${e.httpStatus}` : ''}: ${e.message}`.slice(0, 300), userMessage: '' }
  }
  return {
    outcome: 'refund',
    reason: `provider_rejected: ${e.kind}/${e.code}: ${e.message}`.slice(0, 300),
    userMessage: USER_MESSAGES[e.code] ?? 'The provider could not accept this order right now.',
  }
}

export interface PlaceOrderRequest {
  userId: string
  serviceId: string
  targetUrl: string
  quantity: number
  idempotencyKey: string
  /** Routing decision (selectBestOffer), taken from the database, never from the client. */
  providerOfferId: string
  providerId: string
  providerServiceId: string
  costAmount: number
  /** The provider's own id for the service, read from the database (never from the client). */
  externalServiceId: string
}

interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export async function executePlaceOrder(
  req: PlaceOrderRequest,
  ports: PlaceOrderPorts,
  adapter: Pick<ISMMProviderAdapter, 'createOrder'>,
  log: Logger = console,
): Promise<PlaceOrderResult> {
  // 1. Atomic debit + order creation (idempotent: a replay returns the existing order).
  const { externalServiceId: _external, ...placeArgs } = req
  const order = await ports.placeOrder(placeArgs)
  if (order.status !== 'paid') return { kind: 'replayed', order }

  // 2. Exactly one caller wins the right to talk to the provider.
  const claimed = await ports.claim(order.id)
  if (!claimed) return { kind: 'replayed', order: await ports.get(order.id) }

  // 3. Submit.
  let providerOrderId: string
  try {
    providerOrderId = (
      await adapter.createOrder({ serviceId: req.externalServiceId, link: claimed.target_url, quantity: claimed.quantity })
    ).orderId
  } catch (e) {
    const cls = classifyProviderError(e)

    if (cls.outcome === 'hold') {
      log.warn(`place-order: order ${claimed.id} outcome unknown, holding for reconciliation: ${cls.reason}`)
      const note = `${NEEDS_RECONCILIATION}: ${cls.reason}`.slice(0, 400)
      const held = await ports.update(claimed.id, { status: 'processing', error_message: note }).catch(() => claimed)
      return { kind: 'pending', order: held, reason: cls.reason }
    }

    // Definitive rejection: mark failed (keeps the reason in history), then refund.
    log.warn(`place-order: order ${claimed.id} rejected by provider: ${cls.reason}`)
    const failed = await ports.update(claimed.id, { status: 'failed', error_message: cls.reason })
    // The provider did not create it, so it did not spend our money there either: release the reservation. Best effort:
    // a failure here only leaves the cached balance low until the health monitor re-reads the real one.
    await ports.releaseReservation?.(failed.id).catch((e) => log.warn(`place-order: reservation of ${failed.id} not released`, e))
    try {
      const refunded = await ports.refund(failed.id, 'Provider rejected order')
      return { kind: 'rejected', order: refunded, message: cls.userMessage }
    } catch (refundError) {
      log.error(`place-order: CRITICAL refund failed for order ${failed.id}`, refundError)
      const flagged = await ports
        .update(failed.id, { status: 'failed', error_message: `needs_refund: ${cls.reason}`.slice(0, 400) })
        .catch(() => failed)
      return { kind: 'refund_failed', order: flagged, message: cls.userMessage }
    }
  }

  // 4. Provider accepted. Persist its id (one retry); never refund from here on.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const submitted = await ports.update(claimed.id, { status: 'submitted', provider_order_id: providerOrderId, error_message: null })
      return { kind: 'submitted', order: submitted }
    } catch (e) {
      log.error(`place-order: failed to record provider order ${providerOrderId} for ${claimed.id} (attempt ${attempt + 1})`, e)
    }
  }
  const note = `${NEEDS_RECONCILIATION}: provider accepted as ${providerOrderId} but database update failed`
  const held = await ports.update(claimed.id, { status: 'processing', error_message: note }).catch(() => claimed)
  return { kind: 'pending', order: held, reason: 'database update failed after provider acceptance' }
}

// ---------------------------------------------------------------------------
// Database error mapping
// ---------------------------------------------------------------------------

export interface MappedError {
  httpStatus: number
  error: string
  message: string
  /** Missing funds, when error === 'insufficient_funds'. */
  shortfall?: number
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

export function mapDbError(message: string): MappedError {
  const funds = /^insufficient_funds: available (-?[\d.]+), required (-?[\d.]+)/.exec(message)
  if (funds) {
    const available = Number(funds[1])
    const required = Number(funds[2])
    return { httpStatus: 402, error: 'insufficient_funds', message: 'Insufficient balance.', shortfall: round4(Math.max(0, required - available)) }
  }
  if (/insufficient_provider_balance/.test(message)) {
    return { httpStatus: 503, error: 'service_unavailable', message: 'This service is temporarily unavailable. You were not charged.' }
  }
  if (/user is banned/.test(message)) return { httpStatus: 403, error: 'banned', message: 'Your account is suspended.' }
  if (/service not found or inactive/.test(message)) return { httpStatus: 404, error: 'service_unavailable', message: 'This service is no longer available.' }
  if (/provider offer not found|quantity is outside the limits of the selected provider offer|cost does not match/.test(message)) {
    return { httpStatus: 503, error: 'service_unavailable', message: 'This service is temporarily unavailable. You were not charged.' }
  }
  if (/quantity must be between/.test(message)) return { httpStatus: 400, error: 'invalid_input', message: message.replace(/^quantity/, 'Quantity') }
  if (/order total is too small/.test(message)) return { httpStatus: 400, error: 'invalid_input', message: 'Order total is too small.' }
  if (/idempotency key .* different parameters/.test(message)) {
    return { httpStatus: 409, error: 'idempotency_conflict', message: 'This request key was already used for a different order.' }
  }
  return { httpStatus: 500, error: 'internal_error', message: 'Something went wrong. You were not charged.' }
}

// ---------------------------------------------------------------------------
// Failover: ONLY before anything was sent or charged
// ---------------------------------------------------------------------------

/** Thrown by an attempt that stopped before charging the customer or calling the provider (e.g. no API key). */
export class PreSendRejection extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreSendRejection'
  }
}

/**
 * True only for refusals that happen BEFORE the provider call, with the customer's charge rolled back:
 * the provider's cached balance cannot cover the cost (place_order refused the reservation, its whole transaction
 * rolled back), or the attempt could not start. Never true for anything that happened after the request was sent.
 */
export function isPreSendRejection(e: unknown): boolean {
  if (e instanceof PreSendRejection) return true
  return e instanceof PlaceOrderDbError && /insufficient_provider_balance/.test(e.message)
}

/**
 * Tries offers best-first and moves to the next one ONLY on a pre-send refusal. Any other outcome (submitted,
 * pending/unknown, rejected after sending, a database error) is returned or thrown as is: an order whose request
 * reached a provider is never re-sent to another one.
 */
export async function firstAcceptingOffer<O, R>(offers: O[], attempt: (offer: O) => Promise<R>): Promise<R> {
  let last: unknown = new PreSendRejection('no offer available')
  for (const offer of offers) {
    try {
      return await attempt(offer)
    } catch (e) {
      if (!isPreSendRejection(e)) throw e
      last = e
    }
  }
  throw last
}
