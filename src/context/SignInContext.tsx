import { createContext, useContext } from 'react'

/** Opens the "Sign in with Telegram" dialog (a website guest). Inside Telegram there is no guest, so nothing calls it there. */
export const SignInContext = createContext<() => void>(() => {})

export const useSignIn = (): (() => void) => useContext(SignInContext)
