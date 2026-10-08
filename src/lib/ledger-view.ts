import type { LedgerFilter, LedgerType } from '@/types/wallet'

export const LEDGER_FILTERS: { id: LedgerFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'deposits', label: 'Deposits' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'refunds', label: 'Refunds' },
]

export function matchesLedgerFilter(type: LedgerType, filter: LedgerFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'deposits': return type === 'deposit'
    case 'purchases': return type === 'purchase'
    case 'refunds': return type === 'refund'
  }
}

export const LEDGER_LABELS: Record<LedgerType, string> = {
  deposit: 'Deposit',
  purchase: 'Purchase',
  refund: 'Refund',
  bonus: 'Bonus',
  manual_adjustment: 'Adjustment',
  ad_reward: 'Ad reward',
}
