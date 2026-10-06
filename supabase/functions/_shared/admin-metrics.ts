// TypeScript twin of get_admin_metrics() (see 20261010000000_admin_and_notifications.sql).
// Used by dev mock mode, and tests/admin-and-notifications.test.ts runs both on the same data so
// the two implementations cannot drift apart. Integer 1e-4 units throughout (no float drift).

import type { OrderStatus } from './types.ts'

export interface MetricOrder {
  status: OrderStatus
  charge_amount: number
  cost_amount: number
  quantity: number
  remains: number | null
  partial_refund_amount: number
  error_message: string | null
  created_at: string
}

export interface AdminMetrics {
  grossRevenue: number
  estimatedCost: number
  grossProfit: number
  /** Percent with 2 decimals, or null when there is no revenue. */
  marginPct: number | null
  pendingRevenue: number
  totalOrders: number
  activeOrders: number
  problematicOrders: number
  totalUsers: number
  userBalances: number
  depositsTotal: number
}

export const INFLIGHT_GRACE_MS = 10 * 60 * 1000
const ACTIVE: OrderStatus[] = ['awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress']

const U = 10_000
const units = (n: number) => Math.round(n * U)

/** round-half-up(a * b / c) on non-negative integers, like PostgreSQL round(numeric, 4) */
const mulDivRound = (a: number, b: number, c: number) => Math.floor((a * b * 2 + c) / (2 * c))

export function computeAdminMetrics(
  orders: MetricOrder[],
  extras: { totalUsers: number; userBalances: number; depositsTotal: number },
  now: number = Date.now(),
): AdminMetrics {
  let revenue = 0
  let cost = 0
  let pending = 0
  let active = 0
  let problematic = 0
  let total = 0

  for (const o of orders) {
    if (o.status !== 'draft') total++
    const charge = units(o.charge_amount)
    if (o.status === 'completed') {
      revenue += charge
      cost += units(o.cost_amount)
    } else if (o.status === 'partial') {
      revenue += charge - units(o.partial_refund_amount)
      cost += mulDivRound(units(o.cost_amount), o.quantity - (o.remains ?? 0), o.quantity)
    }
    if (ACTIVE.includes(o.status)) {
      active++
      pending += charge
    }
    const heldTooLong = o.status === 'processing' && now - Date.parse(o.created_at) > INFLIGHT_GRACE_MS
    const owesRefund = o.status !== 'processing' && (o.error_message ?? '').startsWith('needs_')
    if (heldTooLong || owesRefund) problematic++
  }

  const profit = revenue - cost
  return {
    grossRevenue: revenue / U,
    estimatedCost: cost / U,
    grossProfit: profit / U,
    marginPct: revenue > 0 ? Math.round((profit / revenue) * 10_000) / 100 : null,
    pendingRevenue: pending / U,
    totalOrders: total,
    activeOrders: active,
    problematicOrders: problematic,
    totalUsers: extras.totalUsers,
    userBalances: extras.userBalances,
    depositsTotal: extras.depositsTotal,
  }
}

/** Maps the get_admin_metrics() JSON (snake_case, numerics possibly as strings) to AdminMetrics. */
export function metricsFromRpc(raw: Record<string, unknown>): AdminMetrics {
  const n = (k: string) => Number(raw[k] ?? 0)
  return {
    grossRevenue: n('gross_revenue'),
    estimatedCost: n('estimated_cost'),
    grossProfit: n('gross_profit'),
    marginPct: raw.margin_pct === null || raw.margin_pct === undefined ? null : Number(raw.margin_pct),
    pendingRevenue: n('pending_revenue'),
    totalOrders: n('total_orders'),
    activeOrders: n('active_orders'),
    problematicOrders: n('problematic_orders'),
    totalUsers: n('total_users'),
    userBalances: n('user_balances'),
    depositsTotal: n('deposits_total'),
  }
}

/**
 * Same predicate as admin_reconciliation_queue(): orders that need a human.
 * (processing for longer than the in-flight grace, or any `needs_*` note), excluding settled orders.
 */
export function inReconciliationQueue(
  o: { status: OrderStatus; error_message: string | null; created_at: string },
  now: number = Date.now(),
): boolean {
  if (['refunded', 'completed', 'partial', 'draft'].includes(o.status)) return false
  const heldTooLong = o.status === 'processing' && now - Date.parse(o.created_at) > INFLIGHT_GRACE_MS
  // For `processing` only age decides (every in-flight order carries a needs_reconciliation note).
  return heldTooLong || (o.status !== 'processing' && (o.error_message ?? '').startsWith('needs_'))
}
