// @vitest-environment jsdom
// The website's sign-in (the app opened outside Telegram): the signed-out state, the forms, the error texts and the Telegram widget.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.hoisted(() => ({
  loginWithPassword: vi.fn(),
  registerWithEmail: vi.fn(),
  requestEmailCode: vi.fn(),
  verifyEmailCode: vi.fn(),
  resetPassword: vi.fn(),
  loginWithTelegramWidget: vi.fn(),
}))
vi.mock('../src/services/api/web-auth', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...api }))

const SESSION = { token: 'jwt', expiresAt: 9e9, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: null, email: 'a@b.co', username: null, firstName: null, languageCode: 'en', isAdmin: false } }

let host: HTMLDivElement
let root: Root
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const type = (el: Element | null, value: string) => {
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement
const submit = async () => { act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit()); await flush() }

async function mount() {
  const { WebSignIn } = await import('../src/components/auth/WebSignIn')
  const onSignedIn = vi.fn()
  act(() => root.render(createElement(WebSignIn, { onSignedIn })))
  return onSignedIn
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllEnvs()
})

describe('the bot of the widget', () => {
  it('from VITE_TELEGRAM_BOT_USERNAME, else from the Mini App link', async () => {
    const { telegramBotUsername } = await import('../src/lib/telegram-bot')
    expect(telegramBotUsername({ VITE_TELEGRAM_BOT_USERNAME: '@GHTE_PR_BOT' })).toBe('GHTE_PR_BOT')
    expect(telegramBotUsername({ VITE_TWA_RETURN_URL: 'https://t.me/GHTE_PR_BOT/app' })).toBe('GHTE_PR_BOT')
    expect(telegramBotUsername({ VITE_TWA_RETURN_URL: 'https://example.com' })).toBeNull()
    expect(telegramBotUsername({})).toBeNull()
  })
})

describe('signed out outside Telegram', () => {
  it('no initData and no remembered session: the website sign-in, not an error', async () => {
    vi.resetModules()
    vi.doMock('../src/services/api/auth', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/services/api/auth')>()
      return { ...real, authenticateWithTelegram: vi.fn(async () => { throw new real.AuthError('not_in_telegram', 'Please open this app from Telegram.') }) }
    })
    const { AuthProvider, useAuth } = await import('../src/context/AuthContext')
    const Probe = () => createElement('p', null, useAuth().state.status)
    act(() => root.render(createElement(AuthProvider, null, createElement(Probe))))
    await flush()
    expect(host.textContent).toBe('signed_out')
    vi.doUnmock('../src/services/api/auth')
  })
})

describe('the sign-in form', () => {
  it('e-mail + password signs in', async () => {
    api.loginWithPassword.mockResolvedValue(SESSION)
    const onSignedIn = await mount()
    type(host.querySelector('input[type="email"]'), ' a@b.co ')
    type(host.querySelector('input[type="password"]'), 'secret-pass')
    await submit()
    expect(api.loginWithPassword).toHaveBeenCalledWith('a@b.co', 'secret-pass')
    expect(onSignedIn).toHaveBeenCalledWith(SESSION)
  })

  it('checks the form before asking the server', async () => {
    await mount()
    type(host.querySelector('input[type="email"]'), 'not-an-email')
    await submit()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid e-mail address.')
    type(host.querySelector('input[type="email"]'), 'a@b.co')
    await submit()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Enter your password.')
    expect(api.loginWithPassword).not.toHaveBeenCalled()
  })

  it('a refusal reads as a sentence (with the attempts left)', async () => {
    const { WebAuthError } = await import('../src/services/api/web-auth')
    api.loginWithPassword.mockRejectedValue(new WebAuthError('invalid_credentials', 'Wrong e-mail or password.'))
    await mount()
    type(host.querySelector('input[type="email"]'), 'a@b.co')
    type(host.querySelector('input[type="password"]'), 'x')
    await submit()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Wrong e-mail or password.')
  })

  it('sign-up: password rule, code e-mailed, the code confirms the account', async () => {
    api.registerWithEmail.mockResolvedValue({ codeSent: true, email: 'a@b.co', expiresInSeconds: 600 })
    api.verifyEmailCode.mockResolvedValue({ ...SESSION, created: true })
    const onSignedIn = await mount()
    act(() => button('No account yet? Create one').click())
    type(host.querySelector('input[type="email"]'), 'a@b.co')
    type(host.querySelector('input[type="password"]'), 'short')
    await submit()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Password must be at least 8 characters.')
    type(host.querySelector('input[type="password"]'), 'long-enough')
    await submit()
    expect(api.registerWithEmail).toHaveBeenCalledWith('a@b.co', 'long-enough', expect.objectContaining({ lang: 'en' }))
    expect(host.textContent).toContain('We sent a 6-digit code to a@b.co.')
    expect(button('Send the code again in 60 s')).toBeTruthy()
    type(host.querySelector('input[autocomplete="one-time-code"]'), '12a3456')
    await submit()
    expect(api.verifyEmailCode).toHaveBeenCalledWith('a@b.co', '123456', 'register_verify')
    expect(onSignedIn).toHaveBeenCalled()
  })

  it('forgotten password: a code, then a new password', async () => {
    api.requestEmailCode.mockResolvedValue({ codeSent: true, email: 'a@b.co', expiresInSeconds: 600 })
    api.resetPassword.mockResolvedValue(SESSION)
    const onSignedIn = await mount()
    act(() => button('Forgot password?').click())
    type(host.querySelector('input[type="email"]'), 'a@b.co')
    await submit()
    expect(api.requestEmailCode).toHaveBeenCalledWith('a@b.co', 'reset_password', 'en')
    type(host.querySelector('input[autocomplete="one-time-code"]'), '654321')
    type(host.querySelector('input[autocomplete="new-password"]'), 'brand-new-pass')
    await submit()
    expect(api.resetPassword).toHaveBeenCalledWith('a@b.co', '654321', 'brand-new-pass')
    expect(onSignedIn).toHaveBeenCalledWith(SESSION)
  })

  it('links to the legal pages and the refund rules', async () => {
    await mount()
    expect([...host.querySelectorAll('footer a')].map((a) => a.getAttribute('href'))).toEqual(['/terms', '/privacy', '/terms#orders'])
  })
})

describe('the Telegram widget', () => {
  it('loads Telegram\'s widget for the bot and signs in with what it hands back', async () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', 'https://t.me/GHTE_PR_BOT')
    api.loginWithTelegramWidget.mockResolvedValue(SESSION)
    const onSignedIn = await mount()
    const script = host.querySelector('[data-testid="telegram-login-widget"] script') as HTMLScriptElement
    expect(script.src).toBe('https://telegram.org/js/telegram-widget.js?22')
    expect(script.getAttribute('data-telegram-login')).toBe('GHTE_PR_BOT')
    expect(script.getAttribute('data-onauth')).toBe('__gramHubTelegramAuth(user)')
    const user = { id: 1, first_name: 'A', auth_date: 1, hash: 'h'.repeat(64) }
    await act(async () => { (window as unknown as Record<string, (u: unknown) => void>).__gramHubTelegramAuth(user) })
    await flush()
    expect(api.loginWithTelegramWidget).toHaveBeenCalledWith(user)
    expect(onSignedIn).toHaveBeenCalledWith(SESSION)
  })

  it('no bot known: no widget', async () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', '')
    await mount()
    expect(host.querySelector('[data-testid="telegram-login-widget"]')).toBeNull()
  })
})
