// Offline backend for dev mode (`npm run dev` outside Telegram, or VITE_MOCK_MODE=true).
// Mirrors the server contracts: place-order (validates, deducts the mock wallet, idempotent,
// persists, walks orders through submitted -> in_progress -> completed) and the deposit flow
// (quote -> intent with memo -> simulated payment -> idempotent credit + ledger entry).

import { MOCK_CATALOG, MOCK_SESSION } from '@/constants/dev'
import { calcPartialRefund, calcTotalUnits, checkBalance, toUnits, UNITS_PER_CURRENCY, validateQuantity, validateTargetUrl } from '@/lib/order-calc'
import { DEPOSIT_VALIDITY_SECONDS, generateMemo, quoteDeposit, validateDepositAmountUsd } from '@/lib/ton'
import { buildMessage, type NotifyEvent } from '../../../supabase/functions/_shared/telegram-notify.ts'
import type { MetricOrder } from '../../../supabase/functions/_shared/admin-metrics.ts'
import type { CreateOrderPayload, CreateOrderResult, IOrderView } from '@/types/orders'
import type { IWallet } from '@/types'
import type { DepositAsset, DepositIntent, DepositQuote, LedgerEntry, VerifyResult } from '@/types/wallet'
import { DepositApiError } from './deposit-errors'
import { OrderApiError } from './order-errors'

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface StoredOrder extends Omit<IOrderView, 'status' | 'remains' | 'refundedAmount'> {
  idempotencyKey: string
  /** Set once the simulated provider's terminal refund (partial / cancel) was credited. */
  settled?: boolean
  refundedAmount?: number
  /** Simulated provider cost (dev analytics only). */
  costAmount?: number
}

interface StoredDeposit {
  id: string
  memo: string
  amountUsd: number
  asset: DepositAsset
  createdAt: string
  validUntil: number
  status: 'pending' | 'completed'
}

interface MockState {
  balanceUnits: number
  orders: StoredOrder[]
  ledger: LedgerEntry[]
  deposits: StoredDeposit[]
}

const STORAGE_KEY = 'smm_mock_backend_v1'
const envMs = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback)
/** Simulated provider delays (override with VITE_MOCK_SUBMITTED_MS / VITE_MOCK_COMPLETED_MS). */
export const MOCK_SUBMITTED_MS = envMs(import.meta.env?.VITE_MOCK_SUBMITTED_MS, 4_000)
export const MOCK_COMPLETED_MS = envMs(import.meta.env?.VITE_MOCK_COMPLETED_MS, 20_000)
/** Share of a "#mock-partial" order the simulated provider fails to deliver. */
export const MOCK_PARTIAL_REMAINS_RATIO = 0.3

export interface MockDelays {
  submittedMs: number
  completedMs: number
}

type MockScenario = 'complete' | 'partial' | 'cancel'
/** Dev-only: put #mock-partial or #mock-cancel in the link to make the simulated provider end that way. */
export const mockScenario = (url: string): MockScenario => (/#mock-partial/i.test(url) ? 'partial' : /#mock-cancel/i.test(url) ? 'cancel' : 'complete')
/** Fixed USD price of 1 TON in dev mode. */
export const MOCK_TON_USD_RATE = 5
export const MOCK_RECIPIENT = 'UQDevMockRecipientAddressXXXXXXXXXXXXXXXXXXXXXXXX'

function browserStorage(): KeyValueStorage {
  try {
    const ls = globalThis.localStorage
    ls.setItem('__probe', '1')
    ls.removeItem('__probe')
    return ls
  } catch {
    const mem = new Map<string, string>()
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) }
  }
}

/** Dev stand-in for the Telegram bot: prints the exact message the real bot would send. */
const consoleNotify = (text: string) => console.info('[mock telegram -> @dev_user]', text)
/** Mock provider cost = 40% of the retail charge (a 60% margin) so the admin dashboard has numbers. */
const MOCK_COST_RATIO = 0.4

export function createMockBackend(
  storage: KeyValueStorage = browserStorage(),
  now: () => number = Date.now,
  delays: MockDelays = { submittedMs: MOCK_SUBMITTED_MS, completedMs: MOCK_COMPLETED_MS },
  notify: (text: string) => void = consoleNotify,
) {
  const say = (event: NotifyEvent) => {
    try { notify(buildMessage(event, 'en')) } catch { /* notifications never affect state */ }
  }
  const initial = (): MockState => ({ balanceUnits: toUnits(MOCK_SESSION.wallet.balance), orders: [], ledger: [], deposits: [] })

  /** The simulated provider has finished this order (terminal status reached). */
  const isFinished = (o: StoredOrder) => now() - Date.parse(o.createdAt) >= delays.completedMs
  const partialRemains = (o: StoredOrder) => Math.ceil(o.quantity * MOCK_PARTIAL_REMAINS_RATIO)

  /**
   * The dev stand-in for the sync-order-status worker: when a simulated order reaches its terminal
   * state, credit the refund (partial / cancel) exactly once. Returns true if anything changed.
   */
  function settle(state: MockState): boolean {
    let changed = false
    // Oldest first, so each ledger entry's balance_after follows the order the refunds really happened in.
    const chronological = [...state.orders].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    for (const o of chronological) {
      if (o.settled || !isFinished(o)) continue
      const scenario = mockScenario(o.targetUrl)
      const base = { orderId: o.id, serviceName: o.serviceName, quantity: o.quantity }
      o.settled = true // each order is settled (and announced) exactly once
      changed = true

      if (scenario === 'complete') {
        say({ type: 'order_completed', ...base })
        continue
      }
      const remains = partialRemains(o)
      const refund = scenario === 'partial' ? calcPartialRefund(o.quantity, remains, o.chargeAmount) : o.chargeAmount
      o.refundedAmount = refund
      if (refund > 0) {
        state.balanceUnits += toUnits(refund)
        state.ledger.unshift({
          id: `mock-tx-refund-${o.id}`, type: 'refund', status: 'completed', amount: refund,
          balanceAfter: state.balanceUnits / UNITS_PER_CURRENCY,
          description: scenario === 'partial' ? `Partial refund for order #${o.id}` : `Refund for order ${o.id}`,
          createdAt: new Date(Date.parse(o.createdAt) + delays.completedMs).toISOString(),
        })
      }
      say(scenario === 'partial' ? { type: 'order_partial', ...base, remains, refundAmount: refund } : { type: 'order_canceled', ...base, refundAmount: refund })
    }
    return changed
  }

  function load(): MockState {
    let state = initial()
    try {
      const raw = storage.getItem(STORAGE_KEY)
      // Merge over defaults so state saved by an older version (no ledger/deposits) still loads.
      if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<MockState>) }
    } catch { /* corrupted storage: start over */ }
    if (settle(state)) save(state)
    return state
  }
  const save = (state: MockState) => {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* best effort */ }
  }

  const walletOf = (state: MockState): IWallet => ({ balance: state.balanceUnits / UNITS_PER_CURRENCY, currency: 'USD' })
  const nextId = (state: MockState, prefix: string) => `${prefix}-${now().toString(36)}-${state.ledger.length + state.deposits.length + state.orders.length + 1}`

  /** Status is derived from age, so the history screen shows live-looking progress. */
  function view(o: StoredOrder): IOrderView {
    const age = now() - Date.parse(o.createdAt)
    const base = { ...o, refundedAmount: o.refundedAmount ?? 0 }
    if (age < delays.submittedMs) return { ...base, status: 'submitted', remains: o.quantity }
    if (age < delays.completedMs) {
      const progress = (age - delays.submittedMs) / (delays.completedMs - delays.submittedMs)
      const target = mockScenario(o.targetUrl) === 'partial' ? o.quantity - partialRemains(o) : o.quantity
      return { ...base, status: 'in_progress', remains: Math.max(0, Math.round(o.quantity - target * progress)) }
    }
    switch (mockScenario(o.targetUrl)) {
      case 'partial': return { ...base, status: 'partial', remains: partialRemains(o) }
      case 'cancel': return { ...base, status: 'refunded', remains: o.quantity }
      default: return { ...base, status: 'completed', remains: 0 }
    }
  }

  function quote(amountUsd: number, asset: DepositAsset): DepositQuote {
    const amount = validateDepositAmountUsd(amountUsd)
    if (!amount.ok) throw new DepositApiError('invalid_input', amount.error)
    if (asset !== 'TON') throw new DepositApiError('asset_unavailable', 'USDT deposits are not available yet. Please use TON.')
    const q = quoteDeposit(amountUsd, MOCK_TON_USD_RATE, 'TON')
    return { asset, amountUsd: q.amountUsd, amountCrypto: q.amountCrypto, amountNano: q.amountBase.toString(), rateUsd: q.rateUsd, network: 'testnet' }
  }

  return {
    getWallet(): IWallet {
      return walletOf(load())
    },

    // ----- orders -----------------------------------------------------------
    createOrder(payload: CreateOrderPayload): CreateOrderResult {
      const state = load()

      const replay = state.orders.find((o) => o.idempotencyKey === payload.idempotencyKey)
      if (replay) {
        return {
          order: { id: replay.id, status: view(replay).status, chargeAmount: replay.chargeAmount, quantity: replay.quantity, targetUrl: replay.targetUrl },
          pending: false,
          wallet: walletOf(state),
        }
      }

      const service = MOCK_CATALOG.services.find((s) => s.id === payload.serviceId)
      if (!service) throw new OrderApiError('service_unavailable', 'This service is no longer available.')
      const category = MOCK_CATALOG.categories.find((c) => c.id === service.categoryId)

      const url = validateTargetUrl(payload.targetUrl)
      if (!url.ok) throw new OrderApiError('invalid_input', url.error)
      const qty = validateQuantity(String(payload.quantity), service.minQuantity, service.maxQuantity)
      if (!qty.ok) throw new OrderApiError('invalid_input', qty.error)

      // The total is recomputed here from the catalogue rate, never taken from the caller.
      const totalUnits = calcTotalUnits(qty.value, service.ratePer1000)
      const check = checkBalance(state.balanceUnits / UNITS_PER_CURRENCY, totalUnits)
      if (!check.sufficient) {
        throw new OrderApiError('insufficient_funds', 'Insufficient balance.', { shortfall: check.shortfallUnits / UNITS_PER_CURRENCY })
      }

      const order: StoredOrder = {
        id: `mock-${now().toString(36)}-${state.orders.length + 1}`,
        idempotencyKey: payload.idempotencyKey,
        serviceName: service.name,
        platform: category?.platform ?? 'other',
        targetUrl: url.value,
        quantity: qty.value,
        chargeAmount: totalUnits / UNITS_PER_CURRENCY,
        costAmount: Math.round(totalUnits * MOCK_COST_RATIO) / UNITS_PER_CURRENCY,
        startCount: null,
        createdAt: new Date(now()).toISOString(),
      }
      state.balanceUnits -= totalUnits
      state.orders.unshift(order)
      state.ledger.unshift({
        id: nextId(state, 'mock-tx'), type: 'purchase', status: 'completed', amount: -order.chargeAmount,
        balanceAfter: state.balanceUnits / UNITS_PER_CURRENCY, description: `Order ${order.id}`, createdAt: order.createdAt,
      })
      save(state)

      return {
        order: { id: order.id, status: 'submitted', chargeAmount: order.chargeAmount, quantity: order.quantity, targetUrl: order.targetUrl },
        pending: false,
        wallet: walletOf(state),
      }
    },

    listOrders(): IOrderView[] {
      return load().orders.map(view)
    },

    /** The user's own mock orders in the shape the admin metrics expect (dev analytics). */
    metricOrders(): MetricOrder[] {
      return load().orders.map((o) => {
        const v = view(o)
        return {
          status: v.status, charge_amount: o.chargeAmount, cost_amount: o.costAmount ?? Math.round(o.chargeAmount * MOCK_COST_RATIO * 10_000) / 10_000,
          quantity: o.quantity, remains: v.remains, partial_refund_amount: v.status === 'partial' ? v.refundedAmount : 0,
          error_message: null, created_at: o.createdAt,
        }
      })
    },

    // ----- deposits ---------------------------------------------------------
    quoteDeposit: quote,

    createDeposit(amountUsd: number, asset: DepositAsset): DepositIntent {
      const q = quote(amountUsd, asset)
      const state = load()
      const dep: StoredDeposit = {
        id: nextId(state, 'mock-dep'), memo: generateMemo(), amountUsd: q.amountUsd, asset,
        createdAt: new Date(now()).toISOString(), validUntil: Math.floor(now() / 1000) + DEPOSIT_VALIDITY_SECONDS, status: 'pending',
      }
      state.deposits.unshift(dep)
      save(state)
      return { ...q, depositId: dep.id, memo: dep.memo, recipientAddress: MOCK_RECIPIENT, validUntil: dep.validUntil }
    },

    /** Dev-only "Simulate Instant Payment": stands in for the on-chain confirmation. Idempotent. */
    completeDeposit(depositId: string): VerifyResult {
      const state = load()
      const dep = state.deposits.find((d) => d.id === depositId)
      if (!dep) throw new DepositApiError('invalid_input', 'Deposit not found.')
      if (dep.status === 'pending') {
        dep.status = 'completed'
        state.balanceUnits += toUnits(dep.amountUsd)
        state.ledger.unshift({
          id: nextId(state, 'mock-tx'), type: 'deposit', status: 'completed', amount: dep.amountUsd,
          balanceAfter: state.balanceUnits / UNITS_PER_CURRENCY, description: `Deposit via Tonkeeper (${dep.asset})`,
          createdAt: new Date(now()).toISOString(), depositId: dep.id,
        })
        save(state)
        say({ type: 'deposit_completed', amountUsd: dep.amountUsd, asset: dep.asset, balance: state.balanceUnits / UNITS_PER_CURRENCY })
      }
      return { status: 'completed', wallet: walletOf(state) }
    },

    /** The mock chain never confirms by itself; only completeDeposit() does. */
    verifyDeposit(depositId: string): VerifyResult {
      const state = load()
      const dep = state.deposits.find((d) => d.id === depositId)
      if (!dep) throw new DepositApiError('invalid_input', 'Deposit not found.')
      return dep.status === 'completed' ? { status: 'completed', wallet: walletOf(state) } : { status: 'pending' }
    },

    /** Completed ledger entries plus still-open deposits, newest first. */
    listLedger(): LedgerEntry[] {
      const state = load()
      const open: LedgerEntry[] = state.deposits
        .filter((d) => d.status === 'pending' && d.validUntil * 1000 > now())
        .map((d) => ({
          id: `pending-${d.id}`, type: 'deposit', status: 'pending', amount: d.amountUsd, balanceAfter: null,
          description: `Deposit pending (${d.asset})`, createdAt: d.createdAt, depositId: d.id,
        }))
      return [...open, ...state.ledger].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    },

    reset(): void {
      save(initial())
    },
  }
}

export const mockBackend = createMockBackend()
