// POST /api/chat: the support assistant. Edge runtime, streams the answer as plain text.
//   Body: { messages: [{ role: 'user' | 'assistant', content: string }, ...] }   (the last message from the user)
//   -> text/plain stream: the answer, as it is written.
// Retrieval-augmented: the services that fit the customer's wish are looked up in the public storefront and put into the system prompt, and the
// model is told to answer only from them (see _lib/chat-rag.ts). Needs, in the Vercel project: GOOGLE_GENERATIVE_AI_API_KEY (a Google AI Studio
// key); the storefront's URL and anon key are the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is built with. GEMINI_MODEL is optional.

import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { streamText } from 'ai'
import { createRateLimiter, DEFAULT_MODEL, handleChat } from './_lib/chat-handler'

export const config = { runtime: 'edge' }

const MAX_OUTPUT_TOKENS = 700
const allow = createRateLimiter()

export default function handler(request: Request): Promise<Response> {
  const env = process.env
  return handleChat(request, {
    env: {
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL,
      anonKey: env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY,
      model: env.GEMINI_MODEL || DEFAULT_MODEL,
    },
    fetch,
    allow,
    stream: ({ apiKey, model, system, messages, signal }) =>
      streamText({
        model: createGoogleGenerativeAI({ apiKey })(model),
        system,
        messages,
        temperature: 0.3,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: signal,
      }).toTextStreamResponse({ headers: { 'Cache-Control': 'no-store' } }),
  })
}
