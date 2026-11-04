// POST /api/chat: the support assistant. Edge runtime.
//   Body: { messages: [{ role: 'user' | 'assistant', content: string }, ...] }   (the last message from the user)
//   Header: Authorization: Bearer <app token>   (optional: a signed-in customer is counted and logged by Telegram id, a guest by a hash of the IP)
//   -> text/plain stream: the answer, as it is written; or, for a client that sends `Accept: application/x-ndjson`, lines of JSON: the text as it is
//      written, then a card for every service the assistant recommended (see _lib/chat-handler.ts).
//   -> 429 when the hourly limit is used up (Retry-After: seconds).
// Retrieval-augmented: the services that fit the customer's wish are looked up in the public storefront and put into the system prompt, and the
// model is told to answer only from them (see _lib/chat-rag.ts). Needs, in the Vercel project: GOOGLE_GENERATIVE_AI_API_KEY (a Google AI Studio
// key); the storefront's URL and anon key are the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is built with. GEMINI_MODEL is optional.
// CHAT_GATE_SECRET (the same value as the Supabase function secret of that name) switches on the hourly limit and the assistant's log.

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { answerStream } from './_lib/chat-model'
import { createGate } from './_lib/chat-gate'
import { holdOpen } from './_lib/chat-hold'
import { createRateLimiter, DEFAULT_MODEL, FALLBACK_MODELS, handleChat, type ChatDeps } from './_lib/chat-handler'

export const config = { runtime: 'edge' }

// The small limit of this instance's memory only stops a loop: with the gate on, the hourly limit (20) is the real one and must be reached first
const allow = createRateLimiter(process.env.CHAT_GATE_SECRET ? 60 : 20)

const generate: ChatDeps['generate'] = ({ apiKey, model, ...call }) => answerStream({ model: createGoogleGenerativeAI({ apiKey })(model), ...call })

export default function handler(request: Request): Promise<Response> {
  const env = process.env
  const supabaseUrl = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY
  return handleChat(request, {
    env: {
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      supabaseUrl,
      anonKey,
      models: [...new Set([env.GEMINI_MODEL, DEFAULT_MODEL, ...FALLBACK_MODELS].filter((m): m is string => Boolean(m)))],
    },
    fetch,
    allow,
    generate,
    gate: createGate({ supabaseUrl, anonKey, secret: env.CHAT_GATE_SECRET, fetch }),
    hold: holdOpen,
  })
}
