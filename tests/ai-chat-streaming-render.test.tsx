// @vitest-environment jsdom
// An answer that is written token by token: what the customer sees at every moment of it. The article numbers come in backticks and become chips;
// while the answer is half-written there must be no half chip, no stray backtick or asterisk, and nothing that the finished answer will not have.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiChat } from '../src/components/chat/AiChat'
import { splitAnswer } from '../src/lib/ai-chat'
import type { AuthSession } from '../src/services/api/auth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = 'IG-FOL-HQ-3F9A1C'
const B = 'TG-MEM-STD-77B2D4'
const ANSWERS = [
  `Для вашей задачи подойдут два варианта:\n\n* **Название услуги:** Подписчики Instagram HQ\n* **Описание:** Refill 30 дней, цена $1.2 за 1000\n* **Артикул:** \`${A}\`\n\n* **Название услуги:** Участники Telegram\n* **Артикул:** \`${B}\`\n\nКакой объём вам нужен?`,
  `Возьмите **${A}** — $0.98 за 1000, или \`${B}\`.`,
  `Артикул \`${A}\``, // the answer ends with the article
  `**\`${A}\`**`,
]

const prefixes = (s: string) => Array.from({ length: s.length + 1 }, (_, n) => s.slice(0, n))

describe('every prefix of an answer, as the customer sees it while it is written', () => {
  it.each(ANSWERS.map((a, i) => [i, a] as const))('answer %i: no markup, no half article, no chip the finished answer does not have', (_i, answer) => {
    const finalChips = splitAnswer(answer).filter((p) => p.kind === 'sku').map((p) => p.text)
    expect(finalChips.length).toBeGreaterThan(0)
    let before = 0
    for (const prefix of prefixes(answer)) {
      const pieces = splitAnswer(prefix, { streaming: true })
      const shown = pieces.map((p) => p.text).join('')
      expect(shown, JSON.stringify(prefix)).not.toMatch(/[`]|\*\*/)
      const chips = pieces.filter((p) => p.kind === 'sku').map((p) => p.text)
      for (const chip of chips) expect(finalChips, `${chip} in ${JSON.stringify(prefix)}`).toContain(chip) // never a part of an article
      expect(chips.length).toBeGreaterThanOrEqual(before) // a chip never goes away again
      before = chips.length
      // an article that nothing follows yet is text, not a chip
      if (/[A-Za-z0-9-]$/.test(prefix) && chips.length > 0) expect(prefix.toUpperCase().endsWith(chips[chips.length - 1]!)).toBe(false)
    }
  })

  it('the finished answer (no streaming) has every chip, also an article at its very end', () => {
    expect(splitAnswer(`Артикул ${A}`).filter((p) => p.kind === 'sku').map((p) => p.text)).toEqual([A])
    expect(splitAnswer(`Артикул ${A}`, { streaming: true }).filter((p) => p.kind === 'sku')).toEqual([]) // still being written: it may grow
    expect(splitAnswer(`Артикул ${A}.`, { streaming: true }).filter((p) => p.kind === 'sku').map((p) => p.text)).toEqual([A]) // a character after it
    expect(splitAnswer(`Артикул \`${A}\``, { streaming: true }).filter((p) => p.kind === 'sku').map((p) => p.text)).toEqual([A]) // the closing backtick
  })

  it('an unclosed backtick or bold does not show, and the text so far stays', () => {
    expect(splitAnswer('Возьмите `IG-FOL', { streaming: true })).toEqual([{ kind: 'text', text: 'Возьмите IG-FOL' }])
    expect(splitAnswer('Возьмите **IG-FOL-HQ', { streaming: true }).map((p) => p.text).join('')).toBe('Возьмите IG-FOL-HQ')
  })
})

describe('the sheet, with an answer that arrives in pieces', () => {
  let host: HTMLElement
  let root: Root
  const session = { token: 't', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'ru', isAdmin: false } } as AuthSession
  const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); vi.unstubAllGlobals() })

  it('shows the text as it comes, a chip only for a finished article, and no backtick at any moment', async () => {
    let push!: (s: string) => void
    let close!: () => void
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(enc.encode(s)); close = () => c.close() } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
    await act(async () => { root.render(createElement(AiChat, { session })) })
    await act(async () => { (host.querySelector('[aria-label="AI assistant"]') as HTMLElement).click() })
    const input = host.querySelector('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'нужны подписчики'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { (host.querySelector('[aria-label="Send"]') as HTMLElement).click() })

    const chips = () => host.querySelectorAll('[aria-label^="Copy article number"]').length
    const bubble = () => host.textContent ?? ''
    for (const piece of ['Возьмите `IG-FOL-', 'HQ-3F9', 'A1C', '` — это ', 'хороший вариант.']) {
      await act(async () => { push(piece) })
      await flush(5)
      expect(bubble()).not.toContain('`')
      if (piece === 'Возьмите `IG-FOL-' || piece === 'HQ-3F9' || piece === 'A1C') expect(chips()).toBe(0)
    }
    expect(bubble()).toContain('Возьмите')
    expect(chips()).toBe(1)
    expect(host.querySelector('[aria-label^="Copy article number"]')!.getAttribute('aria-label')).toContain(A)
    await act(async () => { close() })
    await flush(10)
    expect(chips()).toBe(1)
  })
})
