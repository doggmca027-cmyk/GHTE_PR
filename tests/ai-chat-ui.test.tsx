// @vitest-environment jsdom
// The AI assistant of the Mini App: a round button over every screen, a sheet to talk in, the answer written as it streams, an article copied with one tap.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChat } from '../src/components/chat/AiChat'
import type { AuthSession } from '../src/services/api/auth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = (over: Partial<AuthSession> = {}) => ({ token: 't', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'ru', isAdmin: false }, ...over }) as AuthSession
const SKU = 'IG-FOL-STD-ROOT89336'

describe('the AI assistant', () => {
  let host: HTMLElement
  let root: Root
  const enc = new TextEncoder()
  const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
  const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLElement | undefined
  const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }) }
  const typeInto = async (el: Element | null, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const mount = async (s = session()) => { await act(async () => { root.render(createElement(AiChat, { session: s })) }) }
  /** A server whose answer is written by the test, piece by piece. */
  const server = () => {
    let write: (text: string) => void = () => {}
    let end: () => void = () => {}
    const calls: { url: string; body: { messages: { role: string; content: string }[] } }[] = []
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(new ReadableStream<Uint8Array>({ start(c) { write = (t) => c.enqueue(enc.encode(t)); end = () => c.close() } }), { status: 200 })
    })
    return { fetchStub, calls, write: async (t: string) => { await act(async () => { write(t); await new Promise((r) => setTimeout(r, 5)) }) }, end: async () => { await act(async () => { end(); await new Promise((r) => setTimeout(r, 5)) }) } }
  }

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

  it('is a round button until it is pressed; then a dialog with the first questions to tap', async () => {
    await mount()
    expect(byLabel('AI assistant')?.tagName).toBe('BUTTON')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click(byLabel('AI assistant'))
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    expect(host.textContent).toContain('Cheapest Instagram followers')
    expect(host.textContent).toContain('Real Instagram followers that do not drop')
    expect(host.textContent).toContain('TikTok views')
    expect(host.querySelector('input')?.getAttribute('placeholder')).toBe('Ask about a service…')
    await click(byLabel('Close'))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('sends the question to /api/chat and writes the answer as it streams; the article in it is a button that copies it', async () => {
    const s = server()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('fetch', s.fetchStub)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await mount()
    await click(byLabel('AI assistant'))
    await click(buttonWith('Cheapest Instagram followers'))
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.url).toBe('/api/chat')
    expect(s.calls[0]!.body.messages).toEqual([{ role: 'user', content: 'Cheapest Instagram followers' }])
    expect(host.textContent).toContain('Cheapest Instagram followers') // the customer's own bubble

    await s.write('Take ')
    expect(host.textContent).toContain('Take ')
    expect(byLabel('Loading')).toBeNull() // the first words are there: the spinner is gone
    await s.write(`**${SKU}** for $0.98 per 1000.`)
    const chip = byLabel(`Copy article number: ${SKU}`)
    expect(chip?.textContent).toContain(SKU)
    expect(host.textContent).not.toContain('**')
    await s.end()

    await click(chip)
    expect(writeText).toHaveBeenCalledWith(SKU)
  })

  it('every article also has a "find in the catalogue" button: it sends the article to the catalogue\'s search and closes the sheet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`Take **${SKU}** and **TT-VIEW-STD-MTP9943**. Вставьте эти артикулы в поиск.`, { status: 200 })))
    const found: string[] = []
    await act(async () => { root.render(createElement(AiChat, { session: session(), onFindArticle: (sku: string) => found.push(sku) })) })
    await click(byLabel('AI assistant'))
    await typeInto(host.querySelector('input'), 'cheap followers and views')
    await click(byLabel('Send'))
    await flush(10)
    expect(byLabel(`Find in the catalogue: ${SKU}`)).not.toBeNull()
    expect(byLabel('Find in the catalogue: TT-VIEW-STD-MTP9943')).not.toBeNull()
    await click(byLabel('Find in the catalogue: TT-VIEW-STD-MTP9943'))
    expect(found).toEqual(['TT-VIEW-STD-MTP9943'])
    expect(host.querySelector('[role="dialog"]')).toBeNull() // the sheet is out of the way of the catalogue
  })

  it('without a catalogue to send it to (no callback) there is only the copy button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`Take **${SKU}**`, { status: 200 })))
    await mount()
    await click(byLabel('AI assistant'))
    await typeInto(host.querySelector('input'), 'cheap followers')
    await click(byLabel('Send'))
    await flush(10)
    expect(byLabel(`Copy article number: ${SKU}`)).not.toBeNull()
    expect(byLabel(`Find in the catalogue: ${SKU}`)).toBeNull()
  })

  it('keeps the conversation: the next question goes with the earlier ones', async () => {
    const answers = ['First answer.', 'Second answer.']
    const calls: { messages: { role: string; content: string }[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return new Response(answers[calls.length - 1], { status: 200 })
    }))
    await mount()
    await click(byLabel('AI assistant'))
    await typeInto(host.querySelector('input'), 'cheap tiktok views')
    await click(byLabel('Send'))
    await flush(10)
    await typeInto(host.querySelector('input'), 'and with a refill?')
    await click(byLabel('Send'))
    await flush(10)
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'cheap tiktok views' }, { role: 'assistant', content: 'First answer.' }, { role: 'user', content: 'and with a refill?' },
    ])
    expect(host.textContent).toContain('Second answer.')
    // closing and opening the sheet does not lose it
    await click(byLabel('Close'))
    await click(byLabel('AI assistant'))
    expect(host.textContent).toContain('Second answer.')
  })

  it('says why an answer did not come, and tries again with the same question', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempt++
      if (attempt === 1) throw new TypeError('Failed to fetch')
      if (attempt === 2) return new Response('{}', { status: 429 })
      return new Response(`Here: **${SKU}**`, { status: 200 })
    }))
    await mount()
    await click(byLabel('AI assistant'))
    await typeInto(host.querySelector('input'), 'cheap followers')
    await click(byLabel('Send'))
    await flush(10)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('No connection. Check the network and try again.')
    await click(buttonWith('Try again'))
    await flush(10)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Too many questions. Try again in a few minutes.')
    expect(buttonWith('Try again')).toBeUndefined() // waiting is the only thing left to do
    await typeInto(host.querySelector('input'), 'cheap followers please')
    await click(byLabel('Send'))
    await flush(10)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(byLabel(`Copy article number: ${SKU}`)).not.toBeNull()
  })

  it('a new chat clears the conversation and brings the first questions back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('An answer.', { status: 200 })))
    await mount()
    await click(byLabel('AI assistant'))
    expect(byLabel('New chat')).toBeNull() // nothing to start over yet
    await click(buttonWith('TikTok views'))
    await flush(10)
    expect(host.textContent).toContain('An answer.')
    await click(byLabel('New chat'))
    expect(host.textContent).not.toContain('An answer.')
    expect(host.textContent).toContain('Cheapest Instagram followers')
  })

  it('in the dev mock nothing is asked of a server', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    await mount(session({ isMock: true }))
    await click(byLabel('AI assistant'))
    await click(buttonWith('TikTok views'))
    await flush(10)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(byLabel(`Copy article number: ${SKU}`)).not.toBeNull()
  })

  it('does not send an empty question, and does not ask twice while an answer is being written', async () => {
    const s = server()
    vi.stubGlobal('fetch', s.fetchStub)
    await mount()
    await click(byLabel('AI assistant'))
    expect((byLabel('Send') as HTMLButtonElement).disabled).toBe(true)
    await typeInto(host.querySelector('input'), 'cheap followers')
    await click(byLabel('Send'))
    await typeInto(host.querySelector('input'), 'another one')
    expect((byLabel('Send') as HTMLButtonElement).disabled).toBe(true) // the first answer is still coming
    expect(s.calls).toHaveLength(1)
    await s.write('Done.')
    await s.end()
  })
})
