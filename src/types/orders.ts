import type { OrderStatus } from './smm'
import type { IWallet } from './smm'
import type { Platform } from './catalog'

export interface CreateOrderPayload {
  serviceId: string
  targetUrl: string
  quantity: number
  /** Generated once per opened drawer; makes retries / double-taps safe. */
  idempotencyKey: string
  /** Optional promo code; the server validates it and prices the order (the client total is never sent). */
  promoCode?: string
  /** Drip-feed: quantity (the total) is delivered in `runs` parts, `interval` minutes apart. Sent only when runs > 1. */
  runs?: number
  interval?: number
}

export interface CreatedOrder {
  id: string
  status: OrderStatus
  chargeAmount: number
  quantity: number
  targetUrl: string
}

export interface CreateOrderResult {
  order: CreatedOrder
  /** True when the provider outcome is still being confirmed (funds are held, nothing to retry). */
  pending: boolean
  /** The order is paid and waits for the provider to be funded (deferred funding): it starts by itself or is refunded after `deferredTtlHours`. */
  awaitingFunds?: boolean
  deferredTtlHours?: number
  /** Fresh wallet from the server, when available. */
  wallet?: IWallet
}

/** A row of the order history, joined with its service/platform for display. */
export interface IOrderView {
  id: string
  serviceName: string
  platform: Platform
  targetUrl: string
  quantity: number
  chargeAmount: number
  status: OrderStatus
  remains: number | null
  startCount: number | null
  /** Money already returned for undelivered units (partial refund) or a cancellation. */
  refundedAmount: number
  /** Paid, and waiting for the service to be connected (the provider is being funded). */
  awaitingFunds: boolean
  /** The service and the provider it went to give a guarantee: a refill can be asked once it is delivered. */
  refillAvailable?: boolean
  /** null = never asked; requested = waiting for the provider; in_progress = the provider is restoring; rejected / completed. */
  refillStatus?: 'requested' | 'in_progress' | 'completed' | 'rejected' | null
  refillRequestedAt?: string | null
  createdAt: string
}
