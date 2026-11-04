// The request side of the support chat (api/chat.ts): validation, a small rate limit, retrieval from the public storefront, the system prompt, and
// the model call. The model call is injected, so this is tested without the AI SDK, a key or a network.

import {
  addonIntent, buildSearchUrl, buildSystemPrompt, cardsFor, companionActions, extractIntent, rankAddons, rankServices, searchKinds, situationNote, withAlternative,
  type ChatCard, type Recommendation, type SearchKind, type StorefrontService,
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
  /** True when this caller may ask again. */
  allow: (caller: string) => boolean
  /**
   * Starts the model's answer: resolves with the text, as a stream, once it has begun; rejects when the model cannot answer. With `recommend` the model
   * has the recommend tool, and every call of it is passed to `recommend` (before the stream ends).
   */
  generate: (args: { apiKey: string; model: string; system: string; messages: ChatMessage[]; signal: AbortSignal; recommend?: (call: Recommendation) => void }) => Promise<ReadableStream<Uint8Array>>
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
  const [lists, addonList] = await Promise.all([Promise.all(requests.map((r) => get(r.url))), addonUrl ? get(addonUrl) : Promise.resolve([] as StorefrontService[])])
  // a country nobody names: the best MIX / worldwide cards still reach the model, whatever their price ranks them
  const mix = lists[requests.findIndex((r) => r.kind === 'worldwide')] ?? []
  const found = lists.length === 0 ? [] : withAlternative(rankServices(lists.flat(), intent), mix, intent)
  return { found, addons: addonList.length === 0 ? [] : rankAddons(addonList, intent), note: situationNote(intent, found) }
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

  // What to look for comes from the customer's recent wishes: the last two of their messages ("and with a refill?" follows an earlier "Instagram followers")
  const wish = messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ')
  let found: Found
  try {
    found = await search(deps, wish)
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
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Chat-Model': model }
      return wantsCards
        ? new Response(framed(answer, (text) => ({ cards: cardsFor(calls, found.found, found.addons, text), calls: calls.length })), { headers: { ...headers, 'Content-Type': `${NDJSON}; charset=utf-8` } })
        : new Response(answer, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
    } catch {
      // overloaded, retired, over its quota: the next model takes over
    }
  }
  return json(503, 'assistant_unavailable', 'The assistant is busy right now. Try again in a minute.')
}

/** The content type of an answer with cards: one JSON object per line. */
export const NDJSON = 'application/x-ndjson'
/** After this long the last, tool-less try is not made: the platform gives an Edge function about 25 s to begin answering. */
const PLAIN_RETRY_BUDGET_MS = 14_000

/**
 * The answer as lines of JSON: {"t":"text","d":"..."} for every piece of text as it is written, then, once the model has finished, one
 * {"t":"card","c":{...}} for every recommended service, and {"t":"end","calls":N} (N: how many times the model called the tool; the cards also come from
 * the articles its text names). A stream without the end line was cut short. `finish` gets the whole text, once the model is done.
 */
function framed(answer: ReadableStream<Uint8Array>, finish: (text: string) => { cards: ChatCard[]; calls: number }): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const line = (event: object) => encoder.encode(`${JSON.stringify(event)}\n`)
  let text = ''
  return answer.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const d = decoder.decode(chunk, { stream: true })
      if (d === '') return
      text += d
      controller.enqueue(line({ t: 'text', d }))
    },
    flush(controller) {
      const rest = decoder.decode()
      if (rest !== '') { text += rest; controller.enqueue(line({ t: 'text', d: rest })) }
      const done = finish(text)
      for (const c of done.cards) controller.enqueue(line({ t: 'card', c }))
      controller.enqueue(line({ t: 'end', calls: done.calls }))
    },
  }))
}

/** At most `limit` questions per caller in `windowMs`. Kept per instance: it stops a loop, not a determined abuser (the model's own quota is the backstop). */
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
