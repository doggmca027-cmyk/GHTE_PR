// Client of the referrals Edge Function: your invite code and earnings (SUMMARY) and attaching an invite (APPLY_CODE).
// The caller is always the signed-in user (the JWT); every rule lives on the server.

import type { AuthSession } from './auth'
import type { ReferralSummaryResponse } from '@/types/referrals'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 10_000

export type ReferralSummary = Omit<ReferralSummaryResponse, 'success'>

async function call<T>(session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/referrals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean }) | null
  if (!res.ok || !data?.success) throw new Error(`Referral request failed (${res.status})`)
  return data
}

const MOCK_SUMMARY: ReferralSummary = {
  code: 'DEMO42', startParam: 'ref_DEMO42', referred: false, percentage: 5, holdDays: 7, invitees: 0,
  balance: { total: 0, pending: 0, available: 0 }, recent: [],
}

export async function getReferralSummary(session: AuthSession): Promise<ReferralSummary> {
  if (session.isMock) return MOCK_SUMMARY
  const { success, ...summary } = await call<ReferralSummaryResponse>(session, { action: 'SUMMARY' })
  void success
  return summary
}

/** Attaches the invite in a Telegram start parameter ("ref_<code>"). The server refuses it after the first order or for your own code. */
export async function applyReferralCode(session: AuthSession, code: string): Promise<void> {
  if (session.isMock) return
  await call(session, { action: 'APPLY_CODE', code })
}
