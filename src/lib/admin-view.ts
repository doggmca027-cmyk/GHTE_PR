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
