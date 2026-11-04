// The Vercel side of the chat gate: the assistant's hourly limit and its log live in Supabase (the chat-gate Edge Function), because a Vercel Edge
// instance remembers nothing between two requests. The function is called with a shared secret (CHAT_GATE_SECRET); no database key is ever here.
//
// Both calls are written never to throw: the limit is a protection and the log is a convenience, and neither may take the chat down. A limit that
// cannot be asked (the function is down, slow, or not set up yet) lets the question through, and the in-memory limiter of chat-handler.ts still stands.

/** Who is asking: the address Vercel saw, and the token of a signed-in customer (the gate verifies it; here it is only passed on). */
export interface Who {
  ip: string
  token?: string
}

export interface GateVerdict {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until a place frees up; 0 when allowed. */
  retryAfter: number
}

/** One line of the assistant's log. The gate cleans it again; this is what the chat knows after the answer. */
export interface LogEntry {
  prompt: string
  intent: object
  matched: string[]
  recommended: string[]
  found: number
  toolCalls: number
  model: string
}

export interface ChatGate {
  /** Counts this question against the caller's hour and says whether it may go on; null when the gate cannot say. */
  check(who: Who): Promise<GateVerdict | null>
  /** Writes the log of an answered question. Resolves when done or given up; never rejects. */
  log(who: Who, entry: LogEntry): Promise<void>
}

/** The limit is asked at the same time as the catalogue, so it should answer in less than the catalogue does; after this the question goes on. */
export const CHECK_TIMEOUT_MS = 1_500
/** The log is written after the answer has gone, so it may take its time. */
export const LOG_TIMEOUT_MS = 5_000

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The gate's answer, or null when it is not the shape of one (an error page, an old version of the function). */
export function parseVerdict(raw: unknown): GateVerdict | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  if (typeof v.allowed !== 'boolean' || !finite(v.limit) || !finite(v.remaining) || !finite(v.retry_after)) return null
  return { allowed: v.allowed, limit: v.limit, remaining: v.remaining, retryAfter: Math.max(0, Math.ceil(v.retry_after)) }
}

/** The gate, or undefined when it is not set up (no secret): then there is no hourly limit and no log, and the chat works as it did before. */
export function createGate(config: { supabaseUrl?: string; anonKey?: string; secret?: string; fetch: typeof fetch }): ChatGate | undefined {
  const { supabaseUrl, anonKey, secret } = config
  if (!supabaseUrl || !secret) return undefined
  const url = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/chat-gate`

  const call = async (body: object, timeoutMs: number): Promise<unknown> => {
    const res = await config.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chat-gate-secret': secret, ...(anonKey ? { apikey: anonKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`chat gate answered ${res.status}`)
    return res.json()
  }

  return {
    async check(who) {
      try {
        return parseVerdict(await call({ action: 'check', ip: who.ip, token: who.token ?? null }, CHECK_TIMEOUT_MS))
      } catch {
        return null
      }
    },
    async log(who, entry) {
      try {
        await call({ action: 'log', ip: who.ip, token: who.token ?? null, entry }, LOG_TIMEOUT_MS)
      } catch {
        // a lost line of the log is not a problem of the customer
      }
    },
  }
}
