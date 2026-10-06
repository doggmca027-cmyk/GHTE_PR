import type { OrderStatus } from './types.ts'

// TypeScript mirror of is_valid_order_transition() in 20261006000000_init_smm_schema.sql.
// The database is the authority (a trigger enforces it); this copy only lets workers plan
// multi-step moves without a round trip. tests/order-status-sync.test.ts compares the two
// for every (from, to) pair, so they cannot drift apart unnoticed.
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  draft: ['awaiting_payment', 'canceled'],
  awaiting_payment: ['paid', 'canceled', 'failed'],
  paid: ['processing', 'submitted', 'canceled', 'failed', 'refunded'],
  processing: ['submitted', 'canceled', 'failed'],
  submitted: ['in_progress', 'completed', 'partial', 'canceled', 'failed'],
  in_progress: ['completed', 'partial', 'canceled', 'failed'],
  completed: ['refunded'],
  partial: ['refunded'],
  canceled: ['refunded'],
  failed: ['refunded'],
  refunded: [],
}

export const ALL_ORDER_STATUSES = Object.keys(ALLOWED) as OrderStatus[]

export const isValidOrderTransition = (from: OrderStatus, to: OrderStatus): boolean => ALLOWED[from].includes(to)
