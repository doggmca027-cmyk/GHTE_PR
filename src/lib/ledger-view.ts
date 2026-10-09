import { tr } from '@/i18n'
import type { LedgerFilter, LedgerType } from '@/types/wallet'

export const LEDGER_FILTERS: { id: LedgerFilter; label: string }[] = [
  { id: 'all', label: tr('All') },
  { id: 'deposits', label: tr('Deposits') },
  { id: 'purchases', label: tr('Purchases') },
  { id: 'refunds', label: tr('Refunds') },
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
  deposit: tr('Deposit'),
  purchase: tr('Purchase'),
  refund: tr('Refund'),
  bonus: tr('Bonus'),
  manual_adjustment: tr('Adjustment'),
  ad_reward: tr('Ad reward'),
}
