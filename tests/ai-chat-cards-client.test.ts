// The browser side of the cards: how the framed (ndjson) answer is read, and which cards are believed.
import { describe, expect, it } from 'vitest'
import { askAssistant, ChatError, parseCard, type ChatCard } from '../src/lib/ai-chat'

const enc = new TextEncoder()
const card = (sku: string, over: Partial<ChatCard> = {}): ChatCard => ({
  sku, name: 'Instagram Followers [Refill: 30 Days]', price: 0.9828, category: 'Instagram Followers', platform: 'instagram', min: 50, max: 200_000,
  refill: true, refillDays: 30, dripfeed: false, role: 'main', ...over,
})
const text = (d: string) => JSON.stringify({ t: 'text', d })
const cardLine = (c: unknown) => JSON.stringify({ t: 'card', c })
const end = JSON.stringify({ t: 'end' })
const ndjson = (parts: string[]) => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close() } }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } })
const asking = (res: Response | Error, seen: { init?: RequestInit } = {}) => (async (_url: unknown, init?: RequestInit) => { seen.init = init; if (res instanceof Error) throw res; return res }) as unknown as typeof fetch
const user = (content: string) => ({ role: 'user' as const, content })

describe('which cards are believed', () => {
  it('a card with the shape the screen expects', () => {
    const c = card('IG-FOL-STD-ROOT1')
    expect(parseCard(c)).toEqual(c)
    expect(parseCard({ ...c, lifetime: true, refillDays: undefined })).toMatchObject({ lifetime: true })
  })
  it.each([
    ['not an object', 'IG-FOL-STD-ROOT1'], ['null', null], ['no article', { ...card('X'), sku: '' }], ['a price that is text', { ...card('X'), price: '0.9' }],
    ['a negative price', { ...card('X'), price: -1 }], ['a price that is not finite', { ...card('X'), price: Infinity }], ['a flag that is text', { ...card('X'), refill: 'yes' }],
    ['an unknown role', { ...card('X'), role: 'boss' }], ['no limits', { ...card('X'), min: undefined }], ['a name that is a number', { ...card('X'), name: 7 }],
  ])('%s is not a card', (_why, raw) => {
    expect(parseCard(raw)).toBeNull()
  })
  it('keeps only the fields it knows: a server that adds some does not put them on the screen', () => {
    expect(Object.keys(parseCard({ ...card('IG-FOL-STD-ROOT1'), html: '<b>x</b>' })!)).not.toContain('html')
  })
})

describe('reading a framed answer', () => {
  it('asks for ndjson; the text grows as it is written, the cards arrive after it, and the result is the text', async () => {
    const seen: { init?: RequestInit } = {}
    const progress: string[] = []
    const lists: ChatCard[][] = []
    const res = ndjson([`${text('Take ')}\n`, `${text('**IG-FOL-STD-ROOT1**')}\n`, `${cardLine(card('IG-FOL-STD-ROOT1'))}\n${cardLine(card('IG-VIEW-STD-ROOT2', { role: 'addon', refill: false }))}\n${end}\n`])
    const answer = await askAssistant([user('followers')], (t) => progress.push(t), undefined, asking(res, seen), { onCards: (c) => lists.push(c) })
    expect(answer).toBe('Take **IG-FOL-STD-ROOT1**')
    expect(progress).toEqual(['Take ', 'Take **IG-FOL-STD-ROOT1**'])
    expect(lists.map((l) => l.map((c) => c.sku))).toEqual([['IG-FOL-STD-ROOT1'], ['IG-FOL-STD-ROOT1', 'IG-VIEW-STD-ROOT2']])
    expect((seen.init?.headers as Record<string, string>).Accept).toBe('application/x-ndjson')
  })
  it('a line cut between two chunks, even in the middle of a letter, is put together', async () => {
    const whole = enc.encode(`${text('Привет')}\n${cardLine(card('IG-FOL-STD-ROOT1'))}\n${end}\n`)
    const res = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(whole.slice(0, 14)); c.enqueue(whole.slice(14, 21)); c.enqueue(whole.slice(21)); c.close() } }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    const lists: ChatCard[][] = []
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(res), { onCards: (c) => lists.push(c) })).toBe('Привет')
    expect(lists).toHaveLength(1)
  })
  it('a last line without a line break at the end of the stream is still read', async () => {
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(ndjson([`${text('Hello')}\n${end}`])))).toBe('Hello')
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(ndjson([text('Hello')])))).toBe('Hello')
  })
  it('lines that are not JSON, events nobody knows and cards of the wrong shape are skipped, not shown', async () => {
    const lists: ChatCard[][] = []
    const res = ndjson([`oops\n${text('Fine.')}\n{"t":"surprise"}\n${cardLine({ sku: 'X' })}\n${cardLine(card('IG-FOL-STD-ROOT1'))}\n\n${end}\n`])
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(res), { onCards: (c) => lists.push(c) })).toBe('Fine.')
    expect(lists.at(-1)!.map((c) => c.sku)).toEqual(['IG-FOL-STD-ROOT1'])
  })
  it('each article once and at most five cards, however many the server sends', async () => {
    const lists: ChatCard[][] = []
    const many = ['A', 'B', 'B', 'C', 'D', 'E', 'F', 'G'].map((x) => `${cardLine(card(`IG-FOL-STD-ROOT${x}`))}\n`)
    await askAssistant([user('hi')], () => {}, undefined, asking(ndjson([`${text('x')}\n`, ...many])), { onCards: (c) => lists.push(c) })
    expect(lists.at(-1)!.map((c) => c.sku)).toEqual(['IG-FOL-STD-ROOTA', 'IG-FOL-STD-ROOTB', 'IG-FOL-STD-ROOTC', 'IG-FOL-STD-ROOTD', 'IG-FOL-STD-ROOTE'])
  })
  it('an answer of only cards is an answer; one with neither text nor a card is "busy"', async () => {
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(ndjson([`${cardLine(card('IG-FOL-STD-ROOT1'))}\n${end}\n`])))).toBe('')
    const empty = await askAssistant([user('hi')], () => {}, undefined, asking(ndjson([`${end}\n`]))).catch((e: unknown) => e) as ChatError
    expect(empty).toBeInstanceOf(ChatError)
    expect(empty.kind).toBe('busy')
  })
  it('a connection that breaks after the text shows the text; one that breaks before anything is "offline"', async () => {
    const broken = (parts: string[]) => new Response(new ReadableStream<Uint8Array>({
      start(c) { for (const p of parts) c.enqueue(enc.encode(p)) },
      pull() { throw new Error('connection lost') },
    }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(broken([`${text('Half an ')}\n`])))).toBe('Half an ')
    const none = await askAssistant([user('hi')], () => {}, undefined, asking(broken([]))).catch((e: unknown) => e) as ChatError
    expect(none.kind).toBe('offline')
  })
  it('a server that answers with plain text is read as before, whatever was asked', async () => {
    const lists: ChatCard[][] = []
    const plain = new Response('Take **IG-FOL-STD-ROOT1** now', { status: 200 })
    expect(await askAssistant([user('hi')], () => {}, undefined, asking(plain), { onCards: (c) => lists.push(c) })).toBe('Take **IG-FOL-STD-ROOT1** now')
    expect(lists).toEqual([])
  })
})
