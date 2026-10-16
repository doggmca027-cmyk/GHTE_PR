// Client of the admin-providers Edge Function (LIST_PROVIDERS / UPSERT_PROVIDER / TOGGLE_ROUTING / ARBITRAGE_STATUS /
// SET_ARBITRAGE_MODE / ARBITRAGE_CANDIDATES / DECIDE_CANDIDATE / RUN_ARBITRAGE_MATCH). Admins only; the server checks it.
// The API key travels only in the body of an UPSERT_PROVIDER request and is never logged, kept or echoed here.

import { AdminApiError } from './mock-admin'
import { mockProviders } from './mock-providers'
import type { AuthSession } from './auth'
import type { AdminProvider, ArbitrageCandidatesPage, ArbitrageStatus, CandidateStatus, SetArbitrageModeResponse, UpsertProviderRequest, UpsertProviderResponse } from '@/types/admin-providers'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 15_000
// switching arbitrage on asks every donor panel for its balance first (8 s each, in parallel)
const ARBITRAGE_TIMEOUT_MS = 30_000

async function call<T>(session: AuthSession, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // never include the error: it could carry request details
    throw new AdminApiError('network', 'Connection lost. Please try again.')
  }
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
  if (res.ok && data?.success) return data
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Admin access required.')
  if (res.status === 400) throw new AdminApiError('invalid_input', data?.message ?? 'Invalid input.')
  if (res.status === 404) throw new AdminApiError('not_found', data?.message ?? 'Provider not found.')
  if (res.status === 409) throw new AdminApiError('conflict', data?.message ?? 'The change conflicts with the current state.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}

const guardMock = (session: AuthSession) => {
  if (!session.user.isAdmin) throw new AdminApiError('forbidden', 'Admin access required.')
}

export async function listAdminProviders(session: AuthSession): Promise<AdminProvider[]> {
  if (session.isMock) {
    guardMock(session)
    return mockProviders().adminList()
  }
  return (await call<{ providers: AdminProvider[] }>(session, { action: 'LIST_PROVIDERS' })).providers
}

export async function upsertProvider(session: AuthSession, request: UpsertProviderRequest): Promise<UpsertProviderResponse> {
  if (session.isMock) {
    guardMock(session)
    return mockProviders().upsert(request)
  }
  return call<UpsertProviderResponse>(session, { ...request })
}

export async function toggleProviderRouting(session: AuthSession, id: string, enabled: boolean): Promise<AdminProvider> {
  if (session.isMock) {
    guardMock(session)
    return mockProviders().toggleRouting(id, enabled)
  }
  return (await call<{ provider: AdminProvider }>(session, { action: 'TOGGLE_ROUTING', id, enabled })).provider
}

export async function getArbitrageStatus(session: AuthSession): Promise<ArbitrageStatus> {
  if (session.isMock) {
    guardMock(session)
    return mockProviders().arbitrageStatus()
  }
  const r = await call<ArbitrageStatus>(session, { action: 'ARBITRAGE_STATUS' })
  return { enabled: r.enabled, primary: r.primary, donors: r.donors }
}

/** One switch for every donor network; the primary network is never touched. */
export async function setArbitrageMode(session: AuthSession, enabled: boolean): Promise<SetArbitrageModeResponse> {
  if (session.isMock) {
    guardMock(session)
    return mockProviders().setArbitrageMode(enabled)
  }
  return call<SetArbitrageModeResponse>(session, { action: 'SET_ARBITRAGE_MODE', enabled }, ARBITRAGE_TIMEOUT_MS)
}

/** Cheaper donor services the matcher found, 50 a page, closest first. */
export async function listArbitrageCandidates(session: AuthSession, status: CandidateStatus, offset = 0): Promise<ArbitrageCandidatesPage> {
  if (session.isMock) {
    guardMock(session)
    return { items: [], counts: {}, refreshedAt: null }
  }
  const r = await call<ArbitrageCandidatesPage>(session, { action: 'ARBITRAGE_CANDIDATES', status, offset })
  return { items: r.items, counts: r.counts ?? {}, refreshedAt: r.refreshedAt ?? null }
}

/** Approve (link the offer) or reject (never propose it again; an automatic link is removed). */
export async function decideArbitrageCandidate(session: AuthSession, id: string, approve: boolean): Promise<void> {
  if (session.isMock) {
    guardMock(session)
    return
  }
  await call(session, { action: 'DECIDE_CANDIDATE', id, approve })
}

/** Runs the matcher now (the catalogue sync runs it at most hourly). */
export async function runArbitrageMatch(session: AuthSession): Promise<{ auto_linked?: number; pending?: number }> {
  if (session.isMock) {
    guardMock(session)
    return { auto_linked: 0, pending: 0 }
  }
  return (await call<{ result: { auto_linked?: number; pending?: number } }>(session, { action: 'RUN_ARBITRAGE_MATCH' }, ARBITRAGE_TIMEOUT_MS)).result
}
