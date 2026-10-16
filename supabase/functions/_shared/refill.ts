// The refill ("докрутка") request of a delivered order: parsing, the answer for each refusal, and the flow behind ports so it runs
// unchanged in the request-refill Edge Function and in tests. Every rule (owner, delivered, guarantee window, once a day) is in SQL
// (begin_order_refill); this module only calls the panel and records its answer.

import { SMMProviderError } from './providers/contract.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseRefillBody(body: unknown): { orderId: string } | { error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  return typeof b.orderId === 'string' && UUID.test(b.orderId) ? { orderId: b.orderId.toLowerCase() } : { error: 'orderId must be a UUID.' }
}

/** A refusal of begin_order_refill -> the HTTP answer (500 = not a business error). */
export function mapRefillError(message: string): { status: number; error: string; message: string; retryAfter?: string } {
  if (/order_not_found/.test(message)) return { status: 404, error: 'order_not_found', message: 'Order not found.' }
  if (/user_banned/.test(message)) return { status: 403, error: 'banned', message: 'Your account is suspended.' }
  if (/refill_not_delivered/.test(message)) return { status: 409, error: 'refill_not_delivered', message: 'A refill is possible once the order is delivered.' }
  if (/refill_unavailable/.test(message)) return { status: 409, error: 'refill_unavailable', message: 'This service has no refill.' }
  if (/refill_too_early/.test(message)) return { status: 409, error: 'refill_too_early', message: 'A refill can be requested 24 hours after the order.' }
  if (/refill_expired/.test(message)) return { status: 409, error: 'refill_expired', message: 'The refill guarantee of this order is over.' }
  if (/refill_cooldown/.test(message)) {
    const at = /next after (\S+)/.exec(message)?.[1]
    return { status: 429, error: 'refill_cooldown', message: 'A refill was requested recently. Try again tomorrow.', ...(at ? { retryAfter: at } : {}) }
  }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

export interface RefillPorts {
  /** begin_order_refill: throws with the SQL message on a refusal. */
  begin(userId: string, orderId: string): Promise<{ provider_id: string; provider_order_id: string }>
  /** Asks the panel; returns its refill id or throws SMMProviderError. */
  createRefill(providerId: string, providerOrderId: string): Promise<string>
  finish(orderId: string, ok: boolean, refillId: string | null): Promise<void>
}

export interface RefillAnswer {
  status: number
  body: Record<string, unknown>
}

export async function requestRefill(userId: string, orderId: string, p: RefillPorts): Promise<RefillAnswer> {
  let begun: { provider_id: string; provider_order_id: string }
  try {
    begun = await p.begin(userId, orderId)
  } catch (e) {
    const { status, ...m } = mapRefillError(e instanceof Error ? e.message : '')
    if (status === 500) throw e
    return { status, body: { success: false, ...m } }
  }
  try {
    const refillId = await p.createRefill(begun.provider_id, begun.provider_order_id)
    await p.finish(orderId, true, refillId)
    return { status: 200, body: { success: true, refillStatus: 'in_progress' } }
  } catch (e) {
    // the panel may have taken it (timeout, lost connection): the request stays "requested"; it is not refused, not repeated today
    if (e instanceof SMMProviderError && e.ambiguous) return { status: 202, body: { success: true, refillStatus: 'requested' } }
    await p.finish(orderId, false, null)
    return { status: 409, body: { success: false, error: 'refill_refused', message: 'The provider could not start a refill for this order now. Try again later or contact support.' } }
  }
}
