// Order execution flow, with all I/O injected (PlaceOrderPorts) so every failure path is
// unit-testable. The place-order Edge Function wires the ports to Supabase.
//
// Money safety rules:
//   1. The wallet is debited atomically by the DB (place_order) BEFORE the provider is called.
//   2. Only ONE caller may submit an order: the paid -> processing transition is an atomic claim.
//   3. REFUND only on a definitive "the provider did not create it" signal.
//      HOLD (never refund) whenever the outcome is unknown: timeout, network loss, 5xx,
//      garbled response, or any unexpected error. A held order is flagged `needs_reconciliation`.

import { SMMProviderError } from './smm-v2-adapter.ts'
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

export interface PlaceOrderPorts {
  /** DB function place_order(): creates + pays the order atomically (idempotent per key). */
  placeOrder(args: { userId: string; serviceId: string; targetUrl: string; quantity: number; idempotencyKey: string }): Promise<OrderRecord>
  /** Atomic `paid -> processing` (+ in-flight note). Resolves null if someone else already claimed it. */
  claim(orderId: string): Promise<OrderRecord | null>
  get(orderId: string): Promise<OrderRecord>
  update(orderId: string, patch: OrderPatch): Promise<OrderRecord>
  /** DB function refund_order(): credits the wallet once and moves the order to `refunded`. */
  refund(orderId: string, comment: string): Promise<OrderRecord>
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
  const order = await ports.placeOrder(req)
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
  if (/user is banned/.test(message)) return { httpStatus: 403, error: 'banned', message: 'Your account is suspended.' }
  if (/service not found or inactive/.test(message)) return { httpStatus: 404, error: 'service_unavailable', message: 'This service is no longer available.' }
  if (/quantity must be between/.test(message)) return { httpStatus: 400, error: 'invalid_input', message: message.replace(/^quantity/, 'Quantity') }
  if (/order total is too small/.test(message)) return { httpStatus: 400, error: 'invalid_input', message: 'Order total is too small.' }
  if (/idempotency key .* different parameters/.test(message)) {
    return { httpStatus: 409, error: 'idempotency_conflict', message: 'This request key was already used for a different order.' }
  }
  return { httpStatus: 500, error: 'internal_error', message: 'Something went wrong. You were not charged.' }
}
