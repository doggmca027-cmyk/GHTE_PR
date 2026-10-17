// @vitest-environment jsdom
// The website without a sign-in wall: a guest sees the whole site, the header's "Sign in" button and the personal tabs' prompt open the
// bot sign-in, and that dialog signs in by itself once the customer presses Confirm in the bot (the server is asked every 2 s).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.hoisted(() => ({ startBotLogin: vi.fn(), pollBotLogin: vi.fn() }))
vi.mock('../src/services/api/web-auth', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...api }))

const SESSION = { token: 'jwt', expiresAt: 9e9, isMock: false, wallet: { balance: 3, currency: 'USD' }, user: { id: 'u', telegramId: 42, email: null, username: 'ann', firstName: 'Ann', languageCode: 'en', isAdmin: false } }
const START = { link: 'https://t.me/GHTE_PR_BOT?start=auth_abc', pollToken: 'p'.repeat(43), expiresInSeconds: 300, pollSeconds: 2 }

let host: HTMLDivElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined

beforeEach(() => {
  api.startBotLogin.mockReset()
  api.pollBotLogin.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the bot sign-in dialog', () => {
  it('opens the bot link, asks every 2 s and signs in on "confirmed", without a reload', async () => {
    vi.useFakeTimers()
    const open = vi.fn(() => ({}) as Window)
    vi.stubGlobal('open', open)
    api.startBotLogin.mockResolvedValue(START)
    api.pollBotLogin.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'opened' }).mockResolvedValueOnce({ status: 'confirmed', session: SESSION })
    const { BotLoginModal } = await import('../src/components/auth/BotLoginModal')
    const onSignedIn = vi.fn()
    const onClose = vi.fn()
    act(() => root.render(createElement(BotLoginModal, { onSignedIn, onClose })))
    await flush()
    expect(api.startBotLogin).toHaveBeenCalledWith('en')
    expect(open).toHaveBeenCalledWith(START.link, '_blank', 'noopener')
    expect(host.querySelector('[data-testid="bot-login-waiting"]')?.textContent).toContain('Open @GHTE_PR_BOT in Telegram')
    expect(host.querySelector(`a[href="${START.link}"]`)?.textContent?.trim()).toBe('Open Telegram')

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.pollBotLogin).toHaveBeenCalledTimes(1)
    expect(api.pollBotLogin).toHaveBeenLastCalledWith(START.pollToken)
    expect(onSignedIn).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(api.pollBotLogin).toHaveBeenCalledTimes(3)
    expect(onSignedIn).toHaveBeenCalledWith(SESSION)
    expect(host.textContent).toContain('You are signed in.')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(onClose).toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.pollBotLogin).toHaveBeenCalledTimes(3) // stops asking once signed in
  })

  it('a Cancel in the bot or an expired request ends the wait and offers a fresh start', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('open', vi.fn(() => null)) // a blocked pop-up: the "Open Telegram" button is still there
    api.startBotLogin.mockResolvedValue(START)
    api.pollBotLogin.mockResolvedValueOnce({ status: 'cancelled' }).mockResolvedValueOnce({ status: 'expired' })
    const { BotLoginModal } = await import('../src/components/auth/BotLoginModal')
    const onSignedIn = vi.fn()
    act(() => root.render(createElement(BotLoginModal, { onSignedIn, onClose: () => {} })))
    await flush()
    expect(host.querySelector(`a[href="${START.link}"]`)).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The sign-in was cancelled in Telegram.')
    act(() => buttonWith('Try again')!.click())
    await flush()
    expect(api.startBotLogin).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The sign-in request has expired.')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('a refusal to start reads as a sentence', async () => {
    const { WebAuthError } = await import('../src/services/api/web-auth')
    api.startBotLogin.mockRejectedValue(new WebAuthError('rate_limited', 'x'))
    const { BotLoginModal } = await import('../src/components/auth/BotLoginModal')
    act(() => root.render(createElement(BotLoginModal, { onSignedIn: () => {}, onClose: () => {} })))
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Too many attempts. Please try again later.')
    expect(api.pollBotLogin).not.toHaveBeenCalled()
  })
})

describe('a guest on the website', () => {
  it('the header shows "Sign in" instead of the balance, and it opens the sign-in', async () => {
    const { Header } = await import('../src/components/layout/Header')
    const onSignIn = vi.fn()
    act(() => root.render(createElement(Header, { balance: 0, currency: 'USD', onTopUp: () => {}, onOpenSettings: () => {}, onOpenSupport: () => {}, guest: true, onSignIn })))
    const button = host.querySelector('[data-testid="header-sign-in"]') as HTMLButtonElement
    expect(button.textContent).toContain('Sign in')
    expect(host.textContent).not.toContain('$0')
    act(() => button.click())
    expect(onSignIn).toHaveBeenCalledTimes(1)
  })

  it('a customer who is signed in sees the balance, not the button', async () => {
    const { Header } = await import('../src/components/layout/Header')
    act(() => root.render(createElement(Header, { balance: 3, currency: 'USD', onTopUp: () => {}, onOpenSettings: () => {}, onOpenSupport: () => {} })))
    expect(host.querySelector('[data-testid="header-sign-in"]')).toBeNull()
  })

  it('a personal tab explains why to sign in, and its button opens the sign-in', async () => {
    const { GuestPrompt } = await import('../src/components/auth/GuestPrompt')
    const { SignInContext } = await import('../src/context/SignInContext')
    const signIn = vi.fn()
    act(() => root.render(createElement(SignInContext.Provider, { value: signIn }, createElement(GuestPrompt, { title: 'Your orders', text: 'Sign in with Telegram to order and follow your orders here.' }))))
    expect(host.querySelector('h1')?.textContent).toBe('Your orders')
    act(() => buttonWith('Sign in with Telegram')!.click())
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('the price request of a guest carries no token; a customer\'s carries theirs', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    vi.resetModules()
    const sent: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('Authorization'))
      return new Response(JSON.stringify({ success: true, listPrice: 1, finalPrice: 1, totalDiscount: 0 }), { status: 200 })
    }))
    const { getQuote } = await import('../src/services/api/quotes')
    const { GUEST_SESSION } = await import('../src/services/api/auth')
    await getQuote(GUEST_SESSION, { serviceId: 's', quantity: 100 })
    await getQuote(SESSION, { serviceId: 's', quantity: 100 })
    expect(sent).toEqual([null, 'Bearer jwt'])
  })

  it('the guest session is never an account: no token, no Telegram id, no admin', async () => {
    const { GUEST_SESSION } = await import('../src/services/api/auth')
    expect(GUEST_SESSION.isGuest).toBe(true)
    expect(GUEST_SESSION.token).toBe('')
    expect(GUEST_SESSION.user.telegramId).toBeNull()
    expect(GUEST_SESSION.user.isAdmin).toBe(false)
  })
})
