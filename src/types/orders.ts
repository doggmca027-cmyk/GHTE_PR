import type { OrderStatus } from './smm'
import type { IWallet } from './smm'
import type { Platform } from './catalog'

export interface CreateOrderPayload {
  serviceId: string
  targetUrl: string
  quantity: number
  /** Generated once per opened drawer; makes retries / double-taps safe. */
  idempotencyKey: string
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
  createdAt: string
}
