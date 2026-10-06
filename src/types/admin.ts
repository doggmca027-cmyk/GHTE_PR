import type { OrderStatus } from './smm'

export type { AdminMetrics } from '../../supabase/functions/_shared/admin-metrics.ts'
export type { ProfitAnalytics } from '../../supabase/functions/_shared/admin-analytics.ts'

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

export type ProviderHealth = 'healthy' | 'degraded' | 'unavailable' | 'disabled'

/** A provider as shown in Admin → Providers (admin_list_providers). Never includes the API key. */
export interface ProviderConfigView {
  id: string
  name: string
  isActive: boolean
  routingEnabled: boolean
  health: ProviderHealth
  lastHealthCheck: string | null
  balance: number
  currency: string
  lastBalanceSync: string | null
  lowBalanceThreshold: number
  targetTopupBalance: number
  /** A low-balance alert is outstanding (the balance has not been above the threshold since). */
  lowBalanceAlerted: boolean
}

export interface ProviderConfigPatch {
  lowBalanceThreshold?: number
  targetTopupBalance?: number
  routingEnabled?: boolean
}

export type TreasuryTxType = 'deposit' | 'withdrawal' | 'provider_topup' | 'fee' | 'manual_adjustment'

export interface TreasuryTx {
  id: string
  /** Ledger order and pagination cursor. */
  seq: number
  type: TreasuryTxType
  /** Signed: credits are positive, debits negative. */
  amount: number
  balanceAfter: number
  description: string | null
  referenceId: string | null
  createdAt: string
}

/** A pending top-up proposal filed by the health monitor when a provider's balance is low. */
export interface TopupProposal {
  id: string
  providerId: string
  providerName: string
  amount: number
  currency: string
  createdAt: string
}

export interface TreasuryPage {
  balance: number
  proposals: TopupProposal[]
  updatedAt: string
  transactions: TreasuryTx[]
  /** Cursor (`beforeSeq`) for the next page, or null at the end of the ledger. */
  nextBefore: number | null
}

export interface TreasuryAdjustment {
  /** Signed: positive adds funds, negative removes them. */
  amount: number
  description: string
  /** One key per form submission; re-sending it books the movement once. */
  idempotencyKey: string
}

/** The global emergency switches (admin-settings). Maintenance mode blocks orders AND deposits regardless of the other two. */
export interface PlatformSettingsView {
  globalOrdersEnabled: boolean
  globalPaymentsEnabled: boolean
  maintenanceMode: boolean
  updatedAt: string | null
}

export interface PlatformSettingsPatch {
  ordersEnabled?: boolean
  paymentsEnabled?: boolean
  maintenanceMode?: boolean
}
