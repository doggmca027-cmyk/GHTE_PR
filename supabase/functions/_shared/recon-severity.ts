// How urgently a human should look at a reconciliation case. Pure and dependency-free (also used by the admin UI).

export type Severity = 'critical' | 'high' | 'normal'

const HOUR = 3_600_000

/**
 * critical: money is owed to a customer (`needs_refund`) or the case is over a day old.
 * high:     the order has been stuck for 2 hours, or a large amount (>= $50) is held.
 * normal:   everything else.
 */
export function caseSeverity(c: { reason: string; createdAt: string; amount: number | null }, now: number = Date.now()): Severity {
  const age = now - Date.parse(c.createdAt)
  if (/^needs_refund/.test(c.reason) || age > 24 * HOUR) return 'critical'
  if (age > 2 * HOUR || (c.amount ?? 0) >= 50) return 'high'
  return 'normal'
}
