// @vitest-environment jsdom
// The hourly limit as the customer meets it: the token of a signed-in customer goes with the question (so the limit is theirs and not their
// network's), and a 429 tells how long to wait, in the customer's language.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChat } from '../src/components/chat/AiChat'
import { askAssistant, ChatError, retryAfterOf } from '../src/lib/ai-chat'
import type { AuthSession } from '../src/services/api/auth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const user = (content: string) => ({ role: 'user' as const, content })
const answering = (res: Response, seen: { init?: RequestInit } = {}) => (async (_url: unknown, init?: RequestInit) => { seen.init = init; return res }) as unknown as typeof fetch
const limited = (retryAfter?: string) => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Content-Type': 'application/json', ...(retryAfter === undefined ? {} : { 'Retry-After': retryAfter }) } })

describe('the Retry-After of the server', () => {
  it.each([['1380', 1380], ['1', 1], ['86400', 86_400], [' 60 ', 60]])('%s is %s seconds', (header, seconds) => {
    expect(retryAfterOf({ headers: new Headers({ 'Retry-After': header }) })).toBe(seconds)
  })
  it.each(['', '0', '-5', '1.5', 'abc', '86401', '99999999', 'Wed, 21 Oct 2026 07:28:00 GMT'])('"%s" is nothing worth waiting by', (header) => {
    expect(retryAfterOf({ headers: new Headers({ 'Retry-After': header }) })).toBeUndefined()
  })
  it('no header is nothing', () => {
    expect(retryAfterOf({ headers: new Headers() })).toBeUndefined()
  })
})

describe('asking while limited', () => {
  it('a 429 is a rate_limited error that knows how long to wait', async () => {
    const error = await askAssistant([user('hi')], () => {}, undefined, answering(limited('1380'))).catch((e: unknown) => e) as ChatError
    expect(error).toBeInstanceOf(ChatError)
    expect([error.kind, error.retryAfter]).toEqual(['rate_limited', 1380])
  })
  it('...or does not, when the server did not say (the small per-instance limit does not)', async () => {
    const error = await askAssistant([user('hi')], () => {}, undefined, answering(limited())).catch((e: unknown) => e) as ChatError
    expect([error.kind, error.retryAfter]).toEqual(['rate_limited', undefined])
  })
})

describe('who is asking', () => {
  const body = () => new Response('Hello', { status: 200 })
  it('a signed-in customer sends their token; the server verifies it and counts the question as theirs', async () => {
    const seen: { init?: RequestInit } = {}
    await askAssistant([user('hi')], () => {}, undefined, answering(body(), seen), { token: 'aaa.bbb.ccc' })
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer aaa.bbb.ccc')
  })
  it('a guest sends none', async () => {
    for (const token of [undefined, '']) {
      const seen: { init?: RequestInit } = {}
      await askAssistant([user('hi')], () => {}, undefined, answering(body(), seen), { token })
      expect(Object.keys(seen.init?.headers as object)).not.toContain('Authorization')
    }
  })
})

describe('the assistant sheet', () => {
  let host: HTMLElement
  let root: Root
  const session = (token: string) => ({ token, expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'ru', isAdmin: false } }) as AuthSession
  const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
  const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }) }
  const typeInto = async (el: Element | null, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const ask = async (token = 't', text = 'cheap followers') => {
    await act(async () => { root.render(createElement(AiChat, { session: session(token) })) })
    if (!host.querySelector('[role="dialog"]')) await click(byLabel('AI assistant'))
    await typeInto(host.querySelector('input'), text)
    await click(byLabel('Send'))
    await flush(10)
  }
  const alert = () => host.querySelector('[role="alert"]')?.textContent ?? ''

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('tells how long to wait when the server said (in whole minutes, at least one), and offers no retry: waiting is the way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => limited('1380')))
    await ask()
    expect(alert()).toContain('🤖 My AI reply limit for this hour is used up! Please use the catalogue search or contact support. You can ask me again in 23 min.')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(false)
  })
  it('rounds the wait up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => limited('61')))
    await ask()
    expect(alert()).toContain('You can ask me again in 2 min.')
  })
  it('says the general thing when the server did not say how long', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => limited()))
    await ask()
    expect(alert()).toContain('🤖 My AI reply limit for this hour is used up! Please use the catalogue search or contact support.')
    expect(alert()).not.toContain('ask me again in')
  })
  it('the wait goes away with the next question and with a new chat', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++attempt === 1 ? limited('600') : new Response('Here you are.', { status: 200 }))))
    await ask()
    expect(alert()).toContain('You can ask me again in 10 min.')
    await typeInto(host.querySelector('input'), 'and again')
    await click(byLabel('Send'))
    await flush(10)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('Here you are.')
  })
  it('sends the token of the session, and none for a guest', async () => {
    const calls: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(init.headers as Record<string, string>); return new Response('ok', { status: 200 }) }))
    await ask('the.signed.token')
    expect(calls[0]!.Authorization).toBe('Bearer the.signed.token')
    await act(async () => { root.unmount() })
    root = createRoot(host)
    await ask('')
    expect(Object.keys(calls[1]!)).not.toContain('Authorization')
  })
})
