// Client of the admin-analytics function's product-analytics answer. Admins only; the server checks it (403 for anyone else).
import type { AuthSession } from '@/services/api/auth'
import { AdminApiError } from './mock-admin'
import { mockBi } from './mock-bi'
import type { BiRange, BiResponse } from '@/types/admin-bi'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 20_000

const isSection = (v: unknown): boolean => typeof v === 'object' && v !== null && ('data' in v || 'error' in v)

export async function getBiDashboard(session: AuthSession, days: BiRange): Promise<BiResponse> {
  if (session.isMock) {
    if (!session.user.isAdmin) throw new AdminApiError('forbidden', 'Admin access required.')
    return mockBi(days)
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-analytics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ action: 'BI', days }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AdminApiError('network', 'Connection lost. Please try again.')
  }
  const body = (await res.json().catch(() => null)) as (Partial<BiResponse> & { message?: string }) | null
  if (res.ok && body?.success && [body.funnel, body.revenue, body.retention, body.topServices].every(isSection)) return body as BiResponse
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Admin access required.')
  if (res.status === 400) throw new AdminApiError('invalid_input', body?.message ?? 'Invalid input.')
  throw new AdminApiError('server', 'Something went wrong. Please try again.')
}
