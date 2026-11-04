// POST /api/chat: the support assistant. Edge runtime.
//   Body: { messages: [{ role: 'user' | 'assistant', content: string }, ...] }   (the last message from the user)
//   -> text/plain stream: the answer, as it is written; or, for a client that sends `Accept: application/x-ndjson`, lines of JSON: the text as it is
//      written, then a card for every service the assistant recommended (see _lib/chat-handler.ts).
// Retrieval-augmented: the services that fit the customer's wish are looked up in the public storefront and put into the system prompt, and the
// model is told to answer only from them (see _lib/chat-rag.ts). Needs, in the Vercel project: GOOGLE_GENERATIVE_AI_API_KEY (a Google AI Studio
// key); the storefront's URL and anon key are the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is built with. GEMINI_MODEL is optional.

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { answerStream } from './_lib/chat-model'
import { createRateLimiter, DEFAULT_MODEL, FALLBACK_MODELS, handleChat, type ChatDeps } from './_lib/chat-handler'

export const config = { runtime: 'edge' }

const allow = createRateLimiter()

const generate: ChatDeps['generate'] = ({ apiKey, model, ...call }) => answerStream({ model: createGoogleGenerativeAI({ apiKey })(model), ...call })

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
