// Offline admin backend for dev mock mode: realistic demo analytics, a seeded reconciliation
// queue and editable price rules, persisted in localStorage. It uses the SAME metric and queue
// functions as the server code, so the dev dashboard shows what production would compute.

import { computeAdminMetrics, inReconciliationQueue, type AdminMetrics, type MetricOrder } from '../../../supabase/functions/_shared/admin-metrics.ts'
import type { OrderStatus } from '@/types'
import { computeProfitAnalytics, type DateRange } from '../../../supabase/functions/_shared/admin-analytics.ts'
import type { AdminUserView, PriceRuleView, ProfitAnalytics, ProviderStatus, ReconCase, ReconciliationOrder, ResolveDepositInput, ResolveDepositResult } from '@/types/admin'
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

/** Deposit cases and customers of the demo (kept apart from AdminState so a saved older demo keeps working). */
interface PeopleState {
  deposits: { id: string; caseId: string; reason: string; createdAt: string; open: boolean; status: string; amountUsd: number; amountCrypto: number; txHash: string | null; receivedNano: number | null; userId: string }[]
  users: AdminUserView[]
}
const PEOPLE_KEY = 'smm_mock_admin_people_v1'
const demoUser = (n: number, username: string, now: number, extra: Partial<AdminUserView> = {}): AdminUserView => ({
  id: `demo-user-${910_000 + n}`, telegramId: 910_000 + n, username, firstName: username.split('_')[0], isBanned: false, isAdmin: false,
  createdAt: new Date(now - n * 24 * HOUR).toISOString(), balance: 10 * n, orders: n, isYou: false, email: null, ...extra,
})
const DEMO_HASH = 'kq3Zk9mWvB0d7rM5tq1nqZ1y8hYQe7Q3x9vKpQ2l1cA='
function seedPeople(now: number): PeopleState {
  return {
    deposits: [
      { id: 'dep-001', caseId: 'case-dep-001', reason: `underpaid: received 4.5 TON of 5 in tx ${DEMO_HASH}`, createdAt: new Date(now - 5 * HOUR).toISOString(), open: true, status: 'pending', amountUsd: 25, amountCrypto: 5, txHash: null, receivedNano: null, userId: 'demo-user-910001' },
      { id: 'dep-002', caseId: 'case-dep-002', reason: 'overpaid: received 3000000000 nanoton, quoted 2000000000 (credited 10 USD only)', createdAt: new Date(now - 30 * HOUR).toISOString(), open: true, status: 'completed', amountUsd: 10, amountCrypto: 2, txHash: 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5Ym8=', receivedNano: 3_000_000_000, userId: 'demo-user-910002' },
    ],
    users: [demoUser(1, 'alice_demo', now), demoUser(2, 'bob_demo', now), demoUser(3, 'carol_demo', now), demoUser(9, 'spammer_demo', now, { isBanned: true })],
  }
}

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
  const loadPeople = (): PeopleState => {
    try {
      const raw = storage.getItem(PEOPLE_KEY)
      if (raw) return JSON.parse(raw) as PeopleState
    } catch { /* corrupted: reseed */ }
    return seedPeople(now())
  }
  const savePeople = (s: PeopleState) => {
    try { storage.setItem(PEOPLE_KEY, JSON.stringify(s)) } catch { /* best effort */ }
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

    getAnalytics(range: DateRange): ProfitAnalytics {
      const s = load()
      const t = now()
      // demo treasury fees (the real ones come from treasury_transactions)
      const fees = [{ amount: -1.5, created_at: new Date(t - 40 * HOUR).toISOString() }, { amount: -0.75, created_at: new Date(t - 5 * 24 * HOUR).toISOString() }]
      return computeProfitAnalytics([...s.orders, ...mockBackend.metricOrders()], fees, range)
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

    /** Cases are derived from the queue here (the server stores them); the case id is "case-<order id>". */
    getCases(): ReconCase[] {
      const t = now()
      const people = loadPeople()
      const orderCases: ReconCase[] = load().orders
        .filter((o) => inReconciliationQueue(o, t))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((o) => {
          const user = people.users.find((u) => u.telegramId === o.telegramId)
          return {
            id: `case-${o.id}`, entityType: 'order' as const, entityId: o.id,
            reason: o.error_message ?? 'Stuck in processing without a confirmation from the provider', createdAt: o.created_at,
            order: {
              status: o.status, chargeAmount: o.charge_amount, quantity: o.quantity, targetUrl: o.targetUrl, providerOrderId: o.providerOrderId,
              errorMessage: o.error_message, createdAt: o.created_at, serviceName: o.serviceName, username: o.username, telegramId: o.telegramId,
              canRetry: o.status === 'processing' && !o.providerOrderId, userId: user?.id ?? null, userBanned: user?.isBanned ?? false,
            },
            payment: null,
          }
        })
      const depositCases: ReconCase[] = people.deposits.filter((d) => d.open).map((d) => {
        const user = people.users.find((u) => u.id === d.userId)!
        return {
          id: d.caseId, entityType: 'deposit' as const, entityId: d.id, reason: d.reason, createdAt: d.createdAt, order: null, payment: null,
          deposit: {
            status: d.status, amountUsd: d.amountUsd, amountCrypto: d.amountCrypto, asset: 'TON', network: 'mainnet', memo: `dep_${d.id}`,
            txHash: d.txHash, receivedNano: d.receivedNano, validUntil: d.createdAt, createdAt: d.createdAt,
            username: user.username, telegramId: user.telegramId, userId: user.id, userBanned: user.isBanned,
          },
        }
      })
      return [...orderCases, ...depositCases]
    },

    /** Same rules as admin_resolve_deposit: a dismiss needs a note; a credit needs the transaction and what arrived (pro rata if short). */
    resolveDeposit(depositId: string, input: ResolveDepositInput): ResolveDepositResult {
      const s = loadPeople()
      const d = s.deposits.find((x) => x.id === depositId)
      if (!d) throw new AdminApiError('not_found', 'Deposit not found.')
      if (input.action === 'dismiss') {
        if (!input.note.trim()) throw new AdminApiError('invalid_input', 'a note is required to dismiss a deposit case')
        d.open = false
        savePeople(s)
        return { depositId, status: d.status, credited: 0, action: 'dismiss', replayed: false }
      }
      if (d.status === 'completed') {
        if (d.txHash === input.txHash) { d.open = false; savePeople(s); return { depositId, status: 'completed', credited: 0, action: 'credit', replayed: true } }
        throw new AdminApiError('conflict', 'this deposit was credited with another transaction')
      }
      if (!(input.receivedNano > 0)) throw new AdminApiError('invalid_input', 'the received amount (nanoton) is required')
      const credited = Math.round(d.amountUsd * Math.min(input.receivedNano / (d.amountCrypto * 1e9), 1) * 10_000) / 10_000
      Object.assign(d, { status: 'completed', txHash: input.txHash, receivedNano: input.receivedNano, open: false })
      savePeople(s)
      return { depositId, status: 'completed', credited, action: 'credit', replayed: false }
    },

    findUsers(query: string): AdminUserView[] {
      const q = query.trim().replace(/^@/, '').toLowerCase()
      if (q.length < 2) throw new AdminApiError('invalid_input', 'type 2 to 64 characters')
      return loadPeople().users.filter((u) => String(u.telegramId) === q || u.id === q || (u.username ?? '').toLowerCase().startsWith(q))
    },

    setUserBan(userId: string, banned: boolean): { userId: string; isBanned: boolean } {
      const s = loadPeople()
      const u = s.users.find((x) => x.id === userId)
      if (!u) throw new AdminApiError('not_found', 'User not found.')
      if (u.isYou) throw new AdminApiError('invalid_input', 'you cannot ban or unban yourself')
      u.isBanned = banned
      savePeople(s)
      return { userId, isBanned: banned }
    },

    resolveCaseRefund(caseId: string): void {
      this.forceRefund(caseId.replace(/^case-/, ''))
    },

    retryCase(caseId: string): void {
      const s = load()
      const o = find(s, caseId.replace(/^case-/, ''))
      if (o.status !== 'processing' || o.providerOrderId) throw new AdminApiError('conflict', 'This order cannot be retried. Refund it or mark it resolved.')
      o.providerOrderId = `MOCK-${o.id.slice(-4)}`
      o.status = 'submitted'
      o.error_message = null
      save(s)
    },

    resolveCaseManual(caseId: string, input: { note?: string; providerOrderId?: string }): void {
      this.markResolved(caseId.replace(/^case-/, ''), input)
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
