import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { IWallet } from '@/types'
import { mockBackend } from '@/services/api/mock-orders'
import { AuthError, authenticateWithTelegram, fetchWallet, type AuthSession } from '@/services/api/auth'

type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; session: AuthSession }
  | { status: 'error'; message: string }

interface AuthContextValue {
  state: AuthState
  /** Re-authenticates from scratch (used by the retry button). */
  retry: () => void
  /** Re-reads the wallet balance (re-authenticates if the token is about to expire). */
  refreshWallet: () => Promise<void>
  /** Replaces the displayed wallet (e.g. with the balance returned by place-order). Works in mock mode too. */
  applyWallet: (wallet: IWallet) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)
const TOKEN_REFRESH_MARGIN_S = 60

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const sessionRef = useRef<AuthSession | null>(null)

  const login = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const session = await authenticateWithTelegram()
      sessionRef.current = session
      setState({ status: 'authenticated', session })
    } catch (e) {
      sessionRef.current = null
      setState({ status: 'error', message: e instanceof AuthError ? e.message : 'Unexpected error. Please retry.' })
    }
  }, [])

  const refreshWallet = useCallback(async () => {
    const session = sessionRef.current
    if (!session) return
    if (session.isMock) {
      // Dev: pick up refunds credited by the simulated sync worker.
      const next = { ...session, wallet: mockBackend.getWallet() }
      if (next.wallet.balance !== session.wallet.balance) {
        sessionRef.current = next
        setState({ status: 'authenticated', session: next })
      }
      return
    }
    if (session.expiresAt - Date.now() / 1000 < TOKEN_REFRESH_MARGIN_S) {
      await login()
      return
    }
    const wallet = await fetchWallet(session.token)
    if (!wallet) return
    const next = { ...session, wallet }
    sessionRef.current = next
    setState({ status: 'authenticated', session: next })
  }, [login])

  const applyWallet = useCallback((wallet: IWallet) => {
    const session = sessionRef.current
    if (!session) return
    const next = { ...session, wallet }
    sessionRef.current = next
    setState({ status: 'authenticated', session: next })
  }, [])

  useEffect(() => {
    void login()
  }, [login])

  // Keep the balance fresh whenever the user returns to the app.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshWallet()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refreshWallet])

  const value = useMemo(() => ({ state, retry: () => void login(), refreshWallet, applyWallet }), [state, login, refreshWallet, applyWallet])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
