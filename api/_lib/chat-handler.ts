// The request side of the support chat (api/chat.ts): validation, the limits, retrieval from the public storefront, the system prompt, the model call,
// and the log. The model call and the gate are injected, so this is tested without the AI SDK, a key or a network.

import type { ChatGate, LogEntry, Who } from './chat-gate'
import {
  addonIntent, buildSearchUrl, buildSkuUrl, buildSystemPrompt, cardsFor, companionActions, extractIntent, rankAddons, rankServices, searchKinds, situationNote, skuInMessage, withAlternative,
  type ChatCard, type ChatIntent, type Recommendation, type SearchKind, type StorefrontService,
} from './chat-rag'

export const MAX_BODY_BYTES = 16_384
export const MAX_MESSAGES = 12
export const MAX_MESSAGE_CHARS = 1_000
export const RETRIEVAL_TIMEOUT_MS = 4_000

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatEnv {
  apiKey?: string
  /** The storefront's public API (the same project and anon key the app itself uses). */
  supabaseUrl?: string
  anonKey?: string
  /** The models to try, in order: the next one answers when the one before cannot (overloaded, retired, over its quota). */
  models: string[]
}

export interface ChatDeps {
  env: ChatEnv
  fetch: typeof fetch
  /** True when this caller may ask again (a small limit kept in this instance's memory: it stops a burst, not a determined abuser). */
  allow: (caller: string) => boolean
  /**
   * Starts the model's answer: resolves with the text, as a stream, once it has begun; rejects when the model cannot answer. With `recommend` the model
   * has the recommend tool, and every call of it is passed to `recommend` (before the stream ends).
   */
  generate: (args: { apiKey: string; model: string; system: string; messages: ChatMessage[]; signal: AbortSignal; recommend?: (call: Recommendation) => void }) => Promise<ReadableStream<Uint8Array>>
  /** The hourly limit and the log (Supabase, through the chat-gate function). Absent: no hourly limit and no log. */
  gate?: ChatGate
  /**
   * Keeps the request alive after its response has gone (Vercel's waitUntil) so that the log can still be written: called once, inside the request,
   * it returns the function that lets the request go. Absent: the log is simply started and not waited for.
   */
  hold?: () => () => void
}

/**
 * The model that answers, and the ones that take over. gemini-1.5-flash is shut down, gemini-2.5-flash goes on 2026-12-01 and gemini-2.5-flash-lite
 * is closed to the keys made after it; the 3.5 lite model answered in 1-2 s without spending tokens on thinking (a thinking model would eat the
 * answer's token budget). The "-latest" alias outlives any one model. GEMINI_MODEL, when set, goes first.
 */
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
export const FALLBACK_MODELS = ['gemini-flash-lite-latest']

const json = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

/** 429 from the hourly limit: says how long to wait, in the header (seconds) and in the body, so the screen can tell the customer in their language. */
function tooMany(retryAfter: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60))
  return new Response(JSON.stringify({ error: 'rate_limited', message: `Question limit reached. Try again in ${minutes} min.`, retry_after: retryAfter }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) },
  })
}

/** The token of a signed-in customer, when the app sent one. It is not checked here: the gate verifies it (the signing secret is not in Vercel). */
const bearerOf = (req: Request): string | undefined => /^Bearer\s+(\S{1,2048})$/i.exec(req.headers.get('authorization') ?? '')?.[1]

/** The messages of a request: plain `{role, content}` or the AI SDK's UI messages (`parts`). Null when anything is wrong with them. */
export function parseMessages(body: unknown): ChatMessage[] | null {
  const raw = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null
  const out: ChatMessage[] = []
  for (const m of raw as { role?: unknown; content?: unknown; parts?: unknown }[]) {
    if (m?.role !== 'user' && m?.role !== 'assistant') return null // a client never speaks as the system
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.parts)
        ? (m.parts as { type?: unknown; text?: unknown }[]).map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('')
        : null
    if (text === null) return null
    const content = text.trim()
    if (content === '' || content.length > MAX_MESSAGE_CHARS) return null
    out.push({ role: m.role, content })
  }
  return out[out.length - 1].role === 'user' ? out : null
}

/** What fits the customer's wish, and the addons that complete a package with it (views for followers, likes for views). */
interface Found {
  found: StorefrontService[]
  addons: StorefrontService[]
  /** What the wish was understood as (kept in the log). */
  intent: ChatIntent
  /** What is known about this customer (tone, limits worked out for their quantity, the country): see situationNote. */
  note?: string
}

async function search(deps: ChatDeps, text: string): Promise<Found> {
  const intent = extractIntent(text)
  const get = async (url: string): Promise<StorefrontService[]> => {
    const res = await deps.fetch(url, {
      headers: { apikey: deps.env.anonKey!, Authorization: `Bearer ${deps.env.anonKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`storefront search answered ${res.status}`)
    return (await res.json()) as StorefrontService[]
  }
  const requests = searchKinds(intent)
    .map((kind) => ({ kind, url: buildSearchUrl(deps.env.supabaseUrl!, intent, kind) }))
    .filter((r): r is { kind: SearchKind; url: string } => r.url !== null)
  // the addon of the package: one more request, the cheapest cards of the other action on the same platform
  const addonUrl = companionActions(intent).length > 0 ? buildSearchUrl(deps.env.supabaseUrl!, addonIntent(intent), 'any') : null
  // an article in the message: that exact card, from the whole catalogue (it is not limited to the platform or the words of the message)
  const sku = skuInMessage(text)
  const [lists, addonList, named] = await Promise.all([
    Promise.all(requests.map((r) => get(r.url))),
    addonUrl ? get(addonUrl) : Promise.resolve([] as StorefrontService[]),
    sku ? get(buildSkuUrl(deps.env.supabaseUrl!, sku)).catch(() => [] as StorefrontService[]) : Promise.resolve([] as StorefrontService[]),
  ])
  // a country nobody names: the best MIX / worldwide cards still reach the model, whatever their price ranks them
  const mix = lists[requests.findIndex((r) => r.kind === 'worldwide')] ?? []
  const ranked = lists.length === 0 ? [] : withAlternative(rankServices(lists.flat(), intent), mix, intent)
  const found = [...named, ...ranked.filter((s) => !named.some((n) => n.id === s.id))] // the card that was asked for by its article comes first
  return { found, addons: addonList.length === 0 ? [] : rankAddons(addonList, intent), intent, note: situationNote(intent, found) }
}

export async function handleChat(req: Request, deps: ChatDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, 'method_not_allowed', 'Use POST.')
  const { apiKey, supabaseUrl, anonKey, models } = deps.env
  if (!apiKey || !supabaseUrl || !anonKey) return json(503, 'chat_not_configured', 'The assistant is not available yet.')

  const caller = (req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown').split(',')[0].trim()
  if (!deps.allow(caller)) return json(429, 'rate_limited', 'Too many questions. Try again in a few minutes.')

  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, 'too_large', 'The request is too large.')
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return json(413, 'too_large', 'The request is too large.')
  let messages: ChatMessage[] | null
  try {
    messages = parseMessages(JSON.parse(raw))
  } catch {
    messages = null
  }
  if (!messages) return json(400, 'invalid_input', `Send {"messages": [{"role": "user", "content": "..."}]}: up to ${MAX_MESSAGES} messages of up to ${MAX_MESSAGE_CHARS} characters, the last one from the user.`)

  // The hourly limit is asked at the same time as the catalogue is searched, so a question that is let through loses no time to it. The gate never
  // rejects: when it cannot say (it is down, slow, or not set up) the question goes on. A refused question does not look at the catalogue's answer.
  const who: Who = { ip: caller, token: bearerOf(req) }
  const verdict = deps.gate ? deps.gate.check(who).catch(() => null) : Promise.resolve(null)
  // What to look for comes from the customer's recent wishes: the last two of their messages ("and with a refill?" follows an earlier "Instagram followers")
  const wish = messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ')
  const searching = search(deps, wish)
  searching.catch(() => undefined) // read below, after the verdict; a refused question never reads it
  const turn = await verdict
  if (turn && !turn.allowed) return tooMany(turn.retryAfter)
  let found: Found
  try {
    found = await searching
  } catch {
    // Without the catalogue the model would answer from nothing: refuse, never let it guess
    return json(503, 'catalog_unavailable', 'The catalogue is not available right now. Try again in a minute.')
  }

  // A client that asks for ndjson gets the answer with cards: the model is given the recommend tool and each recommended article comes back as a card.
  // A client that does not (a page opened before this was shipped) gets the plain text it always did.
  const wantsCards = (req.headers.get('accept') ?? '').toLowerCase().includes(NDJSON)
  // With cards every model is tried with the tool first; if none can answer with it, the first one is asked once more without it, so that a model
  // that does not take tools can never take the whole chat down with it. (The last try is skipped when the others have used up the time.)
  const attempts = [...models.map((model) => ({ model, tools: wantsCards })), ...(wantsCards && models[0] ? [{ model: models[0], tools: false }] : [])]
  const started = Date.now()
  // The log of this question is written after the answer, never before it and never waited for: the request is kept alive for it (waitUntil) and let go
  // when it is written. Taken now, while the request is surely the current one.
  const release = deps.gate ? deps.hold?.() : undefined
  const prompt = messages[messages.length - 1].content
  const written = { text: '' }
  for (const { model, tools } of attempts) {
    if (req.signal.aborted) break
    if (wantsCards && !tools && Date.now() - started > PLAIN_RETRY_BUDGET_MS) break
    const calls: Recommendation[] = []
    try {
      const answer = await deps.generate({
        apiKey, model, messages, signal: req.signal,
        system: buildSystemPrompt(found.found, found.addons, found.note, { cards: tools }),
        ...(tools ? { recommend: (call: Recommendation) => { calls.push(call) } } : {}),
      })
      // Once, when the answer has ended or the customer has gone, whichever comes first.
      let recorded = false
      const record = (cards: ChatCard[] = cardsFor(calls, found.found, found.addons, written.text)) => {
        if (recorded) return
        recorded = true
        const entry: LogEntry = {
          prompt, intent: found.intent, matched: [...found.found, ...found.addons].map((s) => s.sku), recommended: cards.map((c) => c.sku),
          found: found.found.length, toolCalls: calls.length, model,
        }
        void (deps.gate ? deps.gate.log(who, entry) : Promise.resolve()).catch(() => undefined).finally(() => release?.())
      }
      req.signal.addEventListener('abort', () => record(), { once: true })

      // X-Chat-Tools: whether the answer that went out was made with the recommend tool (off: every try with the tool failed and the plain one answered)
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Chat-Model': model, ...(wantsCards ? { 'X-Chat-Tools': tools ? 'on' : 'off' } : {}) }
      return wantsCards
        ? new Response(framed(answer, written, () => {
          const cards = cardsFor(calls, found.found, found.addons, written.text)
          record(cards)
          return { cards, calls: calls.length }
        }), { headers: { ...headers, 'Content-Type': `${NDJSON}; charset=utf-8` } })
        : new Response(passedOn(answer, written, () => record()), { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
    } catch {
      // overloaded, retired, over its quota: the next model takes over
    }
  }
  release?.()
  return json(503, 'assistant_unavailable', 'The assistant is busy right now. Try again in a minute.')
}

/** The content type of an answer with cards: one JSON object per line. */
export const NDJSON = 'application/x-ndjson'
/** After this long the last, tool-less try is not made: the platform gives an Edge function about 25 s to begin answering. */
const PLAIN_RETRY_BUDGET_MS = 14_000

/**
 * The answer as lines of JSON: {"t":"text","d":"..."} for every piece of text as it is written, then, once the model has finished, one
 * {"t":"card","c":{...}} for every recommended service, and {"t":"end","calls":N} (N: how many times the model called the tool; the cards also come from
 * the articles its text names). A stream without the end line was cut short. `written` collects the text as it goes; `finish` is called once the model is done.
 */
function framed(answer: ReadableStream<Uint8Array>, written: { text: string }, finish: () => { cards: ChatCard[]; calls: number }): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const line = (event: object) => encoder.encode(`${JSON.stringify(event)}\n`)
  return answer.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const d = decoder.decode(chunk, { stream: true })
      if (d === '') return
      written.text += d
      controller.enqueue(line({ t: 'text', d }))
    },
    flush(controller) {
      const rest = decoder.decode()
      if (rest !== '') { written.text += rest; controller.enqueue(line({ t: 'text', d: rest })) }
      const done = finish()
      for (const c of done.cards) controller.enqueue(line({ t: 'card', c }))
      controller.enqueue(line({ t: 'end', calls: done.calls }))
    },
  }))
}

/** The plain-text answer, unchanged on its way out; `written` collects the text and `finish` is called when the model is done. */
function passedOn(answer: ReadableStream<Uint8Array>, written: { text: string }, finish: () => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  return answer.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written.text += decoder.decode(chunk, { stream: true })
      controller.enqueue(chunk)
    },
    flush() {
      written.text += decoder.decode()
      finish()
    },
  }))
}

/** At most `limit` questions per caller in `windowMs`. Kept per instance: it stops a loop, not a determined abuser (the hourly limit of the gate is the real one). */
export function createRateLimiter(limit = 20, windowMs = 10 * 60_000, now: () => number = Date.now): (caller: string) => boolean {
  const seen = new Map<string, { count: number; resetAt: number }>()
  return (caller) => {
    const t = now()
    if (seen.size > 5_000) for (const [k, v] of seen) if (v.resetAt <= t) seen.delete(k)
    const entry = seen.get(caller)
    if (!entry || entry.resetAt <= t) {
      seen.set(caller, { count: 1, resetAt: t + windowMs })
      return true
    }
    entry.count++
    return entry.count <= limit
  }
}
