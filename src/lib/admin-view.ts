import { recoverProviderOrderId } from '../../supabase/functions/_shared/order-sync.ts'
import { formatUnits, toUnits } from '@/lib/order-calc'

export { recoverProviderOrderId }

export const usd = (amount: number): string => formatUnits(toUnits(amount))

/** "+150%" for percentage / tier markups, "+$0.50 / 1k" for fixed ones. */
export function formatRuleValue(type: 'percentage' | 'fixed' | 'tier', value: number): string {
  return type === 'fixed' ? `+${usd(value)} / 1k` : `+${value}%`
}

/** Below this margin percentage (or any loss) a pricing row is highlighted. */
export const LOW_MARGIN_PERCENT = 10

export function pricingHealth(row: { marginAbsolute: number | null; marginPercent: number | null }): 'loss' | 'low' | 'ok' | 'unknown' {
  if (row.marginAbsolute === null || row.marginPercent === null) return 'unknown'
  if (row.marginAbsolute < 0) return 'loss'
  return row.marginPercent < LOW_MARGIN_PERCENT ? 'low' : 'ok'
}

export interface NoteDescription {
  title: string
  detail: string
  /** True when money is still owed to the customer. */
  refundOwed: boolean
}

/** Turns the machine notes written by place-order / the sync worker into plain language for admins. */
export function describeNote(note: string | null): NoteDescription {
  const text = note ?? ''
  const recovered = recoverProviderOrderId(text)
  if (recovered) {
    return {
      title: 'Provider accepted this order',
      detail: `The provider created it as #${recovered}, but saving that id failed. Resolve it with this id and the sync worker will track it.`,
      refundOwed: false,
    }
  }
  if (text.startsWith('needs_refund')) {
    return { title: 'Refund owed to the customer', detail: text.replace(/^needs_refund:?\s*/, '') || 'An automatic refund did not complete.', refundOwed: true }
  }
  if (text.startsWith('needs_reconciliation')) {
    const reason = text.replace(/^needs_reconciliation:?\s*/, '')
    return {
      title: 'Outcome unknown',
      detail: `${(reason || 'No confirmation from the provider').replace(/[.\s]+$/, '')}. The provider may or may not have created this order: check its panel before refunding.`,
      refundOwed: false,
    }
  }
  return { title: 'Needs attention', detail: text || 'Stuck in processing without a confirmation from the provider.', refundOwed: false }
}

/** Balance relative to the alert threshold: 'low' at or below it (same rule as the monitor), 'ok' above, 'unknown' if never read. */
export function balanceState(balance: number, threshold: number, lastSync: string | null): 'low' | 'ok' | 'unknown' {
  if (lastSync === null) return 'unknown'
  return balance <= threshold ? 'low' : 'ok'
}

/** Parses a non-negative amount with up to 4 decimals; null when invalid. */
export function parseAmount(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(t)) return null
  const n = Number(t)
  return n <= 1_000_000_000 ? n : null
}

const TREASURY_LABELS: Record<string, string> = {
  deposit: 'Deposit', withdrawal: 'Withdrawal', provider_topup: 'Provider top-up', fee: 'Fee', network_fee: 'Network fee', manual_adjustment: 'Manual adjustment',
}
export const treasuryTypeLabel = (type: string): string => TREASURY_LABELS[type] ?? type

/** "+$5.00" / "-$5.00": the signed amount of a ledger row. */
export function signedUsd(amount: number): string {
  return `${amount < 0 ? '-' : '+'}${usd(Math.abs(amount))}`
}

export type AnalyticsRangeKey = 'today' | '7d' | '30d' | 'all'

export const ANALYTICS_RANGES: { key: AnalyticsRangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: 'all', label: 'All Time' },
]

/** Request body for admin-analytics. Omitted endDate = now; null = unbounded (All Time). "Today" starts at the viewer's local midnight. */
export function analyticsRequest(key: AnalyticsRangeKey, now: Date = new Date()): { startDate: string | null; endDate?: null } {
  const DAY = 86_400_000
  if (key === 'all') return { startDate: null, endDate: null }
  if (key === 'today') return { startDate: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() }
  return { startDate: new Date(now.getTime() - (key === '7d' ? 7 : 30) * DAY).toISOString() }
}
