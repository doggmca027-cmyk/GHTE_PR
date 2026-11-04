// The support assistant, as the browser sees it: what is sent to /api/chat (api/chat.ts), how the streamed answer is read, and how an answer is cut into
// pieces so that every article number (SKU) in it can be copied with one tap.
import type { ChatCard } from '../../api/_lib/chat-rag'
import { SKU_PATTERN } from '@/lib/service-search'

export type { ChatCard }

/** The server takes up to 12 messages of up to 1000 characters (api/_lib/chat-handler.ts); the last one is the customer's. */
export const MAX_MESSAGES = 12
export const MAX_MESSAGE_CHARS = 1000
/** An answer shows at most this many cards (the server stops at the same number). */
const MAX_CARDS = 5

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A message on the screen: what was said, and for an answer the services it recommended, as cards. Only `role` and `content` go to the server. */
export interface ChatBubble extends ChatMessage {
  cards?: ChatCard[]
  /** The answer is still being written: its end may be half a word, half an article number or an unclosed backtick (see splitAnswer). */
  streaming?: boolean
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A card as the server sends it, or null: the screen shows only what has the shape it expects (a number is a number, a flag is a flag). */
export function parseCard(raw: unknown): ChatCard | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (typeof c.sku !== 'string' || c.sku === '' || typeof c.name !== 'string' || typeof c.category !== 'string' || typeof c.platform !== 'string') return null
  if (!isNumber(c.price) || c.price < 0 || !isNumber(c.min) || !isNumber(c.max)) return null
  if (typeof c.refill !== 'boolean' || typeof c.dripfeed !== 'boolean' || (c.role !== 'main' && c.role !== 'addon')) return null
  return {
    sku: c.sku, name: c.name, price: c.price, category: c.category, platform: c.platform, min: c.min, max: c.max, refill: c.refill, dripfeed: c.dripfeed, role: c.role,
    ...(isNumber(c.refillDays) ? { refillDays: c.refillDays } : {}),
    ...(c.lifetime === true ? { lifetime: true as const } : {}),
  }
}

/**
 * What goes to the server: the last messages, each cut to the limit (an answer can be longer than a question may be), the first one the customer's
 * (the model does not start a conversation with its own words), none empty.
 */
export function requestMessages(history: readonly ChatMessage[]): ChatMessage[] {
  const kept = history
    .filter((m) => m.content.trim() !== '')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_MESSAGES)
  while (kept.length > 0 && kept[0]!.role === 'assistant') kept.shift()
  return kept
}

export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  /** An article number: shown as a chip with a copy button. */
  | { kind: 'sku'; text: string }

const BOLD = /\*\*([^*\n]+)\*\*/g

/** A line that starts with "* " or "- " is a bullet, not an asterisk (looked at in the whole answer, so a hyphen in the middle of a line stays one). */
const bulleted = (answer: string) => answer.replace(/^([ \t]*)[*-][ \t]+/gm, '$1• ')

/** A "**" or a backtick that has not been closed yet (the answer is still being written) is not shown. */
const tidy = (text: string) => text.replace(/\*\*/g, '').replace(/`/g, '')

/** `code` as the assistant writes an article: the backticks go, the article stays and becomes a chip that copies it with one tap. */
const unticked = (answer: string) => answer.replace(/`([^`\n]+)`/g, '$1')

/**
 * Text with the articles in it taken out, as pieces. `openEnd`: the text ends where the answer so far ends, so an article that touches its end may be
 * only the beginning of one ("IG-FOL-HQ-3F9A" of "IG-FOL-HQ-3F9A1C"): it stays text until the answer goes on or ends.
 */
function withArticles(text: string, kind: 'text' | 'bold', openEnd = false): Piece[] {
  const out: Piece[] = []
  const re = new RegExp(SKU_PATTERN.source, 'gi')
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (openEnd && m.index + m[0].length === text.length) break // the rest, this article included, is written out below as it stands
    if (m.index > last) out.push({ kind, text: text.slice(last, m.index) })
    out.push({ kind: 'sku', text: m[0].toUpperCase() })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind, text: text.slice(last) })
  return out
}

/**
 * The answer as pieces: plain text, **bold**, and every article number (in bold or not) on its own so it can be copied.
 *
 * `streaming`: the answer is still arriving, token by token, and every call sees a different prefix of the final text. Then nothing may show that the
 * final text will not have: an unclosed backtick or "**" is not shown (tidy), and an article number at the very end that no character follows yet is
 * not a chip (it may still grow, and a chip copies what it shows). It becomes one as soon as a character after it arrives, or the answer ends
 * (a call without `streaming`). A closing backtick or any punctuation counts as that character.
 */
export function splitAnswer(answer: string, { streaming = false }: { streaming?: boolean } = {}): Piece[] {
  const open = streaming && /[A-Za-z0-9-]$/.test(answer)
  const src = bulleted(unticked(answer))
  const out: Piece[] = []
  let last = 0
  for (const m of src.matchAll(BOLD)) {
    const at = m.index ?? 0
    if (at > last) out.push(...withArticles(tidy(src.slice(last, at)), 'text'))
    out.push(...withArticles(m[1]!, 'bold', open && at + m[0].length === src.length))
    last = at + m[0].length
  }
  if (last < src.length) out.push(...withArticles(tidy(src.slice(last)), 'text', open))
  return out.filter((p) => p.text !== '')
}

export type ChatFailure = 'busy' | 'rate_limited' | 'offline'

/** Why an answer did not come: the screen shows a sentence in the customer's language for each kind. */
export class ChatError extends Error {
  /** `retryAfter`: seconds until the customer may ask again, when the server said (the hourly limit does). */
  constructor(readonly kind: ChatFailure, readonly retryAfter?: number) {
    super(kind)
  }
}

/** The seconds of a `Retry-After` header (a whole number, within a day), else undefined: a date or nonsense is not worth a guess. */
export function retryAfterOf(res: Pick<Response, 'headers'>): number | undefined {
  const n = Number(res.headers.get('Retry-After'))
  return Number.isInteger(n) && n >= 1 && n <= 86_400 ? n : undefined
}

/**
 * Asks the assistant and reads its answer as it is written: `onText` gets everything received so far. Rejects with a ChatError (the model is busy, the
 * customer asked too much, there is no connection) or with the AbortError of `signal`.
 */
export async function askAssistant(
  history: readonly ChatMessage[],
  onText: (soFar: string) => void,
  signal?: AbortSignal,
  fetcher: typeof fetch = (...args) => fetch(...args),
  /** `onCards`: the services the assistant recommended, as they arrive (the whole list so far each time). `token`: a signed-in customer's token. */
  extras: { onCards?: (cards: ChatCard[]) => void; token?: string } = {},
): Promise<string> {
  let res: Response
  try {
    res = await fetcher('/api/chat', {
      method: 'POST',
      // asking for ndjson is asking for cards; a server that does not know it answers with plain text, which is read as before
      // the token (when there is one) tells the server who is asking, so the hourly limit is the customer's own and not that of a shared address
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...(extras.token ? { Authorization: `Bearer ${extras.token}` } : {}) },
      body: JSON.stringify({ messages: requestMessages(history) }),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ChatError('offline')
  }
  if (res.status === 429) throw new ChatError('rate_limited', retryAfterOf(res))
  if (!res.ok || !res.body) throw new ChatError('busy')

  const framed = (res.headers.get('Content-Type') ?? '').includes('application/x-ndjson')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let cards: ChatCard[] = []
  let pending = '' // the end of a line that has not been completed yet

  /** One line of a framed answer: a piece of text, a card, or the end. A line that is not JSON, or says something unknown, is skipped. */
  const line = (raw: string) => {
    let event: { t?: unknown; d?: unknown; c?: unknown }
    try {
      event = JSON.parse(raw) as typeof event
    } catch {
      return
    }
    if (event.t === 'text' && typeof event.d === 'string') {
      text += event.d
      onText(text)
    } else if (event.t === 'card') {
      const card = parseCard(event.c)
      if (card && cards.length < MAX_CARDS && !cards.some((c) => c.sku === card.sku)) {
        cards = [...cards, card]
        extras.onCards?.(cards)
      }
    }
  }
  const take = (chunk: string) => {
    if (!framed) { text += chunk; onText(text); return }
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const l of lines) if (l.trim() !== '') line(l)
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      take(decoder.decode(value, { stream: true }))
    }
  } catch (e) {
    if (signal?.aborted) throw e
    if (text.trim() === '' && cards.length === 0) throw new ChatError('offline')
    return text // the connection broke in the middle of an answer: what was written is shown
  }
  const rest = decoder.decode()
  if (framed) {
    take(rest)
    if (pending.trim() !== '') line(pending)
  } else {
    text += rest
  }
  if (text.trim() === '' && cards.length === 0) throw new ChatError('busy')
  if (!framed) onText(text)
  return text
}

/** The development mock (no server behind the app): a fixed answer in the shape of a real one. */
export async function mockAssistant(onText: (soFar: string) => void, onCards?: (cards: ChatCard[]) => void): Promise<string> {
  const text = 'Here is a service that fits (mock answer):\n\n**IG-FOL-STD-ROOT89336** — Instagram Followers, $0.9828 per 1000, 30 days refill.'
  onText(text)
  onCards?.([{
    sku: 'IG-FOL-STD-ROOT89336', name: 'Instagram Followers [Refill: 30 Days]', price: 0.9828, category: 'Instagram Followers', platform: 'instagram',
    min: 50, max: 200_000, refill: true, refillDays: 30, dripfeed: false, role: 'main',
  }])
  return text
}
