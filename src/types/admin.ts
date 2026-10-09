import type { OrderStatus } from './smm'
import type { PaymentView } from '../../supabase/functions/_shared/admin-treasury.ts'

export type { AdminMetrics } from '../../supabase/functions/_shared/admin-metrics.ts'
export type { ProfitAnalytics } from '../../supabase/functions/_shared/admin-analytics.ts'
export type { AlertSeverity, CronPulse, CronState, HealthAlert, OverallStatus, ProviderPulse, SystemHealth } from '../../supabase/functions/_shared/observability.ts'

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

/** A markup on the provider cost. No scope = every service; otherwise exactly one of service / category / platform (slug). */
export interface MarginRuleInput {
  serviceId?: string
  categoryId?: string
  platform?: string
  type: 'fixed' | 'percentage'
  value: number
}

/** Which services the pricing grid shows; the catalogue has thousands, so it comes a page at a time. */
export interface PricingQuery {
  search?: string
  platform?: string
  categoryId?: string
  offset?: number
  limit?: number
}

export interface PricingPage {
  rows: PricingRow[]
  /** Rows matching the filter (not only this page). */
  total: number
}

/** A promo code as shown in Admin → Promo codes (admin-promos). */
export interface PromoView {
  id: string
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  maxUses: number | null
  currentUses: number
  expiresAt: string | null
  isActive: boolean
  createdAt: string
}

export interface PromoInput {
  /** Empty = the server generates "PROMO-XXXXXX". */
  code?: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  maxUses?: number | null
  /** ISO date; empty = never expires. */
  expiresAt?: string | null
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
  /** Routing penalty, 1..10: offers of this provider are ranked as if they cost this many times more. */
  reliabilityPenalty: number
  /** The only destination a top-up of this provider can have (null: top-ups are refused). */
  payoutWallet: string | null
  payoutNetwork: PayoutNetwork
  payoutAsset: PayoutAsset
  /** Hard limits; null means not configured, and then top-ups are refused (never "unlimited"). */
  maxTopupPerTx: number | null
  maxDailyTopup: number | null
  /** Committed to this provider today (UTC, not given back), counted against maxDailyTopup. */
  topupUsedToday: number
}

export type PayoutNetwork = 'mainnet' | 'testnet'
export type PayoutAsset = 'TON' | 'USDT'

/** admin_set_provider_payout: every field is written (the form sends the current values it did not change). */
export interface ProviderPayoutInput {
  wallet: string | null
  network: PayoutNetwork
  asset: PayoutAsset
  maxTopupPerTx: number | null
  maxDailyTopup: number | null
}

export interface ProviderConfigPatch {
  lowBalanceThreshold?: number
  targetTopupBalance?: number
  routingEnabled?: boolean
  reliabilityPenalty?: number
}

export type TreasuryTxType = 'deposit' | 'withdrawal' | 'provider_topup' | 'fee' | 'network_fee' | 'manual_adjustment'

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

export type ProviderPaymentStatus =
  | 'PROPOSED' | 'APPROVED' | 'VALIDATED' | 'PAYMENT_CREATED' | 'BROADCASTED' | 'CONFIRMING' | 'CONFIRMED'
  | 'PROVIDER_BALANCE_VERIFIED' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'RECONCILIATION_REQUIRED' | 'CANCELED'

/** An outbound top-up transfer (admin-treasury GET). Terms are fixed server-side from the provider's payout config. */
export interface ProviderPayment extends Omit<PaymentView, 'status'> {
  status: ProviderPaymentStatus
}

export type PaymentAdvanceTarget = 'CONFIRMING' | 'CONFIRMED' | 'PROVIDER_BALANCE_VERIFIED' | 'COMPLETED'

/** Payment operations; each is one guarded transition in the database. */
export type ProviderPaymentAction =
  | { action: 'CREATE_INSTRUCTION'; paymentId: string }
  | { action: 'RECORD_PAYMENT_BROADCAST'; paymentId: string; txHash: string; markConfirming?: boolean }
  | { action: 'ADVANCE_PAYMENT'; paymentId: string; to: PaymentAdvanceTarget }
  | { action: 'FAIL_PAYMENT' | 'CANCEL_PAYMENT'; paymentId: string; reason: string }

export interface TreasuryPage {
  balance: number
  /** Payments are refused if they would take the balance below this (platform_settings.minimum_treasury_reserve). */
  minimumReserve: number
  /** Every payment still in progress, plus the latest ones; newest first. */
  payments: ProviderPayment[]
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
  /** Orders the provider cannot pay for yet are accepted, kept and sent when it has been topped up (refunded after the limit). */
  deferredOrdersEnabled: boolean
  /** USD of customer charges that may wait at any time. */
  deferredOrdersCap: number
  /** Hours after which a waiting order is refunded in full. */
  deferredOrdersTtlHours: number
  /** Paid orders waiting for a provider top-up right now. */
  unfunded: UnfundedSummary
  updatedAt: string | null
}

/** Paid orders waiting for a provider to be funded (unfunded_orders_summary). */
export interface UnfundedSummary {
  count: number
  /** What the customers paid for them. */
  charge: number
  /** What the providers will charge: the amount to transfer. */
  cost: number
  oldest: string | null
  providers: { id: string; name: string; count: number; cost: number; balance: number; oldest: string | null }[]
}

export const NO_UNFUNDED: UnfundedSummary = { count: 0, charge: 0, cost: 0, oldest: null, providers: [] }

export interface PlatformSettingsPatch {
  ordersEnabled?: boolean
  paymentsEnabled?: boolean
  maintenanceMode?: boolean
  deferredOrdersEnabled?: boolean
}

/** An open reconciliation case (admin-reconciliation). Today only orders are detected. */
export interface ReconCaseOrder {
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
  /** A held order (processing, no provider id) that still has its routing snapshot can be re-submitted. */
  canRetry: boolean
}

/** The provider payment behind a `provider_payment` case. */
export interface ReconCasePayment {
  status: ProviderPaymentStatus
  providerName: string
  amount: number
  currency: string
  asset: string
  network: string
  destinationWallet: string
  txHash: string | null
  broadcastedAt: string | null
  confirmedAt: string | null
  createdAt: string
}

export interface ReconCase {
  id: string
  entityType: 'order' | 'deposit' | 'provider_payment'
  entityId: string
  reason: string
  createdAt: string
  order: ReconCaseOrder | null
  payment: ReconCasePayment | null
}
