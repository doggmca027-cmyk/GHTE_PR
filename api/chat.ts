// POST /api/chat: the support assistant. Edge runtime, streams the answer as plain text.
//   Body: { messages: [{ role: 'user' | 'assistant', content: string }, ...] }   (the last message from the user)
//   -> text/plain stream: the answer, as it is written.
// Retrieval-augmented: the services that fit the customer's wish are looked up in the public storefront and put into the system prompt, and the
// model is told to answer only from them (see _lib/chat-rag.ts). Needs, in the Vercel project: GOOGLE_GENERATIVE_AI_API_KEY (a Google AI Studio
// key); the storefront's URL and anon key are the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is built with. GEMINI_MODEL is optional.

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { streamText } from 'ai'
import { createRateLimiter, DEFAULT_MODEL, FALLBACK_MODELS, handleChat, type ChatDeps } from './_lib/chat-handler'

export const config = { runtime: 'edge' }

const MAX_OUTPUT_TOKENS = 700
/** A model that has not said its first word by then is given up on: the next one is tried. */
const FIRST_WORD_TIMEOUT_MS = 12_000
const allow = createRateLimiter()

/**
 * Starts the model and waits for its first words: a model that is overloaded, retired or out of quota fails right there, before anything is sent to
 * the customer, so the handler can try the next one. From then on the answer is streamed as it is written.
 */
const generate: ChatDeps['generate'] = async ({ apiKey, model, system, messages, signal }) => {
  const stop = new AbortController()
  const relay = () => stop.abort()
  signal.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(relay, FIRST_WORD_TIMEOUT_MS)
  const words = streamText({
    model: createGoogleGenerativeAI({ apiKey })(model),
    system,
    messages,
    temperature: 0.3,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    abortSignal: stop.signal,
  }).textStream[Symbol.asyncIterator]()

  let firstWords: string
  try {
    const first = await words.next()
    if (first.done) throw new Error('the model answered nothing')
    firstWords = first.value
  } catch (error) {
    stop.abort()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', relay)
  }

  const encoder = new TextEncoder()
  signal.addEventListener('abort', relay, { once: true }) // the customer left: stop the model
  return new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(encoder.encode(firstWords)),
    async pull(controller) {
      try {
        const next = await words.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        controller.error(error)
      }
    },
    cancel: () => stop.abort(),
  })
}

export default function handler(request: Request): Promise<Response> {
  const env = process.env
  return handleChat(request, {
    env: {
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL,
      anonKey: env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY,
      models: [...new Set([env.GEMINI_MODEL, DEFAULT_MODEL, ...FALLBACK_MODELS].filter((m): m is string => Boolean(m)))],
    },
    fetch,
    allow,
    generate,
  })
}
