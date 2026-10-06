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

/** One row of the admin pricing grid (get_admin_pricing_view). Costs are never exposed to customers. */
export interface PricingRow {
  serviceId: string
  name: string
  category: string
  platform: string
  /** Retail price per 1,000. */
  customerRate: number
  /** Cost of the offer routing would pick now; null when no healthy offer exists. */
  bestCost: number | null
  /** customerRate - bestCost; null when bestCost is null. */
  marginAbsolute: number | null
  /** marginAbsolute / customerRate * 100; null when unknown. */
  marginPercent: number | null
}

export interface MarginRuleInput {
  serviceId: string
  type: 'fixed' | 'percentage'
  value: number
}
