import type { AuthSession } from '@/services/api/auth'
import type { AdminMetrics, MarginRuleInput, PriceRuleView, PricingRow, ProviderStatus, ReconciliationOrder } from '@/types/admin'
import { createMockPricing } from './mock-pricing'
import { metricsFromRpc } from '../../../supabase/functions/_shared/admin-metrics.ts'
import { AdminApiError, createMockAdmin } from './mock-admin'
import type { OrderStatus } from '@/types'

export { AdminApiError }

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 15_000

// Lazily created so importing this module never touches storage during tests / SSR.
let mock: ReturnType<typeof createMockAdmin> | undefined
const mockAdmin = () => (mock ??= createMockAdmin(browserStorage()))
function browserStorage() {
  try {
    globalThis.localStorage.setItem('__probe', '1')
    globalThis.localStorage.removeItem('__probe')
    return globalThis.localStorage
  } catch {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
}

/** Dev mock mirrors the server's refusal: a non-admin session gets 'forbidden' from every call. */
function guardMock(session: AuthSession): void {
  if (!session.user.isAdmin) throw new AdminApiError('forbidden', 'Admin access required.')
}

/**
 * Calls an admin database function through PostgREST with the user's JWT. The database re-checks
 * is_admin on every call; the client-side `isAdmin` flag only decides whether the tab is shown.
 */
async function rpc<T>(session: AuthSession, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AdminApiError('network', 'Connection lost. Please try again.')
  }
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | T | null
  if (res.ok) return body as T

  const err = (body ?? {}) as { code?: string; message?: string }
  const message = (err.message ?? '').replace(/^[a-z_]+: /i, '')
  if (res.status === 401 || res.status === 403 || err.code === '42501') throw new AdminApiError('forbidden', 'Admin access required.')
  if (err.code === 'P0002' || err.code === 'PGRST202') throw new AdminApiError('not_found', message || 'Not found.')
  if (err.code === '22023') throw new AdminApiError('invalid_input', message || 'Invalid input.')
  if (err.code === '23514' || err.code === '23505') throw new AdminApiError('conflict', message || 'Conflict.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

const num = (v: unknown) => Number(v ?? 0)

export async function getAdminMetrics(session: AuthSession): Promise<AdminMetrics> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().getMetrics()
  }
  return metricsFromRpc(await rpc<Record<string, unknown>>(session, 'get_admin_metrics'))
}

export async function getProviderStatus(session: AuthSession): Promise<ProviderStatus[]> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().getProviders()
  }
  const rows = await rpc<Record<string, unknown>[]>(session, 'admin_provider_status')
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), isActive: r.is_active === true, balance: num(r.balance),
    balanceUpdatedAt: (r.balance_updated_at as string | null) ?? null, lastSyncedAt: (r.last_synced_at as string | null) ?? null,
    activeServices: num(r.active_services),
  }))
}

export async function getReconciliationQueue(session: AuthSession): Promise<ReconciliationOrder[]> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().getQueue()
  }
  const rows = await rpc<Record<string, unknown>[]>(session, 'admin_reconciliation_queue')
  return rows.map((r) => ({
    id: String(r.id), status: r.status as OrderStatus, chargeAmount: num(r.charge_amount), quantity: num(r.quantity),
    targetUrl: String(r.target_url ?? ''), providerOrderId: (r.provider_order_id as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null, createdAt: String(r.created_at), serviceName: String(r.service_name ?? 'Service'),
    username: (r.username as string | null) ?? null, telegramId: num(r.telegram_id),
  }))
}

export async function forceRefund(session: AuthSession, orderId: string, reason?: string): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().forceRefund(orderId)
  }
  await rpc(session, 'admin_force_refund', { p_order_id: orderId, p_reason: reason ?? null })
}

export async function markResolved(session: AuthSession, orderId: string, input: { providerOrderId?: string; note?: string }): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().markResolved(orderId, input)
  }
  await rpc(session, 'admin_mark_resolved', { p_order_id: orderId, p_provider_order_id: input.providerOrderId?.trim() || null, p_note: input.note?.trim() || null })
}

export async function listPriceRules(session: AuthSession): Promise<PriceRuleView[]> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().listRules()
  }
  const rows = await rpc<Record<string, unknown>[]>(session, 'admin_list_price_rules')
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), type: r.type as PriceRuleView['type'], value: num(r.value),
    isActive: r.is_active === true, priority: num(r.priority), scope: String(r.scope ?? 'Global'),
  }))
}

export async function updatePriceRule(session: AuthSession, id: string, patch: { value?: number; isActive?: boolean }): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    mockAdmin().updateRule(id, patch)
    return
  }
  await rpc(session, 'admin_update_price_rule', { p_rule_id: id, p_value: patch.value ?? null, p_is_active: patch.isActive ?? null })
}

// ---- Pricing & margins (admin-pricing Edge Function) -------------------------------------------------

let mockPricingStore: ReturnType<typeof createMockPricing> | undefined
const mockPricing = () => (mockPricingStore ??= createMockPricing())

async function callPricing<T>(session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-pricing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AdminApiError('network', 'Connection lost. Please try again.')
  }
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
  if (res.ok && data?.success) return data
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Admin access required.')
  if (res.status === 400) throw new AdminApiError('invalid_input', data?.message ?? 'Invalid input.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

export async function getPricing(session: AuthSession): Promise<PricingRow[]> {
  if (session.isMock) {
    guardMock(session)
    return mockPricing().list()
  }
  const { services } = await callPricing<{ services: Record<string, unknown>[] }>(session, { action: 'GET' })
  return services.map((r) => {
    const rate = num(r.customer_rate_per_1000)
    const cost = r.best_offer_cost == null ? null : num(r.best_offer_cost)
    const margin = cost === null ? null : rate - cost
    return {
      serviceId: String(r.service_id), name: String(r.name), category: String(r.category ?? ''), platform: String(r.platform ?? ''),
      customerRate: rate, bestCost: cost, marginAbsolute: margin, marginPercent: margin !== null && rate > 0 ? (margin / rate) * 100 : null,
    }
  })
}

export async function setServiceMargin(session: AuthSession, input: MarginRuleInput): Promise<{ repriced: number }> {
  if (session.isMock) {
    guardMock(session)
    mockPricing().setMargin(input)
    return { repriced: 1 }
  }
  return callPricing<{ repriced: number }>(session, { action: 'UPDATE_RULE', serviceId: input.serviceId, type: input.type, value: input.value })
}
