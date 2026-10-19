// @vitest-environment jsdom
// The website without a sign-in wall: a guest sees the whole site, the header's "Sign in" button and the personal tabs' prompt open the
// sign-in sheet (Telegram's Login Widget, e-mail when on); a signed-in profile connects its Telegram and an e-mail in Settings.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.hoisted(() => ({ linkTelegram: vi.fn(), requestLinkEmail: vi.fn(), verifyLinkEmail: vi.fn() }))
vi.mock('../src/services/api/web-auth', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...api }))

const SESSION = { token: 'jwt', expiresAt: 9e9, isMock: false, wallet: { balance: 3, currency: 'USD' }, user: { id: 'u', telegramId: 42, email: null, username: 'ann', firstName: 'Ann', languageCode: 'en', isAdmin: false } }
const type = (el: Element | null, value: string) => {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

let host: HTMLDivElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
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

describe('the sign-in sheet', () => {
  it('Telegram\'s Login Widget with what it does, the legal links, and it closes on Escape or the backdrop', async () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', 'https://t.me/GHTE_PR_BOT')
    const { SignInModal } = await import('../src/components/auth/SignInModal')
    const onClose = vi.fn()
    act(() => root.render(createElement(SignInModal, { onSignedIn: () => {}, onClose })))
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('signin-title')
    expect(host.querySelector('#signin-title')?.textContent).toBe('Sign in with Telegram')
    expect(host.querySelector('[data-testid="telegram-login-widget"] script')?.getAttribute('data-telegram-login')).toBe('GHTE_PR_BOT')
    expect(host.textContent).toContain('Telegram asks you to confirm the sign-in and shows the device and the place it comes from.')
    expect(host.textContent).toContain('Terms of Service')
    expect(host.textContent).not.toMatch(/Confirm» in the bot|Waiting for confirmation/) // the bot sign-in is gone
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('connected accounts (Settings)', () => {
  const mount = async (user: { telegramId?: number | null; username?: string | null; email?: string | null }, onSessionChange = vi.fn()) => {
    const { ConnectedAccounts } = await import('../src/components/settings/ConnectedAccounts')
    act(() => root.render(createElement(ConnectedAccounts, { session: { ...SESSION, user: { ...SESSION.user, ...user } }, onSessionChange })))
    return onSessionChange
  }

  it('shows what is connected; a profile without Telegram gets the widget on the website', async () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', 'https://t.me/GHTE_PR_BOT')
    await mount({ telegramId: 42, username: 'ann', email: 'ann@example.com' })
    expect(host.textContent).toContain('@ann')
    expect(host.textContent).toContain('ann@example.com')
    expect(host.querySelector('[data-testid="telegram-login-widget"]')).toBeNull()
    act(() => root.render(createElement('div')))
    await mount({ telegramId: null, username: null, email: 'ann@example.com' })
    expect(host.querySelector('[data-testid="telegram-login-widget"] script')).not.toBeNull()
  })

  it('back from Telegram: connects the account and hands the new session up', async () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', 'https://t.me/GHTE_PR_BOT')
    const next = { ...SESSION, token: 'jwt2' }
    api.linkTelegram.mockResolvedValue(next)
    const hash = 'c'.repeat(64)
    window.history.replaceState(null, '', `/?id=42&username=ann&auth_date=1700000000&hash=${hash}`)
    const onSessionChange = await mount({ telegramId: null, username: null, email: 'ann@example.com' })
    await flush()
    expect(api.linkTelegram).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt' }), { id: 42, username: 'ann', auth_date: 1700000000, hash })
    expect(onSessionChange).toHaveBeenCalledWith(next)
    expect(host.textContent).toContain('Telegram is connected.')
    expect(window.location.search).toBe('')
  })

  it('a Telegram account with its own profile is refused with a sentence', async () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', 'https://t.me/GHTE_PR_BOT')
    const { WebAuthError } = await import('../src/services/api/web-auth')
    api.linkTelegram.mockRejectedValue(new WebAuthError('telegram_taken', 'x'))
    window.history.replaceState(null, '', `/?id=42&auth_date=1700000000&hash=${'d'.repeat(64)}`)
    const onSessionChange = await mount({ telegramId: null, username: null, email: 'ann@example.com' })
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This Telegram account already has its own profile.')
    expect(onSessionChange).not.toHaveBeenCalled()
  })

  it('e-mail: an address, then the code and an optional password; the new session goes up', async () => {
    vi.stubEnv('VITE_ENABLE_EMAIL_AUTH', 'true')
    api.requestLinkEmail.mockResolvedValue({ codeSent: true, email: 'ann@example.com', expiresInSeconds: 600 })
    const next = { ...SESSION, user: { ...SESSION.user, email: 'ann@example.com' } }
    api.verifyLinkEmail.mockResolvedValue(next)
    const onSessionChange = await mount({ email: null })
    type(host.querySelector('input[type="email"]'), 'ann@example.com')
    act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit())
    await flush()
    expect(api.requestLinkEmail).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt' }), 'ann@example.com', 'en')
    expect(host.textContent).toContain('We sent a 6-digit code to ann@example.com.')
    type(host.querySelector('input[inputmode="numeric"]'), '123456')
    type(host.querySelector('input[type="password"]'), 'short')
    act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit())
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Password must be at least 8 characters.')
    type(host.querySelector('input[type="password"]'), '')
    act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit())
    await flush()
    expect(api.verifyLinkEmail).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt' }), 'ann@example.com', '123456', undefined)
    expect(onSessionChange).toHaveBeenCalledWith(next)
    expect(host.textContent).toContain('The e-mail is connected.')
  })

  it('without e-mail sending (the default) it says so instead of a form that cannot work', async () => {
    await mount({ email: null })
    expect(host.querySelector('input[type="email"]')).toBeNull()
    expect(host.textContent).toContain('Connecting an e-mail will be available soon.')
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
