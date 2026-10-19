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
  /** Stable unique identifier (providers.slug), e.g. "secsers-mock". Filled where the row is read with it; routing does not need it. */
  slug?: string
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
  /** The panel can deliver part of an order and refund the rest (provider_service_offers.supports_partial). Absent/false = not claimed. */
  supportsPartial?: boolean
  /** The panel lists the provider service as drip-feed capable (provider_services.is_dripfeed_enabled). Absent = not capable. */
  dripfeedSupported?: boolean
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
  /** The panel accepts drip-feed (runs + interval) for this service ("dripfeed"). Absent = the adapter does not say. */
  dripfeedSupported?: boolean
  /** The panel's own text about the service ("desc"/"description"), when it sends one. */
  description?: string
}

export interface IProviderBalance {
  balance: number
  currency: string
}

export interface ICreateOrderParams {
  /** The provider's own service id (provider_services.external_service_id). */
  serviceId: string
  link: string
  /** The order's TOTAL quantity. With runs > 1 the adapter sends quantity / runs, what a panel expects per delivery. */
  quantity: number
  /** Drip-feed: number of deliveries (absent or 1 = a plain order). Needs the dripFeed capability when above 1. */
  runs?: number
  /** Drip-feed: minutes between deliveries. Sent only with runs > 1. */
  interval?: number
  /** Extra panel-specific parameters (comments, ...). */
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
  /**
   * Keyword scope (optional, combines with `platform`): the service name must contain EVERY phrase of `name_all`
   * and at least one phrase of `name_any`. Whole-word, case-insensitive ("0% drop" does not match "10% drop").
   */
  name_all?: string[] | null
  name_any?: string[] | null
  /** The rule's price is at least cost + this per 1000 (the markup never earns less than this; null: no such minimum). */
  min_markup?: number | null
  /** The rule's price is at least this per 1000, whatever the cost (null: no such minimum). */
  min_price?: number | null
  priority: number
  is_active?: boolean
}

/** Identifies the service being priced; decides which rule scopes apply. */
export interface PriceContext {
  serviceId?: string
  categoryId?: string
  platform?: string
  /** The storefront service name: what keyword rules (name_all / name_any) are matched against. */
  serviceName?: string
}

export interface PriceOptions {
  /** Minimum absolute profit per 1000 units. Default 0.02. */
  minMargin?: number
}
