// The support assistant, as the browser sees it: what is sent to /api/chat (api/chat.ts), how the streamed answer is read, and how an answer is cut into
// pieces so that every article number (SKU) in it can be copied with one tap.
import { SKU_PATTERN } from '@/lib/service-search'

/** The server takes up to 12 messages of up to 1000 characters (api/_lib/chat-handler.ts); the last one is the customer's. */
export const MAX_MESSAGES = 12
export const MAX_MESSAGE_CHARS = 1000

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
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

/** A "**" that has not been closed yet (the answer is still being written) is not shown. */
const tidy = (text: string) => text.replace(/\*\*/g, '')

/** Text with the articles in it taken out, as pieces. */
function withArticles(text: string, kind: 'text' | 'bold'): Piece[] {
  const out: Piece[] = []
  const re = new RegExp(SKU_PATTERN.source, 'gi')
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind, text: text.slice(last, m.index) })
    out.push({ kind: 'sku', text: m[0].toUpperCase() })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind, text: text.slice(last) })
  return out
}

/** The answer as pieces: plain text, **bold**, and every article number (in bold or not) on its own so it can be copied. */
export function splitAnswer(answer: string): Piece[] {
  const src = bulleted(answer)
  const out: Piece[] = []
  let last = 0
  for (const m of src.matchAll(BOLD)) {
    const at = m.index ?? 0
    if (at > last) out.push(...withArticles(tidy(src.slice(last, at)), 'text'))
    out.push(...withArticles(m[1]!, 'bold'))
    last = at + m[0].length
  }
  if (last < src.length) out.push(...withArticles(tidy(src.slice(last)), 'text'))
  return out.filter((p) => p.text !== '')
}

export type ChatFailure = 'busy' | 'rate_limited' | 'offline'

/** Why an answer did not come: the screen shows a sentence in the customer's language for each kind. */
export class ChatError extends Error {
  constructor(readonly kind: ChatFailure) {
    super(kind)
  }
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
): Promise<string> {
  let res: Response
  try {
    res = await fetcher('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: requestMessages(history) }),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ChatError('offline')
  }
  if (res.status === 429) throw new ChatError('rate_limited')
  if (!res.ok || !res.body) throw new ChatError('busy')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      onText(text)
    }
  } catch (e) {
    if (signal?.aborted) throw e
    if (text.trim() === '') throw new ChatError('offline')
    return text // the connection broke in the middle of an answer: what was written is shown
  }
  text += decoder.decode()
  if (text.trim() === '') throw new ChatError('busy')
  onText(text)
  return text
}

/** The development mock (no server behind the app): a fixed answer in the shape of a real one. */
export async function mockAssistant(onText: (soFar: string) => void): Promise<string> {
  const text = 'Here is a service that fits (mock answer):\n\n**IG-FOL-STD-ROOT89336** — Instagram Followers, $0.9828 per 1000, 30 days refill.'
  onText(text)
  return text
}
