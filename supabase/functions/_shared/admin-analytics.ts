// Pure parts of the admin-analytics Edge Function plus a TypeScript twin of get_profit_analytics().
// The twin feeds dev mock mode, and tests/analytics.test.ts runs it and the SQL function on the same data so the two
// cannot drift apart. Integer 1e-4 units throughout (no float drift).
import { mulDivRound, units, type MetricOrder } from './admin-metrics.ts'

const DAY_MS = 86_400_000
export const DEFAULT_RANGE_DAYS = 30
const U = 10_000

export interface ProfitAnalytics {
  periodStart: string | null
  periodEnd: string | null
  totalOrders: number
  completedOrders: number
  partialOrders: number
  grossRevenue: number
  providerCost: number
  grossProfit: number
  treasuryFees: number
  netProfit: number
  /** Percent with 2 decimals, or null when there is no revenue. */
  marginPct: number | null
}

export interface DateRange {
  /** ISO timestamp (inclusive), or null for no lower bound. */
  start: string | null
  /** ISO timestamp (exclusive), or null for no upper bound. */
  end: string | null
}

/**
 * Request body -> range. A missing field means "default" (end = now, start = end - 30 days); an explicit null means
 * "unbounded" (this is how "All time" is asked for). Anything that is not a valid ISO date is rejected.
 */
export function parseAnalyticsRange(body: unknown, now: number = Date.now()): DateRange | { error: string } {
  if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body))) return { error: 'Body must be a JSON object.' }
  const b = (body ?? {}) as Record<string, unknown>

  const read = (key: 'startDate' | 'endDate'): number | null | undefined | 'invalid' => {
    if (!(key in b) || b[key] === undefined) return undefined
    if (b[key] === null) return null
    const v = b[key]
    if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}/.test(v)) return 'invalid'
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 'invalid'
  }
  const start = read('startDate')
  const end = read('endDate')
  if (start === 'invalid') return { error: 'startDate must be an ISO date.' }
  if (end === 'invalid') return { error: 'endDate must be an ISO date.' }

  const endMs = end === undefined ? now : end
  const startMs = start === undefined ? (endMs === null ? now - DEFAULT_RANGE_DAYS * DAY_MS : endMs - DEFAULT_RANGE_DAYS * DAY_MS) : start
  if (startMs !== null && endMs !== null && endMs <= startMs) return { error: 'endDate must be after startDate.' }
  return { start: startMs === null ? null : new Date(startMs).toISOString(), end: endMs === null ? null : new Date(endMs).toISOString() }
}

/** Maps the get_profit_analytics() JSON (snake_case, numerics possibly strings) to ProfitAnalytics. */
export function analyticsFromRpc(raw: Record<string, unknown>): ProfitAnalytics {
  const n = (k: string) => Number(raw[k] ?? 0)
  return {
    periodStart: (raw.period_start as string | null) ?? null,
    periodEnd: (raw.period_end as string | null) ?? null,
    totalOrders: n('total_orders'),
    completedOrders: n('completed_orders'),
    partialOrders: n('partial_orders'),
    grossRevenue: n('gross_revenue'),
    providerCost: n('provider_cost'),
    grossProfit: n('gross_profit'),
    treasuryFees: n('treasury_fees'),
    netProfit: n('net_profit'),
    marginPct: raw.margin_pct === null || raw.margin_pct === undefined ? null : Number(raw.margin_pct),
  }
}

/** Same math as get_profit_analytics(), on in-memory rows. */
export function computeProfitAnalytics(
  orders: MetricOrder[],
  fees: { amount: number; created_at: string }[],
  range: DateRange,
): ProfitAnalytics {
  const from = range.start === null ? -Infinity : Date.parse(range.start)
  const to = range.end === null ? Infinity : Date.parse(range.end)
  const within = (iso: string) => {
    const t = Date.parse(iso)
    return t >= from && t < to
  }

  let total = 0, completed = 0, partial = 0, revenue = 0, cost = 0
  for (const o of orders) {
    if (o.status === 'draft' || !within(o.created_at)) continue
    total++
    if (o.status === 'completed') {
      completed++
      revenue += units(o.charge_amount)
      cost += units(o.cost_amount)
    } else if (o.status === 'partial') {
      partial++
      revenue += units(o.charge_amount) - units(o.partial_refund_amount)
      cost += mulDivRound(units(o.cost_amount), o.quantity - (o.remains ?? 0), o.quantity)
    }
  }
  const feeSum = Math.abs(fees.filter((f) => within(f.created_at)).reduce((s, f) => s + units(f.amount), 0))
  const profit = revenue - cost
  return {
    periodStart: range.start,
    periodEnd: range.end,
    totalOrders: total,
    completedOrders: completed,
    partialOrders: partial,
    grossRevenue: revenue / U,
    providerCost: cost / U,
    grossProfit: profit / U,
    treasuryFees: feeSum / U,
    netProfit: (profit - feeSum) / U,
    marginPct: revenue > 0 ? Math.round((profit / revenue) * 10_000) / 100 : null,
  }
}
