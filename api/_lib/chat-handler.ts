// The request side of the support chat (api/chat.ts): validation, a small rate limit, retrieval from the public storefront, the system prompt, and
// the model call. The model call is injected, so this is tested without the AI SDK, a key or a network.

import { buildSearchUrl, buildSystemPrompt, extractIntent, rankServices, searchKinds, type StorefrontService } from './chat-rag'

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
  /** Starts the model's answer: resolves with the text, as a stream, once it has begun; rejects when the model cannot answer. */
  generate: (args: { apiKey: string; model: string; system: string; messages: ChatMessage[]; signal: AbortSignal }) => Promise<ReadableStream<Uint8Array>>
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

async function search(deps: ChatDeps, text: string): Promise<StorefrontService[]> {
  const intent = extractIntent(text)
  const urls = searchKinds(intent).map((kind) => buildSearchUrl(deps.env.supabaseUrl!, intent, kind)).filter((url): url is string => url !== null)
  const lists = await Promise.all(urls.map(async (url) => {
    const res = await deps.fetch(url, {
      headers: { apikey: deps.env.anonKey!, Authorization: `Bearer ${deps.env.anonKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`storefront search answered ${res.status}`)
    return (await res.json()) as StorefrontService[]
  }))
  return lists.length === 0 ? [] : rankServices(lists.flat(), intent)
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
  let found: StorefrontService[]
  try {
    found = await search(deps, wish)
  } catch {
    // Without the catalogue the model would answer from nothing: refuse, never let it guess
    return json(503, 'catalog_unavailable', 'The catalogue is not available right now. Try again in a minute.')
  }

  const system = buildSystemPrompt(found)
  for (const model of models) {
    if (req.signal.aborted) break
    try {
      const answer = await deps.generate({ apiKey, model, system, messages, signal: req.signal })
      return new Response(answer, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Chat-Model': model },
      })
    } catch {
      // overloaded, retired, over its quota: the next model takes over
    }
  }
  return json(503, 'assistant_unavailable', 'The assistant is busy right now. Try again in a minute.')
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
