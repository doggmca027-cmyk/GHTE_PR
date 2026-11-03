import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { IWallet } from '@/types'
import { mockBackend } from '@/services/api/mock-orders'
import { AuthError, GUEST_SESSION, authenticateWithTelegram, fetchWallet, type AuthSession } from '@/services/api/auth'
import { clearWebSession, insideTelegram, loadWebSession, saveWebSession } from '@/services/api/web-auth'

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
  /** A session from the web sign-in (e-mail / Telegram widget): shown now and remembered in this browser. */
  signInWeb: (session: AuthSession) => void
  /** Forgets the web session in this browser (nothing to do inside Telegram, where initData signs in again). */
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)
const TOKEN_REFRESH_MARGIN_S = 60
/** The balance is read at most this often: opening card after card, or switching apps back and forth, must not read it every time. A placed order brings the new balance itself. */
export const WALLET_FRESH_MS = 15_000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const sessionRef = useRef<AuthSession | null>(null)
  const walletReadAt = useRef(0)

  const login = useCallback(async () => {
    setState({ status: 'loading' })
    // a regular browser: the session remembered from the web sign-in, if it is still valid (Telegram always uses initData)
    if (!insideTelegram()) {
      const remembered = loadWebSession()
      if (remembered) {
        sessionRef.current = remembered
        setState({ status: 'authenticated', session: remembered })
        const wallet = await fetchWallet(remembered.token)
        if (wallet && sessionRef.current === remembered) {
          const next = { ...remembered, wallet }
          sessionRef.current = next
          setState({ status: 'authenticated', session: next })
        }
        return
      }
    }
    try {
      const session = await authenticateWithTelegram()
      sessionRef.current = session
      setState({ status: 'authenticated', session })
    } catch (e) {
      sessionRef.current = null
      // outside Telegram there is no initData: the website opens for a guest (catalogue and prices); signing in is one button away
      if (e instanceof AuthError && e.code === 'not_in_telegram') {
        sessionRef.current = GUEST_SESSION
        setState({ status: 'authenticated', session: GUEST_SESSION })
        return
      }
      setState({ status: 'error', message: e instanceof AuthError ? e.message : 'Unexpected error. Please retry.' })
    }
  }, [])

  const refreshWallet = useCallback(async () => {
    const session = sessionRef.current
    if (!session || session.isGuest) return
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
      // a web session cannot be renewed silently: forget it, the sign-in starts again
      if (!insideTelegram()) clearWebSession()
      await login()
      return
    }
    if (Date.now() - walletReadAt.current < WALLET_FRESH_MS) return
    walletReadAt.current = Date.now() // set before the call: two callers at once make one request
    const wallet = await fetchWallet(session.token)
    if (!wallet) { walletReadAt.current = 0; return } // a failed read is tried again at the next chance
    const next = { ...session, wallet }
    sessionRef.current = next
    setState({ status: 'authenticated', session: next })
  }, [login])

  const applyWallet = useCallback((wallet: IWallet) => {
    const session = sessionRef.current
    if (!session) return
    walletReadAt.current = Date.now() // the server has just said what it is
    const next = { ...session, wallet }
    sessionRef.current = next
    setState({ status: 'authenticated', session: next })
  }, [])

  const signInWeb = useCallback((session: AuthSession) => {
    saveWebSession(session)
    sessionRef.current = session
    setState({ status: 'authenticated', session })
  }, [])

  const signOut = useCallback(() => {
    clearWebSession()
    sessionRef.current = null
    void login()
  }, [login])

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

  const value = useMemo(
    () => ({ state, retry: () => void login(), refreshWallet, applyWallet, signInWeb, signOut }),
    [state, login, refreshWallet, applyWallet, signInWeb, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
