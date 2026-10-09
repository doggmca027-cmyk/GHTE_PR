// Display maths for the analytics dashboard. Pure: no React, no I/O.
import type { RetentionCohort, RevenueDay } from '@/types/admin-bi'

export interface RevenueTotals {
  orders: number
  revenue: number
  cost: number
  margin: number
  /** Average order value over the period, or null when there were no orders. */
  aov: number | null
  /** Margin as a share of revenue, in percent, or null when there was no revenue. */
  marginPercent: number | null
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

export function revenueTotals(days: RevenueDay[]): RevenueTotals {
  let orders = 0, revenue = 0, cost = 0
  for (const d of days) {
    orders += d.orders
    revenue += d.revenue
    cost += d.cost
  }
  revenue = round4(revenue)
  cost = round4(cost)
  const margin = round4(revenue - cost)
  return {
    orders, revenue, cost, margin,
    aov: orders > 0 ? round4(revenue / orders) : null,
    marginPercent: revenue > 0 ? Math.round((margin / revenue) * 10_000) / 100 : null,
  }
}

/** Bar widths in percent, relative to the largest value. A non-zero value always gets a visible sliver. */
export function barPercents(values: number[]): number[] {
  const max = Math.max(0, ...values)
  if (max <= 0) return values.map(() => 0)
  return values.map((v) => (v <= 0 ? 0 : Math.max(2, Math.round((v / max) * 1000) / 10)))
}

/** "2026-05-09" -> "05-09" */
export const shortDay = (day: string): string => day.slice(5, 10)

/** True when nothing was sold in the period (the dashboard then says so instead of drawing empty bars). */
export const noSales = (days: RevenueDay[]): boolean => days.every((d) => d.orders === 0)

/**
 * Retention over all cohorts that are old enough: users active on day N divided by the users who joined, weighted by cohort size.
 * Cohorts too young for day N (null) are left out of both sides.
 */
export function overallRetention(cohorts: RetentionCohort[]): { day: number; users: number; size: number; rate: number | null }[] {
  const byDay = new Map<number, { users: number; size: number }>()
  for (const c of cohorts) {
    for (const r of c.retention) {
      if (r.users === null) continue
      const acc = byDay.get(r.day) ?? { users: 0, size: 0 }
      acc.users += r.users
      acc.size += c.size
      byDay.set(r.day, acc)
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, v]) => ({ day, users: v.users, size: v.size, rate: v.size > 0 ? Math.round((v.users / v.size) * 10_000) / 100 : null }))
}

export const formatRate = (rate: number | null): string => (rate === null ? '–' : `${rate % 1 === 0 ? rate.toFixed(0) : rate.toFixed(1)}%`)

export const FUNNEL_LABELS: Record<string, string> = {
  catalog_view: 'Открыли каталог',
  checkout_started: 'Начали оформление',
  order_placed: 'Сделали заказ',
}
