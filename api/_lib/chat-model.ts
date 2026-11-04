// The model call of the support chat: the AI SDK, the answer as a stream of text, and the recommend tool. It takes the model as an argument (api/chat.ts
// gives it Gemini; the tests give it a scripted one), so it is tested without a key or a network.

import { jsonSchema, streamText, tool, type LanguageModel } from 'ai'
import type { ChatMessage } from './chat-handler'
import { RECOMMEND_TOOL, type Recommendation } from './chat-rag'

export const MAX_OUTPUT_TOKENS = 900
/** A model that has not said (or recommended) anything by then is given up on: the next one is tried. */
export const FIRST_WORD_TIMEOUT_MS = 12_000

/**
 * The tool that turns a recommendation into a card. It has no `execute`: the call ends the answer and the chat shows the card (a second round trip
 * to the model for every answer would double its cost and its time). The model is asked to call it once per article, after the text.
 */
const recommendTool = tool({
  description:
    'MANDATORY: you MUST call this for EVERY service you recommend to the customer, once per service, right after your text answer (several calls in one response). ' +
    'It is the only way the customer gets the card with the "Select" button; an answer that names an article without calling it is wrong. ' +
    'sku must be an article number copied from the list you were given; name and price are those of the list.',
  inputSchema: jsonSchema<{ sku: string; name: string; price: number }>({
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'The article number (SKU) of the service you recommend, copied exactly from the list.' },
      name: { type: 'string', description: 'The name of the service.' },
      price: { type: 'number', description: 'The retail price per 1000, in US dollars.' },
    },
    required: ['sku', 'name', 'price'],
  }),
})

/** What the model's stream gives, one part at a time: text to pass on, a recommendation (handed to `recommend`), or nothing to pass. */
type Step = { kind: 'text'; bytes: Uint8Array } | { kind: 'call' } | { kind: 'skip' } | { kind: 'end' }

/**
 * Starts the model and waits for its first words (or its first recommendation): a model that is overloaded, retired or out of quota fails right
 * there, before anything is sent to the customer, so the caller can try the next one. From then on the answer is streamed as it is written, and every
 * call of the recommend tool is passed to `recommend` as it arrives. Without `recommend` the model is not given the tool at all.
 */
export async function answerStream({ model, system, messages, signal, recommend }: {
  model: LanguageModel
  system: string
  messages: ChatMessage[]
  signal: AbortSignal
  recommend?: (call: Recommendation) => void
}): Promise<ReadableStream<Uint8Array>> {
  const stop = new AbortController()
  const relay = () => stop.abort()
  signal.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(relay, FIRST_WORD_TIMEOUT_MS)
  const parts = streamText({
    model,
    system,
    messages,
    temperature: 0.3,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    abortSignal: stop.signal,
    ...(recommend ? { tools: { [RECOMMEND_TOOL]: recommendTool } } : {}),
  }).fullStream[Symbol.asyncIterator]()

  const encoder = new TextEncoder()
  const read = async (): Promise<Step> => {
    const { value: part, done } = await parts.next()
    if (done) return { kind: 'end' }
    if (part.type === 'text-delta') return part.text === '' ? { kind: 'skip' } : { kind: 'text', bytes: encoder.encode(part.text) }
    if (part.type === 'tool-call' && part.toolName === RECOMMEND_TOOL && recommend) {
      const input = (part.input ?? {}) as Partial<Record<keyof Recommendation, unknown>>
      recommend({
        sku: typeof input.sku === 'string' ? input.sku : '',
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
        ...(typeof input.price === 'number' ? { price: input.price } : {}),
      })
      return { kind: 'call' }
    }
    if (part.type === 'error') throw part.error // an overloaded or retired model reports it here, not by throwing
    return { kind: 'skip' }
  }

  let first: Uint8Array | null = null
  try {
    for (;;) {
      const step = await read()
      if (step.kind === 'end') throw new Error('the model answered nothing')
      if (step.kind === 'text') { first = step.bytes; break }
      if (step.kind === 'call') break // it began with a recommendation: it has started
    }
  } catch (error) {
    stop.abort()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', relay)
  }

  signal.addEventListener('abort', relay, { once: true }) // the customer left: stop the model
  return new ReadableStream<Uint8Array>({
    start: (controller) => { if (first) controller.enqueue(first) },
    async pull(controller) {
      try {
        // a pull that gives the stream nothing would not be called again: go on until there is text, or the end
        for (;;) {
          const step = await read()
          if (step.kind === 'text') { controller.enqueue(step.bytes); return }
          if (step.kind === 'end') { controller.close(); return }
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel: () => stop.abort(),
  })
}
