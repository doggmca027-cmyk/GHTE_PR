// Client of the admin-providers Edge Function (LIST_PROVIDERS / UPSERT_PROVIDER / TOGGLE_ROUTING). Admins only; the server checks it.
// The API key travels only in the body of an UPSERT_PROVIDER request and is never logged, kept or echoed here.

import { AdminApiError } from './mock-admin'
import { mockProviders } from './mock-providers'
import type { AuthSession } from './auth'
import type { AdminProvider, UpsertProviderRequest, UpsertProviderResponse } from '@/types/admin-providers'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 15_000

async function call<T>(session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
