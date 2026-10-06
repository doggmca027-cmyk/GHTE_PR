import type { AuthSession } from '@/services/api/auth'
import type { AdminMetrics, MarginRuleInput, PriceRuleView, PricingRow, ProviderConfigPatch, ProviderConfigView, ProviderHealth, ProviderStatus, ReconciliationOrder, PlatformSettingsPatch, PlatformSettingsView, ReconCase, ProfitAnalytics, TopupProposal, TreasuryAdjustment, TreasuryPage, TreasuryTx } from '@/types/admin'
import { createMockPricing } from './mock-pricing'
import { createMockProviders } from './mock-providers'
import { createMockSettings } from './mock-settings'
import { createMockTreasury } from './mock-treasury'
import { metricsFromRpc } from '../../../supabase/functions/_shared/admin-metrics.ts'
import { analyticsFromRpc } from '../../../supabase/functions/_shared/admin-analytics.ts'
import { analyticsRequest, type AnalyticsRangeKey } from '@/lib/admin-view'
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

// ---- Provider management (admin_list_providers / admin_update_provider_config) ------------------------

let mockProvidersStore: ReturnType<typeof createMockProviders> | undefined
const mockProviders = () => (mockProvidersStore ??= createMockProviders())

const HEALTH: readonly ProviderHealth[] = ['healthy', 'degraded', 'unavailable', 'disabled']

export async function listProviderConfigs(session: AuthSession): Promise<ProviderConfigView[]> {
  if (session.isMock) {
    guardMock(session)
    return mockProviders().list()
  }
  const rows = await rpc<Record<string, unknown>[]>(session, 'admin_list_providers')
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), isActive: r.is_active === true, routingEnabled: r.routing_enabled === true,
    health: HEALTH.includes(r.health_status as ProviderHealth) ? (r.health_status as ProviderHealth) : 'disabled',
    lastHealthCheck: (r.last_health_check as string | null) ?? null, balance: num(r.provider_balance), currency: String(r.currency ?? 'USD'),
    lastBalanceSync: (r.last_balance_sync as string | null) ?? null, lowBalanceThreshold: num(r.low_balance_threshold),
    targetTopupBalance: num(r.target_topup_balance), lowBalanceAlerted: r.balance_alert_sent === true,
  }))
}

export async function updateProviderConfig(session: AuthSession, id: string, patch: ProviderConfigPatch): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    mockProviders().update(id, patch)
    return
  }
  await rpc(session, 'admin_update_provider_config', {
    p_provider_id: id,
    p_low_balance_threshold: patch.lowBalanceThreshold ?? null,
    p_target_topup_balance: patch.targetTopupBalance ?? null,
    p_routing_enabled: patch.routingEnabled ?? null,
  })
}

// ---- Treasury (admin-treasury Edge Function) ---------------------------------------------------------

let mockTreasuryStore: ReturnType<typeof createMockTreasury> | undefined
const mockTreasury = () => (mockTreasuryStore ??= createMockTreasury())

async function callTreasury<T>(session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-treasury`, {
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
  if (res.status === 409) throw new AdminApiError('conflict', data?.message ?? 'Conflict.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

export async function getTreasury(session: AuthSession, beforeSeq: number | null = null): Promise<TreasuryPage> {
  if (session.isMock) {
    guardMock(session)
    return mockTreasury().page(beforeSeq)
  }
  const r = await callTreasury<TreasuryPage>(session, { action: 'GET', ...(beforeSeq !== null ? { beforeSeq } : {}) })
  return { balance: num(r.balance), updatedAt: String(r.updatedAt), transactions: r.transactions as TreasuryTx[], proposals: (r.proposals ?? []) as TopupProposal[], nextBefore: r.nextBefore ?? null }
}

export async function adjustTreasury(session: AuthSession, input: TreasuryAdjustment): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    mockTreasury().adjust(input)
    return
  }
  await callTreasury(session, { action: 'MANUAL_ADJUSTMENT', ...input })
}

export async function decideTopupProposal(session: AuthSession, proposalId: string, decision: 'approve' | 'reject'): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    mockTreasury().decide(proposalId, decision)
    return
  }
  await callTreasury(session, { action: decision === 'approve' ? 'APPROVE_PROPOSAL' : 'REJECT_PROPOSAL', proposalId })
}

// ---- Profit analytics (admin-analytics Edge Function) -----------------------------------------------

export async function getProfitAnalytics(session: AuthSession, range: AnalyticsRangeKey): Promise<ProfitAnalytics> {
  const body = analyticsRequest(range)
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().getAnalytics({ start: body.startDate, end: 'endDate' in body ? null : new Date().toISOString() })
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-analytics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AdminApiError('network', 'Connection lost. Please try again.')
  }
  const data = (await res.json().catch(() => null)) as { success?: boolean; analytics?: Record<string, unknown>; message?: string } | null
  if (res.ok && data?.success && data.analytics) return analyticsFromRpc(data.analytics)
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Admin access required.')
  if (res.status === 400) throw new AdminApiError('invalid_input', data?.message ?? 'Invalid input.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

// ---- Emergency controls (admin-settings Edge Function) ----------------------------------------------

let mockSettingsStore: ReturnType<typeof createMockSettings> | undefined
const mockSettings = () => (mockSettingsStore ??= createMockSettings())

async function callSettings(session: AuthSession, body: Record<string, unknown>): Promise<PlatformSettingsView> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AdminApiError('network', 'Connection lost. Please try again.')
  }
  const data = (await res.json().catch(() => null)) as { success?: boolean; settings?: PlatformSettingsView; message?: string } | null
  if (res.ok && data?.success && data.settings) return data.settings
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Admin access required.')
  if (res.status === 400) throw new AdminApiError('invalid_input', data?.message ?? 'Invalid input.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

export async function getPlatformSettings(session: AuthSession): Promise<PlatformSettingsView> {
  if (session.isMock) {
    guardMock(session)
    return mockSettings().get()
  }
  return callSettings(session, { action: 'GET' })
}

export async function updatePlatformSettings(session: AuthSession, patch: PlatformSettingsPatch): Promise<PlatformSettingsView> {
  if (session.isMock) {
    guardMock(session)
    return mockSettings().update(patch)
  }
  return callSettings(session, { action: 'UPDATE', ...patch })
}

// ---- Reconciliation Center (admin-reconciliation Edge Function) ------------------------------------

async function callRecon<T>(session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-reconciliation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000), // a retry waits for the provider
    })
  } catch {
    throw new AdminApiError('network', 'Connection lost. Check the case list before trying again: the action may have gone through.')
  }
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
  if (res.ok && data?.success) return data
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Admin access required.')
  if (res.status === 404) throw new AdminApiError('not_found', data?.message ?? 'Case not found.')
  if (res.status === 400) throw new AdminApiError('invalid_input', data?.message ?? 'Invalid input.')
  // 409 (already decided / not retryable), 422 (provider refused), 202 (outcome unknown): the server's words are the useful ones.
  if (data?.message && [202, 409, 422, 503].includes(res.status)) throw new AdminApiError('conflict', data.message)
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

export async function getReconCases(session: AuthSession): Promise<ReconCase[]> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().getCases()
  }
  return (await callRecon<{ cases: ReconCase[] }>(session, { action: 'GET_CASES' })).cases
}

export async function resolveCaseRefund(session: AuthSession, caseId: string, reason?: string): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().resolveCaseRefund(caseId)
  }
  await callRecon(session, { action: 'RESOLVE_REFUND', caseId, reason: reason ?? null })
}

export async function retryCase(session: AuthSession, caseId: string): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().retryCase(caseId)
  }
  await callRecon(session, { action: 'RESOLVE_RETRY', caseId })
}

export async function resolveCaseManual(session: AuthSession, caseId: string, input: { note?: string; providerOrderId?: string }): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    return mockAdmin().resolveCaseManual(caseId, input)
  }
  await callRecon(session, { action: 'MARK_RESOLVED', caseId, note: input.note ?? null, providerOrderId: input.providerOrderId ?? null })
}
