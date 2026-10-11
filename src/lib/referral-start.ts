// An invite link opens the Mini App with start_param "ref_<code>": attach that invite once, quietly. The server decides whether it
// counts (not your own code, not after your first order, the referrer never changes), so a refusal is simply ignored.
import { applyReferralCode } from '@/services/api/referrals'
import type { AuthSession } from '@/services/api/auth'

const STORAGE_KEY = 'referral_start_applied'

/** The start parameter if it is an invite, else null. */
export function inviteStartParam(startParam: string | null | undefined): string | null {
  return typeof startParam === 'string' && /^ref_[A-Za-z0-9_-]{3,64}$/.test(startParam) ? startParam : null
}

/** Sends the invite of this launch at most once per device and invite; never throws. Returns whether a request was made. */
export async function applyStartReferral(
  session: AuthSession,
  startParam: string | null | undefined,
  apply: (s: AuthSession, code: string) => Promise<void> = applyReferralCode,
): Promise<boolean> {
  const invite = inviteStartParam(startParam)
  if (!invite) return false
  const marker = `${session.user.id}:${invite}`
  try {
    if (localStorage.getItem(STORAGE_KEY) === marker) return false
  } catch { /* no storage: the server makes a repeat harmless anyway */ }
  try {
    await apply(session, invite)
  } catch { /* refused or offline: nothing to show the customer */ }
  try {
    localStorage.setItem(STORAGE_KEY, marker)
  } catch { /* ignore */ }
  return true
}
