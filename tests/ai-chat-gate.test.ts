// The assistant's hourly limit and its log (brief of 2026-11-04). Three layers, each tested on its own and then together:
//   * the chat-gate Edge Function's helpers (supabase/functions/_shared/chat-gate.ts): who is asking, what may be stored
//   * the Vercel side (api/_lib/chat-gate.ts, chat-hold.ts): the calls to the gate, which never throw and never hold the customer up
//   * handleChat: the limit is asked while the catalogue is searched, a refused question gets a 429, the log is written once, after the answer
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { signJwt } from '../supabase/functions/_shared/jwt.ts'
import {
  DEFAULT_HOURLY_LIMIT, MIN_SECRET_LENGTH, PROMPT_MAX, cleanIntent, cleanLogEntry, cleanText, gateAuthorized, hmacHex, hourlyLimit, identify, parseGateRequest,
} from '../supabase/functions/_shared/chat-gate.ts'
import { CHECK_TIMEOUT_MS, createGate, parseVerdict, type ChatGate, type GateVerdict, type LogEntry, type Who } from '../api/_lib/chat-gate'
import { HOLD_MAX_MS, holdOpen } from '../api/_lib/chat-hold'
import { DEFAULT_MODEL, FALLBACK_MODELS, createRateLimiter, handleChat, type ChatDeps } from '../api/_lib/chat-handler'
import type { Recommendation, StorefrontService } from '../api/_lib/chat-rag'

const SECRET = 'g'.repeat(40) // secret-scan:allow (test-only value)
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef' // secret-scan:allow (test-only value)
const USER_ID = '3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12'

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The helpers of the Edge Function
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('the shared secret', () => {
  const headers = (value: string | null) => ({ get: (name: string) => (name === 'x-chat-gate-secret' ? value : null) })
  it('lets the caller in when it sends the secret, and nobody else', () => {
    expect(gateAuthorized(headers(SECRET), SECRET)).toBe(true)
    expect(gateAuthorized(headers(SECRET.slice(0, -1) + 'x'), SECRET)).toBe(false)
    expect(gateAuthorized(headers(`${SECRET} `), SECRET)).toBe(false)
    expect(gateAuthorized(headers(''), SECRET)).toBe(false)
    expect(gateAuthorized(headers(null), SECRET)).toBe(false)
  })
  it('a secret that is not set, or too short to be one, matches nothing, not even itself', () => {
    expect(gateAuthorized(headers(''), '')).toBe(false)
    expect(gateAuthorized(headers(undefined as unknown as string), undefined)).toBe(false)
    const short = 's'.repeat(MIN_SECRET_LENGTH - 1)
    expect(gateAuthorized(headers(short), short)).toBe(false)
    const enough = 's'.repeat(MIN_SECRET_LENGTH)
    expect(gateAuthorized(headers(enough), enough)).toBe(true)
  })
})

describe('questions an hour', () => {
  it('is 20 unless the setting is a whole number from 1 to 1000', () => {
    expect(DEFAULT_HOURLY_LIMIT).toBe(20)
    expect(hourlyLimit(undefined)).toBe(20)
    expect(hourlyLimit(null)).toBe(20)
    expect(hourlyLimit('15')).toBe(15)
    expect(hourlyLimit('1')).toBe(1)
    expect(hourlyLimit('1000')).toBe(1000)
    for (const bad of ['', '0', '-3', '1.5', '1001', 'many', ' ', 'NaN']) expect(hourlyLimit(bad), bad).toBe(20)
  })
})

describe('what may be stored of a question', () => {
  it('a prompt is one line of at most 500 characters: control characters and runs of blanks are gone', () => {
    expect(cleanText('  hello\n\n  world\t!\u0000\u0007 ', 500)).toBe('hello world !')
    expect(cleanText('x'.repeat(900), PROMPT_MAX)).toHaveLength(PROMPT_MAX)
    expect(cleanText(42, 500)).toBe('')
    expect(cleanText(null, 500)).toBe('')
  })

  it('the intent keeps its own fields in their own shapes; anything else, however it is sent, is dropped', () => {
    const intent = cleanIntent({
      platform: 'instagram', actions: ['follower', 'member', 'drop table', 7, 'follower'], cheap: true, refill: 'yes', quality: false, geo: 'russia', geoCue: true,
      quantity: 1_000_000.9, audience: 'network', dislikes: false, words: ['followers', 'a b', 'x'.repeat(40), 'привет'], secret: 'leak', __proto__: { polluted: true },
    })
    expect(intent).toEqual({
      platform: 'instagram', actions: ['follower', 'member'], cheap: true, refill: false, quality: false, geo: 'russia', geoCue: true,
      quantity: 1_000_000, audience: 'network', dislikes: false, words: ['followers', 'привет'],
    })
    expect(JSON.stringify(intent)).not.toContain('leak')
  })
  it('an intent that is not an object is an empty one; a quantity outside 1..10^9, an unknown audience and a platform that is not a slug are nothing', () => {
    expect(cleanIntent('x')).toEqual(cleanIntent(null))
    expect(cleanIntent(null)).toMatchObject({ platform: null, actions: [], cheap: false, quantity: null, audience: null, words: [] })
    expect(cleanIntent({ quantity: 0 }).quantity).toBeNull()
    expect(cleanIntent({ quantity: 2e9 }).quantity).toBeNull()
    expect(cleanIntent({ quantity: Infinity }).quantity).toBeNull()
    expect(cleanIntent({ audience: 'boss' }).audience).toBeNull()
    expect(cleanIntent({ platform: 'Insta gram!' }).platform).toBeNull()
  })

  const entry = (over: Record<string, unknown> = {}) => ({
    prompt: 'cheap instagram followers', intent: { platform: 'instagram' }, matched: ['IG-FOL-STD-ROOT1', 'ig-view-std-root2'], recommended: ['IG-FOL-STD-ROOT1'],
    found: 6, toolCalls: 2, model: 'gemini-3.5-flash-lite', ...over,
  })
  it('a line of the log: the prompt cleaned, the articles upper-cased, each once and only if they look like articles, the numbers bounded', () => {
    expect(cleanLogEntry(entry({ matched: ['IG-FOL-STD-ROOT1', 'ig-fol-std-root1', 'not a sku', '', 5, 'A', '<script>'], found: 99_999, toolCalls: -4 }))).toMatchObject({
      prompt: 'cheap instagram followers', matched: ['IG-FOL-STD-ROOT1'], found: 1000, toolCalls: 0, model: 'gemini-3.5-flash-lite',
    })
    expect(cleanLogEntry(entry())?.matched).toEqual(['IG-FOL-STD-ROOT1', 'IG-VIEW-STD-ROOT2'])
    expect(cleanLogEntry(entry({ matched: Array.from({ length: 40 }, (_, i) => `IG-FOL-STD-ROOT${i}`) }))!.matched).toHaveLength(20)
    expect(cleanLogEntry(entry({ recommended: Array.from({ length: 40 }, (_, i) => `IG-FOL-STD-ROOT${i}`) }))!.recommended).toHaveLength(10)
  })
  it('a model name is a model name; anything else is nothing', () => {
    expect(cleanLogEntry(entry({ model: 'gemini-flash-lite-latest' }))!.model).toBe('gemini-flash-lite-latest')
    expect(cleanLogEntry(entry({ model: 'x y; drop table' }))!.model).toBeNull()
    expect(cleanLogEntry(entry({ model: undefined }))!.model).toBeNull()
  })
  it('without a question there is nothing to store', () => {
    for (const bad of [null, 'x', [], 5, entry({ prompt: '' }), entry({ prompt: '   \n ' }), entry({ prompt: 42 }), { intent: {} }]) expect(cleanLogEntry(bad)).toBeNull()
  })
})

describe('a request to the gate', () => {
  const token = 'aaa.bbb.ccc'
  it('check: the address and the token, nothing else', () => {
    expect(parseGateRequest({ action: 'check', ip: '203.0.113.7', token, extra: 'x' })).toEqual({ action: 'check', ip: '203.0.113.7', token })
  })
  it('log: the cleaned line', () => {
    const request = parseGateRequest({ action: 'log', ip: '203.0.113.7', entry: { prompt: ' hi  there ', intent: { platform: 'tiktok' }, matched: [], recommended: [], found: 0, toolCalls: 0, model: null } })
    expect(request).toMatchObject({ action: 'log', ip: '203.0.113.7', token: null, entry: { prompt: 'hi there', intent: { platform: 'tiktok' }, found: 0 } })
  })
  it('the Bearer prefix is taken off the token; a token that cannot be a JWT is no token', () => {
    expect(parseGateRequest({ action: 'check', ip: '1.1.1.1', token: `Bearer ${token}` })).toMatchObject({ token })
    for (const bad of ['', 'Bearer ', 'plain', 'a.b', 'a.b.c.d', 'a b.c.d', 42, null, `${'a'.repeat(2100)}.b.c`]) expect(parseGateRequest({ action: 'check', ip: '1.1.1.1', token: bad }), String(bad).slice(0, 12)).toMatchObject({ token: null })
  })
  it('the address is only what an address is made of; nothing at all is "unknown"', () => {
    expect(parseGateRequest({ action: 'check', ip: '2001:DB8::1' })).toMatchObject({ ip: '2001:db8::1' })
    expect(parseGateRequest({ action: 'check', ip: "1.2.3.4'; drop table" })).toMatchObject({ ip: '1.2.3.4dabe' })
    expect(parseGateRequest({ action: 'check', ip: '' })).toMatchObject({ ip: 'unknown' })
    expect(parseGateRequest({ action: 'check' })).toMatchObject({ ip: 'unknown' })
    expect(parseGateRequest({ action: 'check', ip: 'x'.repeat(200) })!.ip.length).toBeLessThanOrEqual(45)
  })
  it('anything else is not a request', () => {
    for (const bad of [null, 'x', [], 5, {}, { action: 'drop' }, { action: 'log', ip: '1.1.1.1' }, { action: 'log', entry: { prompt: '' } }, { action: ['check'] }]) expect(parseGateRequest(bad)).toBeNull()
  })
})

describe('who is asking', () => {
  const secrets = { jwtSecret: JWT_SECRET, gateSecret: SECRET }
  const tokenFor = (claims: Record<string, unknown>, secret = JWT_SECRET, ttl = 3600, now?: number) =>
    signJwt({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', ...claims }, secret, ttl, now).then((r) => r.token)

  it('a signed-in customer is their Telegram id, read from a token the app signed', async () => {
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({ telegram_id: 777_000_111 }) }, secrets)).toBe('tg:777000111')
  })
  it('a customer who signed up on the website (no Telegram id) is their account', async () => {
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({}) }, secrets)).toBe(`user:${USER_ID}`)
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({ telegram_id: null }) }, secrets)).toBe(`user:${USER_ID}`)
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({ sub: USER_ID.toUpperCase() }) }, secrets)).toBe(`user:${USER_ID}`)
  })
  it('a made-up token is no token: it cannot give the limit or the log somebody else\'s Telegram id', async () => {
    const forged = await tokenFor({ telegram_id: 42 }, 'another-secret-another-secret-12345')
    const expired = await tokenFor({ telegram_id: 42 }, JWT_SECRET, 60, 1_000_000)
    for (const token of [forged, expired, 'a.b.c', null]) expect(await identify({ ip: '203.0.113.7', token }, secrets), String(token).slice(0, 10)).toMatch(/^ip:[0-9a-f]{16}$/)
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({ telegram_id: 42 }) }, { gateSecret: SECRET })).toMatch(/^ip:/) // no JWT secret to check against
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({ telegram_id: -5 }) }, secrets)).toBe(`user:${USER_ID}`) // not a Telegram id
    expect(await identify({ ip: '203.0.113.7', token: await tokenFor({ sub: 'not-a-uuid', telegram_id: 0 }) }, secrets)).toMatch(/^ip:/)
  })
  it('a guest is 64 bits of a keyed hash of the address: the same address is the same guest, and the address is nowhere in it', async () => {
    const a = await identify({ ip: '203.0.113.7', token: null }, secrets)
    expect(a).toMatch(/^ip:[0-9a-f]{16}$/)
    expect(await identify({ ip: '203.0.113.7', token: null }, secrets)).toBe(a)
    expect(await identify({ ip: '203.0.113.8', token: null }, secrets)).not.toBe(a)
    expect(await identify({ ip: '203.0.113.7', token: null }, { ...secrets, gateSecret: `${SECRET}x` })).not.toBe(a) // another key, another hash: not a rainbow table of addresses
    expect(a).not.toContain('203')
    expect(a.slice(3)).toBe((await hmacHex(SECRET, 'ip:203.0.113.7')).slice(0, 16))
  })
  it('HMAC-SHA256 as everybody else computes it', async () => {
    // RFC 4231, test case 2
    expect(await hmacHex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The Vercel side
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('the verdict of the gate', () => {
  it('is read when it has the shape of one', () => {
    expect(parseVerdict({ ok: true, allowed: true, limit: 20, remaining: 19, retry_after: 0 })).toEqual({ allowed: true, limit: 20, remaining: 19, retryAfter: 0 })
    expect(parseVerdict({ allowed: false, limit: 20, remaining: 0, retry_after: 1380.2 })).toEqual({ allowed: false, limit: 20, remaining: 0, retryAfter: 1381 })
  })
  it.each([[null], ['x'], [[]], [{}], [{ allowed: 'yes', limit: 20, remaining: 1, retry_after: 0 }], [{ allowed: true, limit: '20', remaining: 1, retry_after: 0 }],
    [{ allowed: true, limit: 20, remaining: 1 }], [{ allowed: true, limit: 20, remaining: NaN, retry_after: 0 }]])('%j is not one', (raw) => {
    expect(parseVerdict(raw)).toBeNull()
  })
  it('a negative wait is no wait', () => {
    expect(parseVerdict({ allowed: false, limit: 1, remaining: 0, retry_after: -5 })?.retryAfter).toBe(0)
  })
})

describe('the calls to the gate', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const calls: { url: string; init: RequestInit }[] = []
  const gateWith = (answer: () => Response | Promise<Response>, over: { secret?: string; url?: string } = {}) => {
    calls.length = 0
    return createGate({
      supabaseUrl: over.url ?? 'https://x.supabase.co/', anonKey: 'anon', secret: over.secret ?? SECRET,
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return answer() }) as unknown as typeof fetch,
    })!
  }
  const who: Who = { ip: '203.0.113.7', token: 'aaa.bbb.ccc' }
  const entry: LogEntry = { prompt: 'hi', intent: { platform: 'instagram' }, matched: ['IG-FOL-STD-ROOT1'], recommended: [], found: 1, toolCalls: 0, model: 'm' }

  it('there is no gate without the secret or without the project\'s address: the chat then works as it did, with no hourly limit and no log', () => {
    expect(createGate({ supabaseUrl: 'https://x.supabase.co', secret: undefined, fetch })).toBeUndefined()
    expect(createGate({ supabaseUrl: 'https://x.supabase.co', secret: '', fetch })).toBeUndefined()
    expect(createGate({ supabaseUrl: undefined, secret: SECRET, fetch })).toBeUndefined()
  })

  it('check: one POST to the function, with the secret in its header and nothing of the customer but the address and the token', async () => {
    const gate = gateWith(() => ok({ ok: true, allowed: true, limit: 20, remaining: 19, retry_after: 0 }))
    expect(await gate.check(who)).toEqual({ allowed: true, limit: 20, remaining: 19, retryAfter: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://x.supabase.co/functions/v1/chat-gate')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'x-chat-gate-secret': SECRET, apikey: 'anon' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ action: 'check', ip: '203.0.113.7', token: 'aaa.bbb.ccc' })
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })
  it('a guest has no token', async () => {
    const gate = gateWith(() => ok({ allowed: true, limit: 20, remaining: 3, retry_after: 0 }))
    await gate.check({ ip: '203.0.113.7' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ action: 'check', ip: '203.0.113.7', token: null })
  })
  it('check: a refusal is passed on with the wait', async () => {
    const gate = gateWith(() => ok({ ok: true, allowed: false, limit: 20, remaining: 0, retry_after: 1380 }))
    expect(await gate.check(who)).toEqual({ allowed: false, limit: 20, remaining: 0, retryAfter: 1380 })
  })
  it('check never throws: a gate that is down, slow, answers nonsense or an error is "cannot say" (null)', async () => {
    expect(await gateWith(() => ok({ error: 'unavailable' }, 503)).check(who)).toBeNull()
    expect(await gateWith(() => ok({ error: 'unauthorized' }, 401)).check(who)).toBeNull()
    expect(await gateWith(() => ok({ hello: 'world' })).check(who)).toBeNull()
    expect(await gateWith(() => new Response('<html>', { status: 200 })).check(who)).toBeNull()
    expect(await gateWith(() => { throw new Error('network down') }).check(who)).toBeNull()
    expect(await gateWith(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))).check(who)).toBeNull()
  })
  it('the limit is asked for no longer than the catalogue takes', () => {
    expect(CHECK_TIMEOUT_MS).toBeLessThanOrEqual(2_000)
  })

  it('log: one POST with the line; the answer does not matter', async () => {
    const gate = gateWith(() => ok({ ok: true }))
    await gate.log(who, entry)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ action: 'log', ip: '203.0.113.7', token: 'aaa.bbb.ccc', entry })
    expect(calls[0]!.init.headers).toMatchObject({ 'x-chat-gate-secret': SECRET })
  })
  it('log never throws either: a lost line is not an error', async () => {
    await expect(gateWith(() => ok({}, 500)).log(who, entry)).resolves.toBeUndefined()
    await expect(gateWith(() => { throw new Error('network down') }).log(who, entry)).resolves.toBeUndefined()
  })
})

describe('keeping the request alive for the log', () => {
  afterEach(() => { vi.useRealTimers() })

  it('outside Vercel there is nothing to hold: no error, and the release does nothing', () => {
    expect(() => holdOpen(() => undefined)()).not.toThrow()
    expect(() => holdOpen(() => ({}))()).not.toThrow()
    expect(() => holdOpen()()).not.toThrow() // this process is no Vercel request
  })
  it('on Vercel it takes a slot on waitUntil that stays open until the work is done', async () => {
    const tasks: Promise<unknown>[] = []
    const release = holdOpen(() => ({ waitUntil: (task) => { tasks.push(task) } }))
    expect(tasks).toHaveLength(1)
    let settled = false
    void tasks[0]!.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await tasks[0]
    expect(settled).toBe(true)
    expect(() => release()).not.toThrow() // twice is fine
  })
  it('a request is never held for good: the slot lets go after a while by itself', async () => {
    vi.useFakeTimers()
    const tasks: Promise<unknown>[] = []
    holdOpen(() => ({ waitUntil: (task) => { tasks.push(task) } }))
    let settled = false
    void tasks[0]!.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(HOLD_MAX_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true)
  })
  it('reads the context that Vercel keeps for the request being served', async () => {
    const symbol = Symbol.for('@vercel/request-context')
    const tasks: Promise<unknown>[] = []
    ;(globalThis as Record<symbol, unknown>)[symbol] = { get: () => ({ waitUntil: (task: Promise<unknown>) => { tasks.push(task) } }) }
    try {
      holdOpen()()
      expect(tasks).toHaveLength(1)
    } finally {
      delete (globalThis as Record<symbol, unknown>)[symbol]
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The chat with the gate
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('the chat with the limit and the log', () => {
  const env = { apiKey: 'k', supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', models: [DEFAULT_MODEL, ...FALLBACK_MODELS] }
  const service = (id: string, name: string, rate: number, over: Partial<StorefrontService> = {}): StorefrontService => ({
    id, sku: `IG-FOL-STD-ROOT${id.toUpperCase()}`, name, customer_rate_per_1000: rate, min_quantity: 100, max_quantity: 100_000, refill_supported: false,
    category: { name: 'Instagram Followers', platform: { slug: 'instagram', name: 'Instagram' } }, ...over,
  })
  const ask = (text = 'cheap instagram followers', headers: Record<string, string> = {}, signal?: AbortSignal, accept?: string) =>
    new Request('https://app.test/api/chat', {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: text }] }), signal,
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...(accept ? { accept } : {}), ...headers },
    })
  const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close() } })

  interface Harness extends ChatDeps { searches: string[]; generated: { model: string; system: string; recommend?: (call: Recommendation) => void }[]; checks: Who[]; logs: { who: Who; entry: LogEntry }[]; hold: Mock<() => () => void>; release: Mock<() => void> }
  const harness = (parts: {
    check?: (who: Who) => Promise<GateVerdict | null>
    log?: (who: Who, entry: LogEntry) => Promise<void>
    generate?: (seen: { model: string; recommend?: (call: Recommendation) => void }) => Promise<ReadableStream<Uint8Array>>
    catalogue?: () => Response
    gate?: boolean
  } = {}): Harness => {
    const searches: string[] = []
    const generated: Harness['generated'] = []
    const checks: Who[] = []
    const logs: Harness['logs'] = []
    const release = vi.fn<() => void>()
    const hold = vi.fn<() => () => void>(() => release)
    const gate: ChatGate = {
      check: async (who) => { checks.push(who); return parts.check ? parts.check(who) : { allowed: true, limit: 20, remaining: 19, retryAfter: 0 } },
      log: async (who, entry) => { logs.push({ who, entry }); await parts.log?.(who, entry) },
    }
    return {
      env, searches, generated, checks, logs, hold, release,
      fetch: (async (url: string) => {
        searches.push(decodeURIComponent(String(url)))
        if (parts.catalogue) return parts.catalogue()
        const views = decodeURIComponent(String(url)).includes('name.ilike.*view*')
        return new Response(JSON.stringify(views ? [service('v', 'Instagram Video Views', 0.12, { sku: 'IG-VIEW-STD-ROOTV' })] : [service('a', 'Instagram Followers [Refill: 30 Days]', 1.2, { refill_supported: true }), service('b', 'Instagram Followers [no refill]', 0.3)]), { status: 200 })
      }) as unknown as typeof fetch,
      allow: () => true,
      generate: async (args) => { generated.push({ model: args.model, system: args.system, recommend: args.recommend }); return (parts.generate ?? (async () => stream('Take **IG-FOL-STD-ROOTA** and IG-VIEW-STD-ROOTV.')))(generated.at(-1)!) },
      ...(parts.gate === false ? {} : { gate, hold }),
    }
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) }

  beforeEach(() => { vi.useRealTimers() })

  it('the caller is the first address of the forwarded list and, for a signed-in customer, the token of the app', async () => {
    const d = harness()
    await (await handleChat(ask('cheap instagram followers', { authorization: 'Bearer aaa.bbb.ccc' }), d)).text()
    expect(d.checks).toEqual([{ ip: '203.0.113.7', token: 'aaa.bbb.ccc' }])
    await settle()
    expect(d.logs[0]!.who).toEqual({ ip: '203.0.113.7', token: 'aaa.bbb.ccc' })
    const guest = harness()
    await (await handleChat(ask(), guest)).text()
    expect(guest.checks).toEqual([{ ip: '203.0.113.7', token: undefined }])
  })

  it('asks the limit while it searches the catalogue: a question that is let through waits for neither', async () => {
    let answer!: (v: GateVerdict) => void
    const d = harness({ check: () => new Promise((resolve) => { answer = resolve }) })
    const pending = handleChat(ask(), d)
    await settle()
    expect(d.checks).toHaveLength(1)
    expect(d.searches.length).toBeGreaterThan(0) // the catalogue was already being searched while the gate had not answered
    expect(d.generated).toHaveLength(0) // ...and the model waits for the verdict
    answer({ allowed: true, limit: 20, remaining: 19, retryAfter: 0 })
    expect((await pending).status).toBe(200)
    expect(d.generated).toHaveLength(1)
  })

  it('the hourly limit used up: 429, the wait in a header and in the body, the model never asked, nothing logged', async () => {
    const d = harness({ check: async () => ({ allowed: false, limit: 20, remaining: 0, retryAfter: 1380 }) })
    const res = await handleChat(ask(), d)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('1380')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await res.json()).toEqual({ error: 'rate_limited', message: 'Question limit reached. Try again in 23 min.', retry_after: 1380 })
    await settle()
    expect(d.generated).toHaveLength(0)
    expect(d.logs).toHaveLength(0)
    expect(d.hold).not.toHaveBeenCalled()
  })
  it('the wait is told in whole minutes, at least one', async () => {
    for (const [seconds, text] of [[30, 'in 1 min.'], [60, 'in 1 min.'], [61, 'in 2 min.'], [3600, 'in 60 min.']] as const) {
      const res = await handleChat(ask(), harness({ check: async () => ({ allowed: false, limit: 20, remaining: 0, retryAfter: seconds }) }))
      expect((await res.json() as { message: string }).message).toContain(text)
    }
  })
  it('a refused question is answered 429 whatever the catalogue does (it is not read)', async () => {
    const d = harness({ check: async () => ({ allowed: false, limit: 20, remaining: 0, retryAfter: 60 }), catalogue: () => new Response('boom', { status: 500 }) })
    expect((await handleChat(ask(), d)).status).toBe(429)
  })

  it('a gate that cannot say lets the question through: the chat does not depend on it', async () => {
    for (const check of [async () => null, async () => { throw new Error('gate crashed') }]) {
      const d = harness({ check })
      const res = await handleChat(ask(), d)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('IG-FOL-STD-ROOTA')
    }
  })
  it('without a gate (no secret) there is no hourly limit, no log and nothing held', async () => {
    const d = harness({ gate: false })
    expect((await handleChat(ask(), d)).status).toBe(200)
    await settle()
    expect(d.checks).toHaveLength(0)
    expect(d.logs).toHaveLength(0)
  })

  it('the in-memory limit still stands in front of it: a burst never reaches the gate', async () => {
    const allow = createRateLimiter(1)
    const d = { ...harness(), allow }
    expect((await handleChat(ask(), d)).status).toBe(200)
    const second = await handleChat(ask(), d)
    expect(second.status).toBe(429)
    expect((await second.json() as { error: string }).error).toBe('rate_limited')
    expect(second.headers.get('Retry-After')).toBeNull() // no exact wait to give
    expect((d as unknown as Harness).checks).toHaveLength(1)
  })
  it('a malformed question does not use up the hour', async () => {
    const d = harness()
    const res = await handleChat(new Request('https://app.test/api/chat', { method: 'POST', body: 'not json', headers: { 'x-forwarded-for': '203.0.113.7' } }), d)
    expect(res.status).toBe(400)
    expect(d.checks).toHaveLength(0)
  })

  it('the log: written once, after the answer, with what was asked, understood, found and recommended', async () => {
    const d = harness()
    const res = await handleChat(ask('cheap instagram followers from Turkey, 50k'), d)
    expect(d.logs).toHaveLength(0) // the answer has not been read yet
    expect(await res.text()).toContain('IG-FOL-STD-ROOTA')
    await settle()
    expect(d.logs).toHaveLength(1)
    const { entry } = d.logs[0]!
    expect(entry.prompt).toBe('cheap instagram followers from Turkey, 50k')
    expect(entry.intent).toMatchObject({ platform: 'instagram', cheap: true, geo: 'turkey', quantity: 50_000 })
    expect(entry.matched).toEqual(expect.arrayContaining(['IG-FOL-STD-ROOTA', 'IG-FOL-STD-ROOTB', 'IG-VIEW-STD-ROOTV']))
    expect(entry.recommended).toEqual(['IG-FOL-STD-ROOTA', 'IG-VIEW-STD-ROOTV']) // the articles the answer names
    expect(entry.found).toBe(2)
    expect(entry.toolCalls).toBe(0)
    expect(entry.model).toBe(DEFAULT_MODEL)
  })
  it('the recommendations are those of the tool and of the text, the way the cards are', async () => {
    const d = harness({ generate: async ({ recommend }) => { recommend!({ sku: 'IG-FOL-STD-ROOTB' }); recommend!({ sku: 'IG-FOL-STD-MADEUP' }); return stream('Take IG-FOL-STD-ROOTA.') } })
    await (await handleChat(ask('instagram followers', {}, undefined, 'application/x-ndjson'), d)).text()
    await settle()
    expect(d.logs[0]!.entry.recommended).toEqual(['IG-FOL-STD-ROOTB', 'IG-FOL-STD-ROOTA'])
    expect(d.logs[0]!.entry.toolCalls).toBe(2)
  })
  it('a plain-text client is logged too', async () => {
    const d = harness()
    await (await handleChat(ask(), d)).text()
    await settle()
    expect(d.logs).toHaveLength(1)
    expect(d.logs[0]!.entry.recommended).toEqual(['IG-FOL-STD-ROOTA', 'IG-VIEW-STD-ROOTV'])
  })
  it('the log is the last thing the customer asked, not the two messages the search reads', async () => {
    const d = harness()
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'instagram followers' }, { role: 'assistant', content: 'Which?' }, { role: 'user', content: 'cheapest, with refill' }] })
    await (await handleChat(new Request('https://app.test/api/chat', { method: 'POST', body, headers: { 'x-forwarded-for': '1.2.3.4' } }), d)).text()
    await settle()
    expect(d.logs[0]!.entry.prompt).toBe('cheapest, with refill')
    expect(d.logs[0]!.entry.intent).toMatchObject({ platform: 'instagram', refill: true }) // ...while it was understood from both
  })

  it('the log is never waited for: a gate that does not answer does not hold the answer back', async () => {
    const d = harness({ log: () => new Promise(() => {}) })
    const res = await handleChat(ask(), d)
    expect(await res.text()).toContain('IG-FOL-STD-ROOTA') // the whole answer arrived and the stream ended
    await settle()
    expect(d.logs).toHaveLength(1)
    expect(d.release).not.toHaveBeenCalled() // ...and the request is still held for the log, as it should be
  })
  it('the request is held for the log and let go when it is written', async () => {
    let written!: () => void
    const d = harness({ log: () => new Promise<void>((resolve) => { written = resolve }) })
    await (await handleChat(ask(), d)).text()
    await settle()
    expect(d.hold).toHaveBeenCalledTimes(1)
    expect(d.release).not.toHaveBeenCalled()
    written()
    await settle()
    expect(d.release).toHaveBeenCalledTimes(1)
  })
  it('a log that fails lets the request go too', async () => {
    const d = harness({ log: async () => { throw new Error('gate down') } })
    await (await handleChat(ask(), d)).text()
    await settle()
    expect(d.release).toHaveBeenCalledTimes(1)
  })
  it('no model can answer: 503 as before, nothing logged, and the request is not held', async () => {
    const d = harness({ generate: async () => { throw new Error('down') } })
    expect((await handleChat(ask(), d)).status).toBe(503)
    expect(d.logs).toHaveLength(0)
    expect(d.hold).toHaveBeenCalledTimes(1)
    expect(d.release).toHaveBeenCalledTimes(1)
  })
  it('the catalogue is down: 503, nothing logged, nothing held', async () => {
    const d = harness({ catalogue: () => new Response('boom', { status: 500 }) })
    expect((await handleChat(ask(), d)).status).toBe(503)
    expect(d.logs).toHaveLength(0)
    expect(d.hold).not.toHaveBeenCalled()
  })

  it('a customer who leaves in the middle of the answer is logged once, with what was written; the end of the stream afterwards logs nothing more', async () => {
    const controller = new AbortController()
    let push!: (text: string) => void
    let finish!: () => void
    const d = harness({
      generate: async () => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); push = (t) => c.enqueue(e.encode(t)); finish = () => c.close() } }),
    })
    const res = await handleChat(ask('cheap instagram followers', {}, controller.signal), d)
    const reader = res.body!.getReader()
    push('Take **IG-FOL-STD-ROOTA** first')
    await reader.read()
    controller.abort()
    await settle()
    expect(d.logs).toHaveLength(1)
    expect(d.logs[0]!.entry.recommended).toEqual(['IG-FOL-STD-ROOTA'])
    finish()
    await reader.read().catch(() => undefined)
    await settle()
    expect(d.logs).toHaveLength(1)
  })
})
