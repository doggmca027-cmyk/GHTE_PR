// Offline admin backend for dev mock mode: realistic demo analytics, a seeded reconciliation
// queue and editable price rules, persisted in localStorage. It uses the SAME metric and queue
// functions as the server code, so the dev dashboard shows what production would compute.

import { computeAdminMetrics, inReconciliationQueue, type AdminMetrics, type MetricOrder } from '../../../supabase/functions/_shared/admin-metrics.ts'
import type { OrderStatus } from '@/types'
import type { PriceRuleView, ProviderStatus, ReconciliationOrder } from '@/types/admin'
import { mockBackend, type KeyValueStorage } from './mock-orders'

export class AdminApiError extends Error {
  readonly code: 'forbidden' | 'invalid_input' | 'not_found' | 'conflict' | 'network' | 'server'
  constructor(code: AdminApiError['code'], message: string) {
    super(message)
    this.name = 'AdminApiError'
    this.code = code
  }
}

interface DemoOrder extends MetricOrder {
  id: string
  serviceName: string
  username: string
  telegramId: number
  targetUrl: string
  providerOrderId: string | null
}

interface AdminState {
  orders: DemoOrder[]
  rules: PriceRuleView[]
}

const STORAGE_KEY = 'smm_mock_admin_v1'
const HOUR = 3_600_000

const demoOrder = (
  n: number, status: OrderStatus, charge: number, cost: number, quantity: number, ageMs: number, now: number, extra: Partial<DemoOrder> = {},
): DemoOrder => ({
  id: `demo-${String(n).padStart(3, '0')}`, status, charge_amount: charge, cost_amount: cost, quantity, remains: null, partial_refund_amount: 0,
  error_message: null, created_at: new Date(now - ageMs).toISOString(), serviceName: 'Telegram Channel Members [Non-Drop 30D]',
  username: `demo_user_${n}`, telegramId: 900_000 + n, targetUrl: `https://t.me/demo_channel_${n}`, providerOrderId: `P${70_000 + n}`, ...extra,
})

function seed(now: number): AdminState {
  return {
    orders: [
      // delivered orders (revenue + cost)
      ...([[54, 10_000], [27, 5_000], [10.8, 2_000], [5.4, 1_000], [60, 11_000], [16.2, 3_000], [2.4, 500], [40.5, 7_500]] as [number, number][])
        .map(([charge, qty], i) => demoOrder(i + 1, 'completed', charge, Math.round(charge * 0.4 * 10_000) / 10_000, qty, (i + 2) * 7 * HOUR, now)),
      demoOrder(20, 'partial', 12, 4, 2000, 30 * HOUR, now, { remains: 500, partial_refund_amount: 3 }),
      demoOrder(21, 'partial', 30, 10, 5000, 50 * HOUR, now, { remains: 1000, partial_refund_amount: 6 }),
      demoOrder(22, 'refunded', 8, 2.7, 1500, 40 * HOUR, now, { error_message: null }),
      // still running
      demoOrder(30, 'in_progress', 14.4, 4.8, 2700, 2 * HOUR, now, { remains: 1200 }),
      demoOrder(31, 'submitted', 5.4, 1.8, 1000, 0.2 * HOUR, now),
      // needs a human
      demoOrder(40, 'processing', 12.5, 4.2, 5000, 3 * HOUR, now, {
        error_message: 'needs_reconciliation: timeout: add: no response within 10000ms', providerOrderId: null, username: 'alice_demo', telegramId: 910_001,
        serviceName: 'Instagram Followers [Real, Refill 30D]', targetUrl: 'https://instagram.com/alice_demo',
      }),
      demoOrder(41, 'failed', 3.2, 1.1, 1000, 26 * HOUR, now, {
        error_message: 'needs_refund: provider_rejected: api/invalid_link: Incorrect link', providerOrderId: null, username: 'bob_demo', telegramId: 910_002,
        serviceName: 'TikTok Likes [Instant]', targetUrl: 'https://tiktok.com/@bob_demo/video/1',
      }),
      demoOrder(42, 'processing', 6.5, 2.2, 2500, 1.5 * HOUR, now, {
        error_message: 'needs_reconciliation: provider accepted as 90210 but database update failed', providerOrderId: null, username: 'carol_demo', telegramId: 910_003,
        serviceName: 'Telegram Post Views [Real, 30 Days]', targetUrl: 'https://t.me/carol_demo/42',
      }),
    ],
    rules: [
      { id: 'rule-global', name: 'Default +150%', type: 'percentage', value: 150, isActive: true, priority: 0, scope: 'Global' },
      { id: 'rule-telegram', name: 'Telegram +200%', type: 'percentage', value: 200, isActive: true, priority: 0, scope: 'Platform: telegram' },
      { id: 'rule-ig', name: 'Instagram Followers fixed markup', type: 'fixed', value: 0.5, isActive: false, priority: 5, scope: 'Category: Instagram Followers' },
    ],
  }
}

const DEMO_EXTRAS = { totalUsers: 41, userBalances: 312.4, depositsTotal: 1840 }

export function createMockAdmin(storage: KeyValueStorage, now: () => number = Date.now) {
  const load = (): AdminState => {
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (raw) return JSON.parse(raw) as AdminState
    } catch { /* corrupted: reseed */ }
    return seed(now())
  }
  const save = (s: AdminState) => {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* best effort */ }
  }
  const find = (s: AdminState, id: string) => {
    const o = s.orders.find((x) => x.id === id)
    if (!o) throw new AdminApiError('not_found', 'Order not found.')
    return o
  }

  return {
    getMetrics(): AdminMetrics {
      const s = load()
      const mine = mockBackend.metricOrders()
      return computeAdminMetrics([...s.orders, ...mine], { ...DEMO_EXTRAS, totalUsers: DEMO_EXTRAS.totalUsers + 1 }, now())
    },

    getProviders(): ProviderStatus[] {
      const t = now()
      return [
        { id: 'prov-1', name: 'Secsers Mock', isActive: true, balance: 842.17, balanceUpdatedAt: new Date(t - 4 * 60_000).toISOString(), lastSyncedAt: new Date(t - 4 * 60_000).toISOString(), activeServices: 8 },
        { id: 'prov-2', name: 'Backup Panel', isActive: false, balance: 12.5, balanceUpdatedAt: new Date(t - 3 * 86_400_000).toISOString(), lastSyncedAt: null, activeServices: 0 },
      ]
    },

    getQueue(): ReconciliationOrder[] {
      const t = now()
      return load().orders
        .filter((o) => inReconciliationQueue(o, t))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((o) => ({
          id: o.id, status: o.status, chargeAmount: o.charge_amount, quantity: o.quantity, targetUrl: o.targetUrl,
          providerOrderId: o.providerOrderId, errorMessage: o.error_message, createdAt: o.created_at, serviceName: o.serviceName,
          username: o.username, telegramId: o.telegramId,
        }))
    },

    forceRefund(orderId: string): void {
      const s = load()
      const o = find(s, orderId)
      if (o.status === 'refunded') return
      if (!inReconciliationQueue(o, now())) throw new AdminApiError('conflict', 'This order is not in the reconciliation queue.')
      o.status = 'refunded'
      o.error_message = null
      save(s)
    },

    markResolved(orderId: string, input: { providerOrderId?: string; note?: string }): void {
      const s = load()
      const o = find(s, orderId)
      if (!inReconciliationQueue(o, now())) throw new AdminApiError('conflict', 'This order is not in the reconciliation queue.')
      if (o.status === 'processing') {
        if (!input.providerOrderId?.trim()) throw new AdminApiError('invalid_input', 'The provider order id is required to resolve a processing order.')
        o.providerOrderId = input.providerOrderId.trim()
        o.status = 'submitted'
      } else if (!input.note?.trim()) {
        throw new AdminApiError('invalid_input', 'A note is required to resolve this order without a refund.')
      }
      o.error_message = null
      save(s)
    },

    listRules(): PriceRuleView[] {
      return load().rules
    },

    updateRule(id: string, patch: { value?: number; isActive?: boolean }): PriceRuleView {
      if (patch.value === undefined && patch.isActive === undefined) throw new AdminApiError('invalid_input', 'Nothing to update.')
      if (patch.value !== undefined && (!Number.isFinite(patch.value) || patch.value < 0 || patch.value > 100_000)) {
        throw new AdminApiError('invalid_input', 'Value must be between 0 and 100000.')
      }
      const s = load()
      const r = s.rules.find((x) => x.id === id)
      if (!r) throw new AdminApiError('not_found', 'Price rule not found.')
      if (patch.value !== undefined) r.value = Math.round(patch.value * 100) / 100
      if (patch.isActive !== undefined) r.isActive = patch.isActive
      save(s)
      return r
    },

    reset(): void {
      save(seed(now()))
    },
  }
}
