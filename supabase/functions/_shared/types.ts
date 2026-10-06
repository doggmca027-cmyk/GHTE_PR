// Domain types shared by Edge Functions, tests and (type-only) the frontend.
// Single source of truth: src/types re-exports these.

/** Mirrors order_status_enum in the database. */
export type OrderStatus =
  | 'draft'
  | 'awaiting_payment'
  | 'paid'
  | 'processing'
  | 'submitted'
  | 'in_progress'
  | 'completed'
  | 'partial'
  | 'canceled'
  | 'refunded'
  | 'failed'

/** Mirrors platform_enum in the database. */
export type Platform = 'telegram' | 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'facebook' | 'other'

// ---------------------------------------------------------------------------
// Provider Manager (mirrors providers / provider_capabilities, migration 20261012000000)
// ---------------------------------------------------------------------------

/** Mirrors provider_health_enum. */
export const HEALTH_STATUSES = ['healthy', 'degraded', 'unavailable', 'disabled'] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]

/** What a provider can do. Mirrors provider_capabilities (service_role only; never sent to clients). */
export interface ProviderCapabilities {
  supportsRefill: boolean
  supportsCancel: boolean
  supportsDripFeed: boolean
  /** The panel reports "Partial" orders (undelivered remainder). */
  supportsPartial: boolean
  /** The panel has a `balance` action. */
  supportsBalanceApi: boolean
}

/** Capabilities assumed for a panel until detected: nothing optional, but every SMM v2 panel reports Partial and has a balance action. */
export const DEFAULT_SMM_V2_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supportsRefill: false,
  supportsCancel: false,
  supportsDripFeed: false,
  supportsPartial: true,
  supportsBalanceApi: true,
})

/**
 * A provider as the platform sees it (a providers row WITHOUT credentials: the API key is never part of the
 * domain object). Server-side only; clients have no access to these tables.
 */
export interface IProvider {
  id: string
  name: string
  apiUrl: string
  /** SMM API generation, e.g. "v2". */
  apiVersion: string
  isActive: boolean
  /** Eligible to receive orders from the (future) routing engine. Requires isActive. */
  routingEnabled: boolean
  healthStatus: HealthStatus
  /** ISO timestamps, null until the first check / sync. */
  lastHealthCheck: string | null
  lastBalanceSync: string | null
  /** Balance held at the provider, in `currency`. */
  providerBalance: number
  /** ISO 4217-style code of providerBalance, e.g. "USD". */
  currency: string
  priority: number
  /**
   * Reliability penalty (1..10, default 1): routing ranks offers by cost x penalty, so an unreliable provider has to be
   * that much cheaper to win. Never changes what an order is charged or what its snapshot records.
   */
  reliabilityPenalty?: number
}

/**
 * One way to fulfil a normalized service: a provider's own service with its cost and limits (maps to
 * provider_service_offers). Server-side only: RLS is on with no client policies, so customers never see
 * provider ids or costs.
 */
export interface IProviderServiceOffer {
  id: string
  /** The normalized, customer-facing service (services.id). */
  serviceId: string
  providerId: string
  /** The provider's service this offer uses (provider_services.id). */
  providerServiceId: string
  /** What the provider charges us per 1000 units, in the provider's currency. */
  costPer1000: number
  minQuantity: number
  maxQuantity: number
  refillSupported: boolean
  cancelSupported: boolean
  isActive: boolean
  /** Higher is preferred by the (future) routing engine. */
  routingScore: number
  /** ISO timestamps. */
  createdAt: string
  updatedAt: string
}

/** A service as listed by an external panel (maps to the provider_services table). */
export interface IProviderService {
  externalServiceId: string
  name: string
  type: string
  categoryRaw: string
  /** Provider cost per 1000 units. */
  ratePer1000: number
  minQuantity: number
  maxQuantity: number
  refillSupported: boolean
  cancelSupported: boolean
}

export interface IProviderBalance {
  balance: number
  currency: string
}

export interface ICreateOrderParams {
  /** The provider's own service id (provider_services.external_service_id). */
  serviceId: string
  link: string
  quantity: number
  /** Extra panel-specific parameters (runs, interval, comments, ...). */
  extra?: Record<string, string | number>
}

export interface IProviderOrderStatus {
  orderId: string
  status: OrderStatus
  /** Status string exactly as the panel returned it. */
  rawStatus: string
  charge?: number
  currency?: string
  startCount?: number
  remains?: number
}

/** Result for ONE order inside a batch status query. */
export type BatchStatusEntry =
  | { ok: true; status: IProviderOrderStatus }
  | { ok: false; error: string; code: string }

/** Contract every SMM panel provider integration must implement. Server-side only. */
export interface ISMMProviderAdapter {
  readonly id: string
  readonly name: string
  getServices(): Promise<IProviderService[]>
  createOrder(params: ICreateOrderParams): Promise<{ orderId: string }>
  getOrderStatus(orderId: string): Promise<IProviderOrderStatus>
  /** Multi-order status (SMM v2 `orders=1,2,3`). Keys are the requested order ids. */
  getOrdersStatus(orderIds: string[]): Promise<Record<string, BatchStatusEntry>>
  getBalance(): Promise<IProviderBalance>
  /** What this panel supports (static knowledge or detected). Used by the routing engine to pick eligible providers. */
  getCapabilities(): Promise<ProviderCapabilities>
}

/** Mirrors a row of the price_rules table. */
export interface PriceRule {
  id: string
  type: 'percentage' | 'fixed' | 'tier'
  /**
   * percentage: markup in percent (300 = +300%, i.e. x4).
   * fixed:      markup in currency per 1000 units.
   * tier:       percentage markup applied when the provider rate is within [min_rate, max_rate].
   */
  value: number
  platform?: string | null
  category_id?: string | null
  service_id?: string | null
  min_rate?: number | null
  max_rate?: number | null
  priority: number
  is_active?: boolean
}

/** Identifies the service being priced; decides which rule scopes apply. */
export interface PriceContext {
  serviceId?: string
  categoryId?: string
  platform?: string
}

export interface PriceOptions {
  /** Minimum absolute profit per 1000 units. Default 0.01. */
  minMargin?: number
}
