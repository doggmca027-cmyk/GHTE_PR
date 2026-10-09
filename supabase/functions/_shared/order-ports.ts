// The PlaceOrderPorts of place-order-flow.ts wired to Supabase. Shared by the place-order function and the funded-orders worker, so an order
// is claimed, settled and refunded the same way whichever of them sends it. Structural db type: this file has no npm imports.
import { IN_FLIGHT_NOTE, PlaceOrderDbError, type OrderRecord, type PlaceOrderPorts } from './place-order-flow.ts'

// deno-lint-ignore no-explicit-any
type DbLike = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any }

export function buildOrderPorts(db: DbLike): PlaceOrderPorts {
  const one = (res: { data: unknown; error: { message: string; code?: string } | null }, what: string): OrderRecord => {
    if (res.error || !res.data) throw new PlaceOrderDbError(res.error?.message ?? `${what}: no data`, res.error?.code)
    return res.data as OrderRecord
  }
  return {
    async placeOrder(a) {
      return one(
        await db.rpc('place_order', {
          p_user_id: a.userId,
          p_service_id: a.serviceId,
          p_target_url: a.targetUrl,
          p_quantity: a.quantity,
          p_provider_offer_id: a.providerOfferId,
          p_provider_id: a.providerId,
          p_provider_service_id: a.providerServiceId,
          p_cost_amount: a.costAmount,
          p_idempotency_key: a.idempotencyKey,
          p_promo_code: a.promoCode ?? null,
          p_allow_unfunded: a.allowUnfunded === true,
        }),
        'place_order',
      )
    },
    async claim(orderId) {
      // Atomic: only the caller that flips paid -> processing gets a row back.
      const { data, error } = await db
        .from('orders')
        .update({ status: 'processing', error_message: IN_FLIGHT_NOTE })
        .eq('id', orderId)
        .eq('status', 'paid')
        .select('*')
        .maybeSingle()
      if (error) throw new PlaceOrderDbError(error.message, error.code)
      return (data as OrderRecord | null) ?? null
    },
    async get(orderId) {
      return one(await db.from('orders').select('*').eq('id', orderId).single(), 'get order')
    },
    async update(orderId, patch) {
      return one(await db.from('orders').update(patch).eq('id', orderId).select('*').single(), 'update order')
    },
    async refund(orderId, comment) {
      return one(await db.rpc('refund_order', { p_order_id: orderId, p_amount: null, p_comment: comment }), 'refund_order')
    },
    async releaseReservation(orderId) {
      const { error } = await db.rpc('release_provider_reservation', { p_order_id: orderId })
      if (error) throw new PlaceOrderDbError(error.message, error.code)
    },
  }
}
