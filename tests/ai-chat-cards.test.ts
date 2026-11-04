// The interactive cards of the assistant: the model calls a tool for every service it recommends, the chat turns each call into a card made from the
// CATALOGUE (never from the model's words), and a client that did not ask for cards gets the plain text it always did.
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { answerStream } from '../api/_lib/chat-model'
import { DEFAULT_MODEL, FALLBACK_MODELS, handleChat, type ChatDeps } from '../api/_lib/chat-handler'
import { MAX_CARDS, RECOMMEND_TOOL, SKU_IN_TEXT, buildSystemPrompt, cardOf, cardsFor, refillLabel, refillTerm, type Recommendation, type StorefrontService } from '../api/_lib/chat-rag'
import { SKU_PATTERN } from '../src/lib/service-search'

const service = (id: string, name: string, rate: number, over: Partial<StorefrontService> = {}): StorefrontService => ({
  id, sku: `IG-FOL-STD-ROOT${id.toUpperCase()}`, name, customer_rate_per_1000: rate, min_quantity: 100, max_quantity: 100_000, refill_supported: false,
  category: { name: 'Instagram Followers', platform: { slug: 'instagram', name: 'Instagram' } }, ...over,
})

describe('a card is the catalogue\'s own description of a service', () => {
  it('carries the article, the name, the price per 1000, the limits, the guarantee and the drip-feed of the card', () => {
    const s = service('89336', 'Instagram Followers [Refill: 30 Days]', 0.98281, { sku: 'IG-FOL-STD-ROOT89336', refill_supported: true, dripfeed_available: true, min_quantity: 50, max_quantity: 200_000 })
    expect(cardOf(s, 'main')).toEqual({
      sku: 'IG-FOL-STD-ROOT89336', name: 'Instagram Followers [Refill: 30 Days]', price: 0.9828, category: 'Instagram Followers', platform: 'instagram',
      min: 50, max: 200_000, refill: true, refillDays: 30, dripfeed: true, role: 'main',
    })
  })
  it('says "for life" for a lifetime refill, and nothing of days when the name gives none; a service without a guarantee has no refill at all', () => {
    expect(cardOf(service('a', 'Instagram Followers | Lifetime Refill', 1), 'main')).toMatchObject({ refill: true, lifetime: true })
    expect(cardOf(service('b', 'Instagram Followers | Refill', 1), 'main')).not.toHaveProperty('refillDays')
    const plain = cardOf(service('c', 'Instagram Followers [no refill]', 1), 'addon')
    expect(plain).toMatchObject({ refill: false, dripfeed: false, role: 'addon' })
    expect(plain).not.toHaveProperty('refillDays')
    expect(plain).not.toHaveProperty('lifetime')
  })
  it('the line the model reads still says the same about the guarantee', () => {
    expect(refillTerm(service('a', 'Followers R60', 1))).toEqual({ refill: true, days: 60 })
    expect(refillLabel(service('a', 'Followers R60', 1))).toBe('да, 60 дн.')
    expect(refillLabel(service('a', 'Followers | Lifetime Refill', 1))).toBe('да, пожизненная')
    expect(refillLabel(service('a', 'Followers | Non Drop', 1))).toBe('да')
    expect(refillLabel(service('a', 'Followers [no refill]', 1))).toBe('нет')
  })
  it('a panel text cannot put markup or control characters into the name of a card', () => {
    const card = cardOf(service('a', 'Followers\n<b>now</b> `x`', 1), 'main')
    expect(card.name).not.toMatch(/[\n<>`]/)
  })
})

describe('which cards an answer gets', () => {
  const found = [service('a', 'Instagram Followers [Refill: 30 Days]', 1.2, { refill_supported: true }), service('b', 'Instagram Followers [no refill]', 0.3)]
  const addons = [service('v', 'Instagram Video Views', 0.12, { sku: 'IG-VIEW-STD-ROOTV' })]
  const call = (sku: unknown, extra: Partial<Recommendation> = {}): Recommendation => ({ sku: sku as string, ...extra })

  it('only articles of the lists the model was given; name and price are the catalogue\'s, whatever the model wrote', () => {
    const cards = cardsFor([call('IG-FOL-STD-ROOTA', { name: 'Cheapest ever!', price: 0.01 })], found, addons)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ sku: 'IG-FOL-STD-ROOTA', name: 'Instagram Followers [Refill: 30 Days]', price: 1.2, role: 'main' })
  })
  it('an article the model made up, an empty one and something that is not text are dropped', () => {
    expect(cardsFor([call('IG-FOL-STD-FAKE1'), call(''), call(42), call(null), call(undefined)], found, addons)).toEqual([])
  })
  it('the article may be written in lower case, in bold, or with a full stop: it is the same article', () => {
    expect(cardsFor([call('ig-fol-std-roota'), call('**IG-VIEW-STD-ROOTV**.')], found, addons).map((c) => c.sku)).toEqual(['IG-FOL-STD-ROOTA', 'IG-VIEW-STD-ROOTV'])
  })
  it('each article once, in the order the model named them; an addon is marked as one, and a service in both lists is a main one', () => {
    const cards = cardsFor([call('IG-VIEW-STD-ROOTV'), call('IG-FOL-STD-ROOTA'), call('ig-view-std-rootv'), call('IG-FOL-STD-ROOTA')], found, addons)
    expect(cards.map((c) => [c.sku, c.role])).toEqual([['IG-VIEW-STD-ROOTV', 'addon'], ['IG-FOL-STD-ROOTA', 'main']])
    const both = cardsFor([call('IG-FOL-STD-ROOTA')], found, [found[0]!])
    expect(both[0]!.role).toBe('main')
  })
  it('an article the text names is a recommendation too: Gemini Flash-Lite writes "choose below" and often calls nothing', () => {
    const text = 'Take **IG-FOL-STD-ROOTA** for the followers and IG-VIEW-STD-ROOTV for the views.'
    expect(cardsFor([], found, addons, text).map((c) => [c.sku, c.role])).toEqual([['IG-FOL-STD-ROOTA', 'main'], ['IG-VIEW-STD-ROOTV', 'addon']])
  })
  it('what the model asked for with the tool comes first, then the articles of the text, each once; a made-up article in the text is no card', () => {
    const text = 'Besides **IG-FOL-STD-ROOTB**, **IG-VIEW-STD-ROOTV** and the made-up **IG-FOL-STD-FAKE9** take **IG-FOL-STD-ROOTA**.'
    expect(cardsFor([call('IG-FOL-STD-ROOTA')], found, addons, text).map((c) => c.sku)).toEqual(['IG-FOL-STD-ROOTA', 'IG-FOL-STD-ROOTB', 'IG-VIEW-STD-ROOTV'])
  })
  it('the articles of the text are found the way the search box finds them: the two patterns are one', () => {
    expect(SKU_IN_TEXT.source).toBe(SKU_PATTERN.source)
    expect(SKU_IN_TEXT.flags).toBe(`g${SKU_PATTERN.flags}`)
  })
  it(`at most ${MAX_CARDS} cards`, () => {
    const many = Array.from({ length: 9 }, (_, i) => service(`s${i}`, `Followers ${i}`, 1 + i))
    expect(cardsFor(many.map((s) => call(s.sku)), many, [])).toHaveLength(MAX_CARDS)
  })
})

describe('the model call (AI SDK, scripted model)', () => {
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
  const written = (delta: string): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta }, { type: 'text-end', id: 't' }]
  let n = 0
  const recommend = (input: object): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: `c${++n}`, toolName: RECOMMEND_TOOL, input: JSON.stringify(input) })
  const scripted = (...parts: LanguageModelV4StreamPart[]) => new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: 'stream-start', warnings: [] }, ...parts,
        { type: 'finish', finishReason: { unified: parts.some((p) => p.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined }, usage },
      ]),
    }),
  })
  const ask = (model: MockLanguageModelV4, got?: Recommendation[]) => answerStream({
    model, system: 'rules', messages: [{ role: 'user', content: 'followers' }], signal: new AbortController().signal,
    ...(got ? { recommend: (call: Recommendation) => { got.push(call) } } : {}),
  })
  const textOf = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

  it('streams the text and hands every call of the tool over, in order, before the stream ends', async () => {
    const got: Recommendation[] = []
    const model = scripted(...written('Take **A** and **B**.'), recommend({ sku: 'IG-FOL-STD-ROOTA', name: 'A', price: 1.2 }), recommend({ sku: 'IG-VIEW-STD-ROOTV', name: 'V', price: 0.12 }))
    expect(await textOf(await ask(model, got))).toBe('Take **A** and **B**.')
    expect(got).toEqual([{ sku: 'IG-FOL-STD-ROOTA', name: 'A', price: 1.2 }, { sku: 'IG-VIEW-STD-ROOTV', name: 'V', price: 0.12 }])
  })
  it('the model is given the tool only when the caller wants recommendations, and the tool asks for the article, the name and the price', async () => {
    const withTool = scripted(...written('hi'))
    await textOf(await ask(withTool, []))
    const tools = withTool.doStreamCalls[0]!.tools ?? []
    expect(tools.map((t) => t.name)).toEqual([RECOMMEND_TOOL])
    expect(JSON.stringify(tools[0])).toContain('"required":["sku","name","price"]')

    const without = scripted(...written('hi'))
    await textOf(await ask(without))
    expect(without.doStreamCalls[0]!.tools ?? []).toEqual([])
  })
  it('an answer that begins with a recommendation has begun: the model is not given up on for writing the text after it', async () => {
    const got: Recommendation[] = []
    const model = scripted(recommend({ sku: 'IG-FOL-STD-ROOTA', name: 'A', price: 1 }), ...written('And the words.'))
    expect(await textOf(await ask(model, got))).toBe('And the words.')
    expect(got).toHaveLength(1)
  })
  it('an answer of only recommendations is an empty text and the calls', async () => {
    const got: Recommendation[] = []
    expect(await textOf(await ask(scripted(recommend({ sku: 'IG-FOL-STD-ROOTA', name: 'A', price: 1 })), got))).toBe('')
    expect(got).toHaveLength(1)
  })
  it('a call with the wrong kind of arguments still arrives (the chat decides what to believe): only text and numbers are kept', async () => {
    const got: Recommendation[] = []
    await textOf(await ask(scripted(...written('x'), recommend({ sku: 7, name: ['A'], price: '1.2' })), got))
    expect(got).toEqual([{ sku: '' }])
  })
  it('a call of some other tool is not a recommendation', async () => {
    const got: Recommendation[] = []
    const other: LanguageModelV4StreamPart = { type: 'tool-call', toolCallId: 'x', toolName: 'delete_everything', input: '{}' }
    expect(await textOf(await ask(scripted(...written('x'), other), got))).toBe('x')
    expect(got).toEqual([])
  })
  it('a model that fails before its first word rejects, so the next one can be tried; one that says nothing does too', async () => {
    const broken = new MockLanguageModelV4({ doStream: async () => { throw new Error('503 overloaded') } })
    await expect(ask(broken, [])).rejects.toThrow()
    await expect(ask(scripted(), [])).rejects.toThrow('answered nothing')
    const reported = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('model retired') }]) }),
    })
    await expect(ask(reported, [])).rejects.toThrow('model retired')
  })
})

describe('the answer with cards (the request)', () => {
  const env = { apiKey: 'k', supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', models: [DEFAULT_MODEL, ...FALLBACK_MODELS] }
  const ask = (accept?: string) => new Request('https://app.test/api/chat', {
    method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'followers instagram' }] }),
    headers: { 'x-forwarded-for': '1.2.3.4', ...(accept ? { accept } : {}) },
  })
  type Seen = { model: string; system: string; recommend?: (call: Recommendation) => void }
  const deps = (generate: (seen: Seen) => Promise<ReadableStream<Uint8Array>>): ChatDeps & { seen: Seen[] } => {
    const seen: Seen[] = []
    return {
      env, seen,
      fetch: (async (url: string) => {
        const views = decodeURIComponent(String(url)).includes('name.ilike.*view*')
        return new Response(JSON.stringify(views ? [service('v', 'Instagram Video Views', 0.12, { sku: 'IG-VIEW-STD-ROOTV' })] : [service('a', 'Instagram Followers [Refill: 30 Days]', 1.2, { refill_supported: true })]), { status: 200 })
      }) as unknown as typeof fetch,
      allow: () => true,
      generate: async (args) => { seen.push({ model: args.model, system: args.system, recommend: args.recommend }); return generate(seen.at(-1)!) },
    }
  }
  const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close() } })
  const lines = async (res: Response) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { t: string; d?: string; c?: { sku: string } })

  it('asked for ndjson, the answer is lines of JSON: the text, a card for every recommended service, the end', async () => {
    const d = deps(async ({ recommend }) => {
      recommend!({ sku: 'IG-FOL-STD-ROOTA', name: 'invented', price: 0.01 })
      recommend!({ sku: 'ig-view-std-rootv' })
      recommend!({ sku: 'IG-FOL-STD-FAKE' })
      return stream('Take ', '**IG-FOL-STD-ROOTA**.')
    })
    const res = await handleChat(ask('application/x-ndjson'), d)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8')
    expect(res.headers.get('X-Chat-Model')).toBe(DEFAULT_MODEL)
    expect(res.headers.get('X-Chat-Tools')).toBe('on')
    const out = await lines(res)
    expect(out.map((e) => e.t)).toEqual(['text', 'text', 'card', 'card', 'end'])
    expect(out.at(-1)).toMatchObject({ t: 'end', calls: 3 }) // how many times the model called the tool: the owner can see whether it does
    expect(out.filter((e) => e.t === 'text').map((e) => e.d).join('')).toBe('Take **IG-FOL-STD-ROOTA**.')
    expect(out.filter((e) => e.t === 'card').map((e) => e.c)).toEqual([
      expect.objectContaining({ sku: 'IG-FOL-STD-ROOTA', name: 'Instagram Followers [Refill: 30 Days]', price: 1.2, refill: true, refillDays: 30, role: 'main' }),
      expect.objectContaining({ sku: 'IG-VIEW-STD-ROOTV', name: 'Instagram Video Views', price: 0.12, role: 'addon' }),
    ])
  })
  it('the model is given the tool and told to use it (and told not to send the customer to the search)', async () => {
    const d = deps(async () => stream('ok'))
    await handleChat(ask('application/x-ndjson'), d)
    expect(d.seen[0]!.recommend).toBeTypeOf('function')
    expect(d.seen[0]!.system).toContain(`вызови инструмент ${RECOMMEND_TOOL} отдельно для каждого артикула`)
    expect(d.seen[0]!.system).toContain('не проси его копировать артикул или вставлять его в поиск')
    expect(d.seen[0]!.system).not.toContain('Вставьте этот артикул в поиск')
  })
  it('an answer whose text names articles has their cards although the model called nothing', async () => {
    const d = deps(async () => stream('Take **IG-FOL-STD-ROOTA** and IG-VIEW-STD-ROOTV. Choose below!'))
    const out = await lines(await handleChat(ask('application/x-ndjson'), d))
    expect(out.filter((e) => e.t === 'card').map((e) => e.c!.sku)).toEqual(['IG-FOL-STD-ROOTA', 'IG-VIEW-STD-ROOTV'])
    expect(out.at(-1)).toMatchObject({ t: 'end', calls: 0 })
  })
  it('a client that did not ask for ndjson gets the plain text of before: no tool, the old ending of the answer', async () => {
    const d = deps(async () => stream('Здравствуйте!'))
    for (const accept of [undefined, 'text/plain', '*/*']) {
      const res = await handleChat(ask(accept), d)
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
      expect(await res.text()).toBe('Здравствуйте!')
    }
    expect(d.seen.every((s) => s.recommend === undefined)).toBe(true)
    expect(d.seen[0]!.system).toContain('«Вставьте этот артикул в поиск»')
    expect(d.seen[0]!.system).not.toContain(RECOMMEND_TOOL)
  })
  it('a multi-byte letter cut between two chunks is not broken in the text line', async () => {
    const bytes = new TextEncoder().encode('Привет')
    const d = deps(async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 3)); c.enqueue(bytes.slice(3)); c.close() } }))
    const out = await lines(await handleChat(ask('application/x-ndjson'), d))
    expect(out.filter((e) => e.t === 'text').map((e) => e.d).join('')).toBe('Привет')
  })
  it('when no model can answer with the tool, the first is asked once more without it, and the answer is still framed (with no cards)', async () => {
    const d = deps(async ({ recommend }) => { if (recommend) throw new Error('tools are not supported'); return stream('Plain answer.') })
    const res = await handleChat(ask('application/x-ndjson'), d)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Chat-Tools')).toBe('off') // the owner can tell that the tool never worked
    expect(d.seen.map((s) => [s.model, s.recommend !== undefined])).toEqual([[DEFAULT_MODEL, true], [FALLBACK_MODELS[0], true], [DEFAULT_MODEL, false]])
    expect(d.seen[2]!.system).toContain('«Вставьте этот артикул в поиск»') // the last try is the plain assistant
    expect((await lines(res)).map((e) => e.t)).toEqual(['text', 'end'])
  })
  it('when nothing answers at all it is the same "busy" 503 as before; a plain client is not asked a third time', async () => {
    const down = deps(async () => { throw new Error('down') })
    expect((await handleChat(ask('application/x-ndjson'), down)).status).toBe(503)
    expect(down.seen).toHaveLength(3)
    const plain = deps(async () => { throw new Error('down') })
    expect((await handleChat(ask(), plain)).status).toBe(503)
    expect(plain.seen).toHaveLength(2)
  })
  it('the prompt with cards differs from the plain one only in the way the answer ends, and ends with a reminder where a small model still listens', () => {
    const plain = buildSystemPrompt([service('a', 'Followers', 1)])
    const cards = buildSystemPrompt([service('a', 'Followers', 1)], [], undefined, { cards: true })
    const diff = plain.split('\n').filter((l, i) => l !== cards.split('\n')[i])
    expect(diff).toHaveLength(1)
    expect(diff[0]).toMatch(/^10\. /)
    expect(cards.endsWith(`НАПОМИНАНИЕ: после текста ответа вызови инструмент ${RECOMMEND_TOOL} отдельно для каждого артикула, который ты назвал в ответе.`)).toBe(true)
    expect(plain).not.toContain('НАПОМИНАНИЕ')
  })
})
