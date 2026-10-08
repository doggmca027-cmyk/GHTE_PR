// MockProviderAdapter: a complete, in-memory provider for tests, local development and contract checks. It never touches the
// network and needs no key. Deterministic: time comes from an injected clock, ids from a counter.
//
// Behaviour (all through the same IProviderAdapter contract as a real panel):
//   * services: a small static catalog (or your own); balance: starts at `balance`, each order debits its cost;
//   * an order is `submitted` for 5 s, `in_progress` until 15 s, then `completed` (or driven by hand with setStatus);
//   * refill (if supportsRefill): only for a completed order; the refill completes 5 s later;
//   * cancel (if supportsCancel): accepted while the order is not finished, refused afterwards; the cost is credited back;
//   * failNext(action, error) makes the next call of an action fail, to test the caller's error paths.

import { BaseProviderAdapter, type BaseProviderConfig } from './base-adapter.ts'
import {
  type CreateOrderRequest,
  type NormalizedOrderStatus,
  type ProviderBalanceResult,
  type ProviderCancelResult,
  type ProviderOrderResult,
  type ProviderOrderStatusResult,
  type ProviderRefillResult,
  type ProviderRefillStatusResult,
} from './contract.ts'
import { SMMProviderError } from './contract.ts'
import type { BatchStatusEntry, IProviderService } from '../types.ts'

export const MOCK_CATALOG: readonly IProviderService[] = Object.freeze([
  { externalServiceId: '1001', name: 'Telegram Post Views [Instant]', type: 'Default', categoryRaw: 'Telegram Views', ratePer1000: 0.08, minQuantity: 100, maxQuantity: 1_000_000, refillSupported: false, cancelSupported: true },
  { externalServiceId: '2001', name: 'Telegram Channel Members [R30]', type: 'Default', categoryRaw: 'Telegram Members', ratePer1000: 1.8, minQuantity: 50, maxQuantity: 50_000, refillSupported: true, cancelSupported: false },
  { externalServiceId: '3001', name: 'Instagram Followers [R30]', type: 'Default', categoryRaw: 'Instagram Followers', ratePer1000: 2.4, minQuantity: 50, maxQuantity: 100_000, refillSupported: true, cancelSupported: true },
])

export interface MockProviderConfig extends BaseProviderConfig {
  balance?: number
  currency?: string
  services?: readonly IProviderService[]
  now?: () => number
}

interface MockOrder {
  serviceId: string
  quantity: number
  cost: number
  createdAt: number
  forced: { status: NormalizedOrderStatus; remains?: number } | null
}

type Action = 'getBalance' | 'getServices' | 'createOrder' | 'getOrderStatus' | 'createRefill' | 'cancelOrder'

const SUBMITTED_MS = 5_000
const COMPLETED_MS = 15_000
const REFILL_MS = 5_000

export class MockProviderAdapter extends BaseProviderAdapter {
  private balance: number
  private readonly currency: string
  private readonly catalog: readonly IProviderService[]
  private readonly now: () => number
  private readonly orders = new Map<string, MockOrder>()
  private readonly refills = new Map<string, number>()
  private readonly failures = new Map<Action, Error>()
  private seq = 100_000

  constructor(config: MockProviderConfig = { id: 'mock', name: 'Mock provider' }) {
    super({ id: config.id ?? 'mock', name: config.name ?? 'Mock provider', capabilities: config.capabilities })
    this.balance = config.balance ?? 1000
    this.currency = config.currency ?? 'USD'
    this.catalog = config.services ?? MOCK_CATALOG
    this.now = config.now ?? Date.now
  }

  // ---- test controls -----------------------------------------------------------------------------------
  /** The next call of `action` throws `error` (once). */
  failNext(action: Action, error: Error): void {
    this.failures.set(action, error)
  }

  /** Overrides the clock-driven status of an order (e.g. partial with 300 remaining). */
  setStatus(orderId: string, status: NormalizedOrderStatus, remains?: number): void {
    const o = this.orders.get(orderId)
    if (!o) throw new Error(`mock order ${orderId} does not exist`)
    o.forced = { status, remains }
  }

  get orderCount(): number {
    return this.orders.size
  }

  private maybeFail(action: Action): void {
    const e = this.failures.get(action)
    if (e) {
      this.failures.delete(action)
      throw e
    }
  }

  private statusOf(o: MockOrder): { status: NormalizedOrderStatus; raw: string; remains: number } {
    if (o.forced) return { status: o.forced.status, raw: `forced:${o.forced.status}`, remains: o.forced.remains ?? (o.forced.status === 'completed' ? 0 : o.quantity) }
    const age = this.now() - o.createdAt
    if (age < SUBMITTED_MS) return { status: 'submitted', raw: 'Pending', remains: o.quantity }
    if (age < COMPLETED_MS) return { status: 'in_progress', raw: 'In progress', remains: Math.max(0, Math.round(o.quantity * (1 - (age - SUBMITTED_MS) / (COMPLETED_MS - SUBMITTED_MS)))) }
    return { status: 'completed', raw: 'Completed', remains: 0 }
  }

  private order(id: string): MockOrder {
    const o = this.orders.get(id)
    if (!o) throw new SMMProviderError('api', 'Incorrect order ID', { code: 'order_not_found' })
    return o
  }

  private result(id: string): ProviderOrderStatusResult {
    const o = this.order(id)
    const s = this.statusOf(o)
    const charge = s.status === 'canceled' || s.status === 'failed' ? 0 : s.status === 'partial' ? Math.round(o.cost * (1 - s.remains / o.quantity) * 10_000) / 10_000 : o.cost
    return { orderId: id, status: s.status, rawStatus: s.raw, charge, currency: this.currency, startCount: 0, remains: s.remains }
  }

  // ---- the contract ----------------------------------------------------------------------------------------
  async getBalance(): Promise<ProviderBalanceResult> {
    this.maybeFail('getBalance')
    return { balance: Math.round(this.balance * 10_000) / 10_000, currency: this.currency }
  }

  async getServices(): Promise<IProviderService[]> {
    this.maybeFail('getServices')
    return this.catalog.map((s) => ({ ...s }))
  }

  protected async doCreateOrder(params: CreateOrderRequest): Promise<ProviderOrderResult> {
    this.maybeFail('createOrder')
    const svc = this.catalog.find((s) => s.externalServiceId === params.serviceId)
    if (!svc) throw new SMMProviderError('api', 'Incorrect service ID', { code: 'invalid_service' })
    if (!/^https?:\/\//.test(params.link) && !/^@/.test(params.link)) throw new SMMProviderError('api', 'Incorrect link', { code: 'invalid_link' })
    if (!Number.isInteger(params.quantity) || params.quantity < svc.minQuantity || params.quantity > svc.maxQuantity) {
      throw new SMMProviderError('api', 'Incorrect quantity', { code: 'invalid_quantity' })
    }
    const cost = Math.round((svc.ratePer1000 * params.quantity) / 1000 * 10_000) / 10_000
    if (cost > this.balance) throw new SMMProviderError('api', 'Not enough funds on balance', { code: 'insufficient_provider_balance' })
    this.balance -= cost
    const orderId = String(++this.seq)
    this.orders.set(orderId, { serviceId: svc.externalServiceId, quantity: params.quantity, cost, createdAt: this.now(), forced: null })
    return { orderId }
  }

  async getOrderStatus(providerOrderId: string): Promise<ProviderOrderStatusResult> {
    this.maybeFail('getOrderStatus')
    return this.result(providerOrderId)
  }

  async getOrdersStatus(providerOrderIds: string[]): Promise<Record<string, BatchStatusEntry>> {
    this.maybeFail('getOrderStatus')
    const out: Record<string, BatchStatusEntry> = {}
    for (const id of providerOrderIds) {
      out[id] = this.orders.has(id) ? { ok: true, status: this.result(id) } : { ok: false, error: 'Incorrect order ID', code: 'order_not_found' }
    }
    return out
  }

  protected override async doCreateRefill(providerOrderId: string): Promise<ProviderRefillResult> {
    this.maybeFail('createRefill')
    const o = this.order(providerOrderId)
    const svc = this.catalog.find((s) => s.externalServiceId === o.serviceId)
    if (!svc?.refillSupported) throw new SMMProviderError('api', 'This service has no refill', { code: 'unknown' })
    if (this.statusOf(o).status !== 'completed') throw new SMMProviderError('api', 'Order is not completed yet', { code: 'unknown' })
    const refillId = `R${++this.seq}`
    this.refills.set(refillId, this.now())
    return { orderId: providerOrderId, refillId }
  }

  protected override async doGetRefillStatus(refillId: string): Promise<ProviderRefillStatusResult> {
    const at = this.refills.get(refillId)
    if (at === undefined) throw new SMMProviderError('api', 'Incorrect refill ID', { code: 'order_not_found' })
    return this.now() - at >= REFILL_MS ? { refillId, status: 'completed', rawStatus: 'Completed' } : { refillId, status: 'pending', rawStatus: 'Pending' }
  }

  protected override async doCancelOrder(providerOrderId: string): Promise<ProviderCancelResult> {
    this.maybeFail('cancelOrder')
    const o = this.order(providerOrderId)
    const s = this.statusOf(o).status
    if (s !== 'submitted' && s !== 'in_progress') return { orderId: providerOrderId, accepted: false, reason: 'Order can no longer be canceled' }
    o.forced = { status: 'canceled', remains: o.quantity }
    this.balance += o.cost
    return { orderId: providerOrderId, accepted: true }
  }
}
