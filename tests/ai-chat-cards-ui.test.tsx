// @vitest-environment jsdom
// The cards inside the conversation: a service the assistant recommended is a small card with a button; pressing it closes the sheet and sends the
// article to the app, which opens the order form on it.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChat } from '../src/components/chat/AiChat'
import type { ChatCard } from '../src/lib/ai-chat'
import type { AuthSession } from '../src/services/api/auth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { token: 't', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'ru', isAdmin: false } } as AuthSession
const FOL = 'IG-FOL-STD-ROOT89336'
const VIEW = 'IG-VIEW-STD-ROOT1'
const card = (sku: string, over: Partial<ChatCard> = {}): ChatCard => ({
  sku, name: 'Instagram Followers [Refill: 30 Days]', price: 0.9828, category: 'Instagram Followers', platform: 'instagram', min: 50, max: 200_000,
  refill: true, refillDays: 30, dripfeed: false, role: 'main', ...over,
})
const line = (e: object) => `${JSON.stringify(e)}\n`

describe('the cards of the assistant', () => {
  let host: HTMLElement
  let root: Root
  const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
  const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }) }
  const typeInto = async (el: Element | null, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const answerWith = (body: string, type = 'application/x-ndjson') => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': type } })))
  const ask = async (props: Record<string, unknown> = {}) => {
    await act(async () => { root.render(createElement(AiChat, { session, ...props })) })
    await click(byLabel('AI assistant'))
    await typeInto(host.querySelector('input'), 'cheap followers and views')
    await click(byLabel('Send'))
    await flush(10)
  }
  const cards = () => [...host.querySelectorAll('[data-testid="chat-card"]')] as HTMLElement[]

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

  it('a recommended service is a card under the answer: its name, article, price per 1000, guarantee and limits, all from the card', async () => {
    answerWith(line({ t: 'text', d: `Take **${FOL}** and **${VIEW}**.` }) + line({ t: 'card', c: card(FOL) }) + line({ t: 'card', c: card(VIEW, { name: 'Instagram Video Views', price: 0.12, refill: false, role: 'addon', dripfeed: true }) }) + line({ t: 'end' }))
    await ask()
    expect(cards().map((c) => c.dataset.sku)).toEqual([FOL, VIEW])
    const first = cards()[0]!
    expect(first.textContent).toContain('Instagram Followers [Refill: 30 Days]')
    expect(first.textContent).toContain(FOL)
    expect(first.textContent).toContain('0.9828')
    expect(first.textContent).toContain('/ 1,000')
    expect(first.textContent).toContain('Recovery: 30 d') // the guarantee, in the words of the catalogue's own cards
    expect(first.textContent).toContain('Min 50 · Max 200K')
    const second = cards()[1]!
    expect(second.textContent).toContain('No refill')
    expect(second.textContent).toContain('Drip-feed')
    expect(host.querySelector('[data-testid="chat-cards"]')).not.toBeNull()
  })

  it('"Select" closes the sheet and gives the article to the app, which opens the order form on it', async () => {
    answerWith(line({ t: 'text', d: `Take **${FOL}**.` }) + line({ t: 'card', c: card(FOL) }) + line({ t: 'end' }))
    const selected: string[] = []
    await ask({ onSelectService: (sku: string) => selected.push(sku) })
    await click(byLabel(`Select: ${FOL}`))
    expect(selected).toEqual([FOL])
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('an article that has its own card has no "find in the catalogue" button; one that has none keeps it', async () => {
    answerWith(line({ t: 'text', d: `Take **${FOL}** and **${VIEW}**.` }) + line({ t: 'card', c: card(FOL) }) + line({ t: 'end' }))
    await ask({ onFindArticle: () => {}, onSelectService: () => {} })
    expect(byLabel(`Find in the catalogue: ${FOL}`)).toBeNull()
    expect(byLabel(`Find in the catalogue: ${VIEW}`)).not.toBeNull()
    expect(byLabel(`Copy article number: ${FOL}`)).not.toBeNull() // it can still be copied
  })

  it('an answer without cards (the model recommended nothing) is just the bubble, as before', async () => {
    answerWith(line({ t: 'text', d: 'Which platform?' }) + line({ t: 'end' }))
    await ask()
    expect(host.textContent).toContain('Which platform?')
    expect(cards()).toHaveLength(0)
    expect(host.querySelector('[data-testid="chat-cards"]')).toBeNull()
  })

  it('an answer that is only cards has no empty bubble above them', async () => {
    answerWith(line({ t: 'card', c: card(FOL) }) + line({ t: 'end' }))
    await ask()
    expect(cards()).toHaveLength(1)
    expect(byLabel('Loading')).toBeNull()
  })

  it('a server that answers with plain text still works: the text, the old chips, no cards', async () => {
    answerWith(`Take **${FOL}**`, 'text/plain; charset=utf-8')
    await ask({ onFindArticle: () => {} })
    expect(byLabel(`Copy article number: ${FOL}`)).not.toBeNull()
    expect(byLabel(`Find in the catalogue: ${FOL}`)).not.toBeNull()
    expect(cards()).toHaveLength(0)
  })

  it('the cards go with the conversation on the screen, but only the words go to the server with the next question', async () => {
    const calls: { messages: { role: string; content: string; cards?: unknown }[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return new Response(line({ t: 'text', d: 'Answer.' }) + (calls.length === 1 ? line({ t: 'card', c: card(FOL) }) : '') + line({ t: 'end' }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    }))
    await ask()
    await typeInto(host.querySelector('input'), 'and with a refill?')
    await click(byLabel('Send'))
    await flush(10)
    expect(cards()).toHaveLength(1) // the first answer keeps its card
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'cheap followers and views' }, { role: 'assistant', content: 'Answer.' }, { role: 'user', content: 'and with a refill?' },
    ])
  })
})
