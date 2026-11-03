// The browser's side of the AI assistant (src/lib/ai-chat.ts): what is sent, how the streamed answer is read, how an answer is cut so that every article
// number can be copied.
import { describe, expect, it } from 'vitest'
import { askAssistant, ChatError, MAX_MESSAGE_CHARS, MAX_MESSAGES, requestMessages, splitAnswer, type ChatMessage } from '../src/lib/ai-chat'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const bot = (content: string): ChatMessage => ({ role: 'assistant', content })

describe('what is sent', () => {
  it('keeps the last 12 messages, none empty, each within the server\'s limit, and starts with the customer\'s', () => {
    const history = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : bot(`a${i}`)))
    const sent = requestMessages(history)
    expect(sent.length).toBeLessThanOrEqual(MAX_MESSAGES)
    expect(sent[0]!.role).toBe('user')
    expect(sent.at(-1)).toEqual(bot('a29'))
    expect(requestMessages([user('  '), user('hi')])).toEqual([user('hi')])
  })

  it('cuts an answer that is longer than a message may be (the server refuses a long one, also from the assistant)', () => {
    const sent = requestMessages([user('hi'), bot('x'.repeat(MAX_MESSAGE_CHARS + 500)), user('and?')])
    expect(sent.map((m) => m.content.length)).toEqual([2, MAX_MESSAGE_CHARS, 4])
  })

  it('does not start with the assistant\'s words', () => {
    expect(requestMessages([bot('welcome'), user('hi')])).toEqual([user('hi')])
  })
})

describe('an answer cut into pieces', () => {
  const SKU = 'IG-FOL-STD-ROOT89336'

  it('a bold article is a chip, the text around it stays text', () => {
    expect(splitAnswer(`Take **${SKU}** — $0.98 per 1000.`)).toEqual([
      { kind: 'text', text: 'Take ' },
      { kind: 'sku', text: SKU },
      { kind: 'text', text: ' — $0.98 per 1000.' },
    ])
  })

  it('an article that is not in bold, in brackets or in lower case is a chip too, and is copied in capitals', () => {
    const pieces = splitAnswer(`[${SKU}] and ${SKU.toLowerCase()}, also IG-FOL-HQ-SEC4689-0AB4`)
    expect(pieces.filter((p) => p.kind === 'sku').map((p) => p.text)).toEqual([SKU, SKU, 'IG-FOL-HQ-SEC4689-0AB4'])
  })

  it('bold that is not an article is bold; a "**" not closed yet (the answer is being written) is not shown', () => {
    expect(splitAnswer('This is **cheap** and **fa')).toEqual([
      { kind: 'text', text: 'This is ' },
      { kind: 'bold', text: 'cheap' },
      { kind: 'text', text: ' and fa' },
    ])
  })

  it('a line that starts with "* " or "- " is a bullet; a hyphen inside a line is left alone', () => {
    const text = splitAnswer(`* first\n- second\n**${SKU}** - cheap`).map((p) => p.text).join('')
    expect(text).toBe(`• first\n• second\n${SKU} - cheap`)
  })

  it('nothing but text stays one piece; an empty answer has none', () => {
    expect(splitAnswer('Hello!')).toEqual([{ kind: 'text', text: 'Hello!' }])
    expect(splitAnswer('')).toEqual([])
  })
})

describe('asking', () => {
  const enc = new TextEncoder()
  const streamOf = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p))
        c.close()
      },
    })
  /** The parts arrive, then the connection breaks (an error replaces what is still waiting in the queue, so it is raised on the next read). */
  const brokenAfter = (parts: string[]) => {
    let i = 0
    return new ReadableStream<Uint8Array>({ pull(c) { if (i < parts.length) c.enqueue(enc.encode(parts[i++]!)); else c.error(new Error('broken')) } })
  }
  const fetching = (res: Response | Error, seen: { url?: string; init?: RequestInit } = {}) =>
    (async (url: string, init: RequestInit) => {
      seen.url = url
      seen.init = init
      if (res instanceof Error) throw res
      return res
    }) as unknown as typeof fetch

  it('posts the conversation to /api/chat and hands over the answer as it is written', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const progress: string[] = []
    const answer = await askAssistant([user('cheap followers')], (t) => progress.push(t), undefined, fetching(new Response(streamOf(['Take ', `**IG-FOL-STD-ROOT1**`, ' now'])), seen))
    expect(answer).toBe('Take **IG-FOL-STD-ROOT1** now')
    expect(progress.at(-1)).toBe(answer)
    expect(progress[0]).toBe('Take ')
    expect(seen.url).toBe('/api/chat')
    expect(seen.init?.method).toBe('POST')
    expect(JSON.parse(String(seen.init?.body))).toEqual({ messages: [user('cheap followers')] })
  })

  it('reads text that arrives split in the middle of a character', async () => {
    const bytes = enc.encode('Привет')
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 3)); c.enqueue(bytes.slice(3)); c.close() } })
    expect(await askAssistant([user('hi')], () => {}, undefined, fetching(new Response(body)))).toBe('Привет')
  })

  it('says why it failed: too many questions, a busy assistant, no connection', async () => {
    const kind = async (res: Response | Error) => (await askAssistant([user('hi')], () => {}, undefined, fetching(res)).catch((e: unknown) => e) as ChatError).kind
    expect(await kind(new Response('{}', { status: 429 }))).toBe('rate_limited')
    expect(await kind(new Response('{}', { status: 503 }))).toBe('busy')
    expect(await kind(new Response(null, { status: 200 }))).toBe('busy')
    expect(await kind(new Response(streamOf(['  ']), { status: 200 }))).toBe('busy') // nothing was written
    expect(await kind(new Error('Failed to fetch'))).toBe('offline')
  })

  it('a connection that breaks in the middle of an answer keeps what was written; one that breaks at the start is "no connection"', async () => {
    expect(await askAssistant([user('hi')], () => {}, undefined, fetching(new Response(brokenAfter(['Half an ']))))).toBe('Half an ')
    const none = await askAssistant([user('hi')], () => {}, undefined, fetching(new Response(brokenAfter([])))).catch((e: unknown) => e)
    expect((none as ChatError).kind).toBe('offline')
  })

  it('the customer leaving is not an error to show: the abort goes through as it is', async () => {
    const controller = new AbortController()
    controller.abort()
    const aborted = new DOMException('aborted', 'AbortError')
    await expect(askAssistant([user('hi')], () => {}, controller.signal, fetching(aborted))).rejects.toBe(aborted)
  })
})
