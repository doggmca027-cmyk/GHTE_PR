// @vitest-environment jsdom
// The long lists of the catalogue keep only the cards near the screen in the page (react-virtuoso): after several "Show more" a phone's WebView is not
// carrying hundreds of cards. Here the REAL library is used, given a screen of a size by its own test context (jsdom has no layout).
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// the setup file has loaded the list with the plain stand-in of the library: load both again, the real ones
let VirtuosoMockContext: typeof import('react-virtuoso').VirtuosoMockContext
let VirtualCards: typeof import('../src/components/services/VirtualCards').VirtualCards
let chunk: typeof import('../src/components/services/VirtualCards').chunk
let BUFFER_PX: typeof import('../src/components/services/VirtualCards').BUFFER_PX
let CARD_HEIGHT_PX: number

vi.unmock('react-virtuoso')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Card ${i}` }))

beforeAll(async () => {
  vi.resetModules()
  ;({ VirtuosoMockContext } = await import('react-virtuoso'))
  ;({ VirtualCards, chunk, BUFFER_PX, CARD_HEIGHT_PX } = await import('../src/components/services/VirtualCards'))
})

describe('rows', () => {
  it('cards are cut into rows of the number of columns; the last row may be short', () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(chunk([1, 2, 3], 1)).toEqual([[1], [2], [3]])
    expect(chunk([], 3)).toEqual([])
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]) // never an endless loop
  })
  it('the buffer is a few cards above the screen and more below it, and not the whole page', () => {
    expect(BUFFER_PX.top).toBeGreaterThan(0)
    expect(BUFFER_PX.bottom).toBeGreaterThan(BUFFER_PX.top)
    expect(BUFFER_PX.bottom).toBeLessThanOrEqual(CARD_HEIGHT_PX * 8)
  })
})

describe('the virtual list', () => {
  let host: HTMLElement
  let root: Root
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver

  beforeEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    vi.unstubAllGlobals()
  })

  const render = async (node: ReactNode, mock = { viewportHeight: 600, itemHeight: CARD_HEIGHT_PX }) => {
    await act(async () => {
      root.render(createElement(VirtuosoMockContext.Provider, { value: mock }, createElement('main', { 'data-scroll-root': '' }, node)))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  }
  const list = (n: number, extra: Partial<Parameters<typeof VirtualCards<{ id: string; name: string }>>[0]> = {}) =>
    createElement(VirtualCards<{ id: string; name: string }>, {
      items: items(n), itemKey: (s) => s.id, renderItem: (s) => createElement('article', { 'data-testid': 'card' }, s.name), ...extra,
    })
  const cards = () => [...host.querySelectorAll('[data-testid="card"]')].map((c) => c.textContent)

  it('draws a screenful and a buffer of 300 cards, not 300 cards', async () => {
    await render(list(300))
    const drawn = cards()
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(40)
    expect(drawn[0]).toBe('Card 0')
    expect(drawn).not.toContain('Card 299')
  })

  it('the end of the list (the "Show more" button) is there after the cards', async () => {
    await render(list(300, { footer: createElement('button', { type: 'button' }, 'Show more') }))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show more')
    expect(button).toBeTruthy()
    const last = host.querySelectorAll('[data-testid="card"]')
    expect(button!.compareDocumentPosition(last[last.length - 1]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy() // the button follows the cards
  })

  it('no footer: nothing after the cards', async () => {
    await render(list(5))
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  it('a short list is drawn whole', async () => {
    await render(list(3), { viewportHeight: 900, itemHeight: CARD_HEIGHT_PX })
    expect(cards()).toEqual(['Card 0', 'Card 1', 'Card 2'])
  })

  it('on the website cards stand side by side: a row holds as many as the page has columns', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1280') || q.includes('768'), addEventListener() {}, removeEventListener() {} }))
    await render(list(30, { wide: true }))
    const first = host.querySelector('[data-testid="card"]')!.parentElement!
    expect(first.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    expect(first.querySelectorAll('[data-testid="card"]')).toHaveLength(3)
  })
  it('...two on a tablet, one on a phone and one in the Mini App whatever the width', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('768'), addEventListener() {}, removeEventListener() {} }))
    await render(list(30, { wide: true }))
    expect(host.querySelector('[data-testid="card"]')!.parentElement!.querySelectorAll('[data-testid="card"]')).toHaveLength(2)
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    await render(list(30, { wide: false }))
    expect(host.querySelector('[data-testid="card"]')!.parentElement!.style.gridTemplateColumns).toBe('')
  })

  it('a browser without ResizeObserver gets the whole list, as before', async () => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined
    await render(list(300, { footer: createElement('button', { type: 'button' }, 'Show more') }))
    expect(cards()).toHaveLength(300)
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Show more')).toBe(true)
  })

  it('a page without a scrolling frame (the website) scrolls with the window', async () => {
    await act(async () => {
      root.render(createElement(VirtuosoMockContext.Provider, { value: { viewportHeight: 600, itemHeight: CARD_HEIGHT_PX } }, list(300)))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(cards().length).toBeGreaterThan(0)
    expect(cards().length).toBeLessThan(40)
  })
})
