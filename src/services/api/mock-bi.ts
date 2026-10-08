// Offline dashboard data for the dev mock mode: deterministic, shaped like the real answer.
import type { BiRange, BiResponse } from '@/types/admin-bi'

export function mockBi(days: BiRange, now = new Date()): BiResponse {
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))
  const revenue = Array.from({ length: days }, (_, i) => {
    const orders = (i * 7 + 3) % 9
    const rev = Math.round(orders * 6.4 * 10_000) / 10_000
    const cost = Math.round(rev * 0.55 * 10_000) / 10_000
    return { day: new Date(day0 + i * 86_400_000).toISOString().slice(0, 10), orders, revenue: rev, cost, margin: Math.round((rev - cost) * 10_000) / 10_000, aov: orders > 0 ? Math.round((rev / orders) * 10_000) / 10_000 : null }
  })
  return {
    success: true, days, from: new Date(day0).toISOString(), to: now.toISOString(),
    funnel: { data: [
      { step: 'catalog_view', users: 240, rateFromPrevious: null, rateFromFirst: 100 },
      { step: 'checkout_started', users: 96, rateFromPrevious: 40, rateFromFirst: 40 },
      { step: 'order_placed', users: 31, rateFromPrevious: 32.29, rateFromFirst: 12.92 },
    ] },
    revenue: { data: revenue },
    retention: { data: Array.from({ length: Math.min(days, 6) }, (_, i) => ({
      cohort: new Date(day0 + i * 86_400_000).toISOString().slice(0, 10), size: 12 + i,
      retention: [{ day: 1, users: 5 + (i % 3), rate: 41.7 }, { day: 7, users: 2, rate: 16.7 }],
    })) },
    topServices: { data: [
      { serviceId: 'demo-1', name: 'Telegram Post Views [Instant]', orders: 42, units: 420_000, revenue: 168.5, margin: 84.25, aov: 4.0119 },
      { serviceId: 'demo-2', name: 'Telegram Channel Members [R30]', orders: 9, units: 4_500, revenue: 81, margin: 40.5, aov: 9 },
    ] },
  }
}
