import type { OrderStatus } from './smm'

export type { AdminMetrics } from '../../supabase/functions/_shared/admin-metrics.ts'

export interface ProviderStatus {
  id: string
  name: string
  isActive: boolean
  /** Last cached balance (refreshed by sync-catalog). */
  balance: number
  balanceUpdatedAt: string | null
  lastSyncedAt: string | null
  activeServices: number
}

export interface ReconciliationOrder {
  id: string
  status: OrderStatus
  chargeAmount: number
  quantity: number
  targetUrl: string
  providerOrderId: string | null
  errorMessage: string | null
  createdAt: string
  serviceName: string
  username: string | null
  telegramId: number
}

export interface PriceRuleView {
  id: string
  name: string
  type: 'percentage' | 'fixed' | 'tier'
  value: number
  isActive: boolean
  priority: number
  /** "Global", "Platform: telegram", "Category: ...", "Service: ..." */
  scope: string
}
