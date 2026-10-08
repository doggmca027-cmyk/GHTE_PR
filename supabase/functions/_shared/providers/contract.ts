// The provider adapter contract: the ONLY thing the core (place-order, order sync, reconciliation, catalog sync) knows
// about an external SMM panel. Everything panel-specific (URL, field names, status words, quirks) lives behind it.
//
// Rules of the contract:
//   * Credentials are injected when an adapter is built (from the encrypted key or the server environment). No method takes
//     an API key, and no result carries one.
//   * Statuses are normalized: every panel word is mapped to NormalizedOrderStatus here, never interpreted by the core.
//   * Optional abilities (refill, cancel, drip-feed) are guarded by the provider's capability flags: asking for one the
//     provider does not support throws NotSupportedError BEFORE any request is made.
//   * Unknown outcomes are errors with `ambiguous: true` (SMMProviderError), never silent defaults: the caller reconciles
//     instead of retrying or refunding blindly.
//
// This file is dependency-free (types + pure functions) so the frontend, tests and every adapter can import it.

import type {
  BatchStatusEntry,
  ICreateOrderParams,
  IProviderBalance,
  IProviderService,
  ISMMProviderAdapter,
  OrderStatus,
  ProviderCapabilities,
} from '../types.ts'

// ---------------------------------------------------------------------------
// Normalized inputs and outputs (aliases keep the names the core already uses)
// ---------------------------------------------------------------------------

/** Create one order at the provider. `serviceId` is the PROVIDER's service id (provider_services.external_service_id). */
export type CreateOrderRequest = ICreateOrderParams
/** The provider's id for the order it accepted. */
export interface ProviderOrderResult {
  orderId: string
}
export type ProviderBalanceResult = IProviderBalance
export type ProviderService = IProviderService
export type ProviderBatchStatusEntry = BatchStatusEntry

/**
 * What a provider can tell us about an order, in OUR vocabulary. These are the only values an adapter may return, a strict
 * subset of the database order_status_enum:
 *
 *   submitted    accepted, work not started (panel words: Pending, Awaiting, Queued)
 *   in_progress  being delivered        (In progress, Processing, Running)
 *   completed    delivered in full      (Completed, Success)
 *   partial      stopped, remainder undelivered; `remains` and `charge` say how much (Partial)
 *   canceled     the provider canceled it and returned our money (Canceled, Cancelled, Refunded)
 *   failed       the provider failed it (Fail, Failed, Error, Rejected); order-sync refunds the customer
 */
export type NormalizedOrderStatus = Extract<OrderStatus, 'submitted' | 'in_progress' | 'completed' | 'partial' | 'canceled' | 'failed'>

export const NORMALIZED_ORDER_STATUSES: readonly NormalizedOrderStatus[] = ['submitted', 'in_progress', 'completed', 'partial', 'canceled', 'failed']

/** A status after which the provider will not change it again (the sync worker stops polling). */
export const isFinalProviderStatus = (s: NormalizedOrderStatus): boolean => s === 'completed' || s === 'partial' || s === 'canceled' || s === 'failed'

export interface ProviderOrderStatusResult {
  orderId: string
  status: NormalizedOrderStatus
  /** The status word exactly as the panel returned it (for logs and support; never interpreted). */
  rawStatus: string
  /** What the provider charged for this order (after a partial/cancel: the reduced amount). */
  charge?: number
  currency?: string
  startCount?: number
  /** Units not delivered. */
  remains?: number
}

export type RefillStatus = 'pending' | 'in_progress' | 'completed' | 'rejected'

export interface ProviderRefillResult {
  orderId: string
  /** The provider's id for the refill, to follow it with getRefillStatus. */
  refillId: string
}

export interface ProviderRefillStatusResult {
  refillId: string
  status: RefillStatus
  rawStatus: string
}

export interface ProviderCancelResult {
  orderId: string
  /** true = the provider canceled the order (it will report `canceled` and credit the balance). false = refused. */
  accepted: boolean
  /** The provider's reason when it refused (already completed, too late, ...). */
  reason?: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SMMErrorKind =
  | 'misconfigured'
  | 'timeout'
  | 'network'
  | 'http'
  | 'api'
  | 'invalid_response'

export type SMMErrorCode =
  | 'invalid_api_key'
  | 'insufficient_provider_balance'
  | 'invalid_service'
  | 'invalid_link'
  | 'invalid_quantity'
  | 'order_not_found'
  | 'rate_limited'
  | 'unknown'

export class SMMProviderError extends Error {
  readonly kind: SMMErrorKind
  readonly code: SMMErrorCode
  /** Safe to retry the same call. */
  readonly retryable: boolean
  /**
   * The outcome is unknown: a state-changing call (`add`) timed out or lost the
   * connection, so the panel MAY have created the order. Reconcile before retrying.
   */
  readonly ambiguous: boolean
  readonly httpStatus?: number

  constructor(
    kind: SMMErrorKind,
    message: string,
    extra: { code?: SMMErrorCode; retryable?: boolean; ambiguous?: boolean; httpStatus?: number } = {},
  ) {
    super(message)
    this.name = 'SMMProviderError'
    this.kind = kind
    this.code = extra.code ?? 'unknown'
    this.retryable = extra.retryable ?? false
    this.ambiguous = extra.ambiguous ?? false
    this.httpStatus = extra.httpStatus
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type Capability = 'refill' | 'cancel' | 'dripFeed' | 'partial'

const CAPABILITY_FLAG: Record<Capability, keyof ProviderCapabilities> = {
  refill: 'supportsRefill',
  cancel: 'supportsCancel',
  dripFeed: 'supportsDripFeed',
  partial: 'supportsPartial',
}

/** Thrown, before any request, when a provider is asked for something its capability flags do not allow. */
export class NotSupportedError extends Error {
  readonly capability: Capability
  readonly provider: string
  constructor(capability: Capability, provider: string) {
    super(`provider "${provider}" does not support ${capability}`)
    this.name = 'NotSupportedError'
    this.capability = capability
    this.provider = provider
  }
}

export const supports = (caps: ProviderCapabilities, capability: Capability): boolean => caps[CAPABILITY_FLAG[capability]] === true

/** Throws NotSupportedError unless the capability is on. */
export function assertSupports(caps: ProviderCapabilities, capability: Capability, provider: string): void {
  if (!supports(caps, capability)) throw new NotSupportedError(capability, provider)
}

/** Drip-feed parameters (`runs`, `interval`) in an order request: they need the dripFeed capability. */
export const usesDripFeed = (params: Pick<CreateOrderRequest, 'extra'>): boolean => params.extra?.runs !== undefined || params.extra?.interval !== undefined

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Everything the platform needs from a provider across the life of an order:
 * balance and catalog, create, follow (one or many), and (capability permitting) refill and cancel.
 *
 * Extends the long-standing ISMMProviderAdapter, so every existing caller keeps working; the new, optional methods are what
 * the Base adapter adds on top.
 */
export interface IProviderAdapter extends ISMMProviderAdapter {
  getBalance(): Promise<ProviderBalanceResult>
  getServices(): Promise<ProviderService[]>
  createOrder(params: CreateOrderRequest): Promise<ProviderOrderResult>
  getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatusResult>
  getOrdersStatus(providerOrderIds: string[]): Promise<Record<string, ProviderBatchStatusEntry>>
  /** Requires supportsRefill; otherwise NotSupportedError. */
  createRefill?(providerOrderId: string): Promise<ProviderRefillResult>
  getRefillStatus?(refillId: string): Promise<ProviderRefillStatusResult>
  /** Requires supportsCancel; otherwise NotSupportedError. A refusal by the provider is `accepted: false`, not an error. */
  cancelOrder?(providerOrderId: string): Promise<ProviderCancelResult>
}

// ---------------------------------------------------------------------------
// Status normalization (the mapping table every adapter shares)
// ---------------------------------------------------------------------------

const ORDER_STATUS_WORDS: Record<string, NormalizedOrderStatus> = {
  pending: 'submitted', awaiting: 'submitted', queued: 'submitted', new: 'submitted', waiting: 'submitted',
  processing: 'in_progress', 'in progress': 'in_progress', inprogress: 'in_progress', running: 'in_progress', active: 'in_progress',
  completed: 'completed', complete: 'completed', success: 'completed', done: 'completed', finished: 'completed',
  partial: 'partial',
  // the provider returned our money: from our side the order is canceled (order-sync refunds the customer)
  canceled: 'canceled', cancelled: 'canceled', refunded: 'canceled', refund: 'canceled',
  fail: 'failed', failed: 'failed', error: 'failed', rejected: 'failed',
}

/** A panel's order status word -> ours; null for a word we do not know (the caller must treat that as an error, never as a status). */
export function normalizeOrderStatus(raw: string): NormalizedOrderStatus | null {
  return ORDER_STATUS_WORDS[raw.trim().toLowerCase().replace(/[_-]+/g, ' ')] ?? null
}

const REFILL_STATUS_WORDS: Record<string, RefillStatus> = {
  pending: 'pending', awaiting: 'pending', queued: 'pending',
  processing: 'in_progress', 'in progress': 'in_progress', inprogress: 'in_progress',
  completed: 'completed', complete: 'completed', success: 'completed',
  rejected: 'rejected', failed: 'rejected', fail: 'rejected', error: 'rejected', canceled: 'rejected', cancelled: 'rejected',
}

export function normalizeRefillStatus(raw: string): RefillStatus | null {
  return REFILL_STATUS_WORDS[raw.trim().toLowerCase().replace(/[_-]+/g, ' ')] ?? null
}
