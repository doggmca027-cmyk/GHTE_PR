import { WebApp } from '@/lib/webapp'
import { MOCK_SESSION } from '@/constants/dev'
import { mockBackend } from '@/services/api/mock-orders'
import type { IUser, IWallet } from '@/types'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const REQUEST_TIMEOUT_MS = 10_000
/** Build-time switch: serve the offline mock backend instead of Supabase (no real access is granted by it). */
const FORCE_MOCK = import.meta.env.VITE_MOCK_MODE === 'true'

export interface AuthSession {
  /** Supabase-compatible JWT (sub = users.id). Empty string in mock mode. */
  token: string
  /** Unix seconds. */
  expiresAt: number
  user: IUser
  wallet: IWallet
  isMock: boolean
}

export type AuthErrorCode = 'not_in_telegram' | 'not_configured' | 'network' | 'user_banned' | 'signups_paused' | 'rejected' | 'server'

export class AuthError extends Error {
  readonly code: AuthErrorCode
  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

/**
 * Sends the raw Telegram initData to the `telegram-auth` Edge Function.
 * The signature is verified server-side only; the client never checks it.
 */
export async function authenticateWithTelegram(): Promise<AuthSession> {
  const initData = WebApp.initData

  if (FORCE_MOCK) return { ...MOCK_SESSION, wallet: mockBackend.getWallet() }
  if (!initData) {
    // dev fallback: plain browser, no Telegram
    if (import.meta.env.DEV) return { ...MOCK_SESSION, wallet: mockBackend.getWallet() }
    throw new AuthError('not_in_telegram', 'Please open this app from Telegram.')
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new AuthError('not_configured', 'Backend is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).')
  }

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/telegram-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ initData }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new AuthError('network', 'Could not reach the server. Check your connection and retry.')
  }

  const body = (await res.json().catch(() => null)) as
    | (Omit<AuthSession, 'isMock'> & { error?: undefined })
    | { error: string }
    | null

  if (!res.ok || !body || 'error' in body) {
    const code = body && 'error' in body ? body.error : undefined
    if (code === 'user_banned') throw new AuthError('user_banned', 'Your account is suspended.')
    if (code === 'signups_paused') throw new AuthError('signups_paused', 'New registrations are temporarily closed. Please try again later.')
    if (res.status === 401) throw new AuthError('rejected', 'Your Telegram session is invalid or expired. Reopen the app.')
    throw new AuthError('server', 'Something went wrong on our side. Please try again.')
  }
  return { ...body, isMock: false }
}

/** Reads the signed-in user's wallet through RLS (the JWT's sub must match wallets.user_id). */
export async function fetchWallet(token: string): Promise<IWallet | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !token) return null
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/wallets?select=balance,currency&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const rows = (await res.json()) as { balance: number | string; currency: string }[]
    return rows[0] ? { balance: Number(rows[0].balance), currency: rows[0].currency } : null
  } catch {
    return null
  }
}
