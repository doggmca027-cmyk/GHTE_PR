// BaseProviderAdapter: the capability-checking skeleton for provider integrations. A concrete adapter implements the `do*`
// hooks (talk to its own API); this class makes sure NOTHING is sent for an ability the provider does not have:
//
//   createRefill / getRefillStatus  -> need supportsRefill   (NotSupportedError otherwise)
//   cancelOrder                     -> needs supportsCancel
//   createOrder with runs/interval  -> needs supportsDripFeed
//
// Credentials never pass through here: a subclass receives them in its constructor and keeps them private.

import type { BatchStatusEntry, IProviderService, ProviderCapabilities } from '../types.ts'
import { DEFAULT_SMM_V2_CAPABILITIES } from '../types.ts'
import {
  NotSupportedError,
  assertSupports,
  usesDripFeed,
  type CreateOrderRequest,
  type IProviderAdapter,
  type ProviderBalanceResult,
  type ProviderCancelResult,
  type ProviderOrderResult,
  type ProviderOrderStatusResult,
  type ProviderRefillResult,
  type ProviderRefillStatusResult,
} from './contract.ts'

export interface BaseProviderConfig {
  id: string
  name: string
  /** What the provider supports; unset flags fall back to DEFAULT_SMM_V2_CAPABILITIES (no refill / cancel / drip-feed). */
  capabilities?: Partial<ProviderCapabilities>
}

export abstract class BaseProviderAdapter implements IProviderAdapter {
  readonly id: string
  readonly name: string
  private readonly capabilities: ProviderCapabilities

  protected constructor(config: BaseProviderConfig) {
    this.id = config.id
    this.name = config.name
    this.capabilities = { ...DEFAULT_SMM_V2_CAPABILITIES, ...config.capabilities }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return { ...this.capabilities }
  }

  // ---- always available -----------------------------------------------------------------------------
  abstract getBalance(): Promise<ProviderBalanceResult>
  abstract getServices(): Promise<IProviderService[]>
  abstract getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatusResult>
  abstract getOrdersStatus(providerOrderIds: string[]): Promise<Record<string, BatchStatusEntry>>
  protected abstract doCreateOrder(params: CreateOrderRequest): Promise<ProviderOrderResult>

  // ---- ability hooks: an adapter overrides the ones its provider supports --------------------------------
  protected doCreateRefill(_providerOrderId: string): Promise<ProviderRefillResult> {
    throw new NotSupportedError('refill', this.name)
  }
  protected doGetRefillStatus(_refillId: string): Promise<ProviderRefillStatusResult> {
    throw new NotSupportedError('refill', this.name)
  }
  protected doCancelOrder(_providerOrderId: string): Promise<ProviderCancelResult> {
    throw new NotSupportedError('cancel', this.name)
  }

  // ---- guarded public methods (the contract) ---------------------------------------------------------
  async createOrder(params: CreateOrderRequest): Promise<ProviderOrderResult> {
    if (usesDripFeed(params)) assertSupports(this.capabilities, 'dripFeed', this.name)
    return await this.doCreateOrder(params)
  }

  async createRefill(providerOrderId: string): Promise<ProviderRefillResult> {
    assertSupports(this.capabilities, 'refill', this.name)
    return await this.doCreateRefill(providerOrderId)
  }

  async getRefillStatus(refillId: string): Promise<ProviderRefillStatusResult> {
    assertSupports(this.capabilities, 'refill', this.name)
    return await this.doGetRefillStatus(refillId)
  }

  async cancelOrder(providerOrderId: string): Promise<ProviderCancelResult> {
    assertSupports(this.capabilities, 'cancel', this.name)
    return await this.doCancelOrder(providerOrderId)
  }
}
