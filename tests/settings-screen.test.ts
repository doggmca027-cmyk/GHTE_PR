import { describe, expect, it } from 'vitest'
import type { AuthSession } from '../src/services/api/auth'

const session = (over: Partial<AuthSession['user']> = {}, isMock = false): AuthSession => ({
  token: 't',
  expiresAt: 0,
  isMock,
  wallet: { balance: 0, currency: 'USD' },
  user: { id: 'u1', telegramId: 6288342755, username: 'someone', firstName: 'Some <b>One</b>', languageCode: 'en', isAdmin: false, ...over },
})

const render = async (s: AuthSession) => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { SettingsScreen } = await import('../src/components/settings/SettingsScreen')
  return renderToStaticMarkup(createElement(SettingsScreen, { session: s }))
}

describe('SettingsScreen', () => {
  it('shows the account and the legal links', async () => {
    const html = await render(session())
    expect(html).toContain('Settings')
    expect(html).toContain('@someone')
    expect(html).toContain('6288342755')
    expect(html).toContain('href="/terms.html"')
    expect(html).toContain('href="/privacy.html"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('escapes the Telegram profile name', async () => {
    const html = await render(session())
    expect(html).not.toContain('<b>One</b>')
    expect(html).toContain('&lt;b&gt;One&lt;/b&gt;')
  })

  it('handles a profile without username or name', async () => {
    const html = await render(session({ username: null, firstName: null }))
    expect(html).not.toContain('@null')
    expect(html).not.toContain('undefined')
  })

  it('flags the dev mock account only', async () => {
    expect(await render(session({}, true))).toContain('Dev mock account')
    expect(await render(session({}, false))).not.toContain('Dev mock account')
  })

  it('does not expose admin status or internal ids', async () => {
    const html = await render(session({ isAdmin: true }))
    expect(html).not.toContain('Admin')
    expect(html).not.toContain('u1')
  })
})
