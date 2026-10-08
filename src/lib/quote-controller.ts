// The brains of the live price in the order form, without React so it can be tested with fake timers.
//
// What it guarantees:
//   * DEBOUNCE   - typing "5", "50", "500" sends ONE request, `delayMs` after the last keystroke
//   * ONE IN FLIGHT - a new input aborts the previous request; a late answer of a superseded request is dropped, never shown
//   * NO REPEATS - the same input as the one already priced (or pending) sends nothing; recent answers are reused for a few seconds
//   * PROMO FALLBACK - if the code is refused, the price WITHOUT it is fetched once, so the customer still sees what they pay
//   * NEVER THROWS - failures become a `QuoteState`

import type { Quote, QuoteRequest, QuoteState } from '@/types/quote'

export const QUOTE_DEBOUNCE_MS = 400
export const QUOTE_CACHE_MS = 10_000
const CACHE_LIMIT = 20

/** A fetch that rejects with an `isPromoProblem` error when the promo code was refused. */
export type QuoteFetcher = (request: QuoteRequest, signal: AbortSignal) => Promise<Quote>

export interface QuoteControllerOptions {
  fetchQuote: QuoteFetcher
  onState: (state: QuoteState) => void
  delayMs?: number
  now?: () => number
}

const keyOf = (r: QuoteRequest) => `${r.serviceId}|${r.quantity}|${(r.promoCode ?? '').trim().toUpperCase()}`
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const isPromoProblem = (e: unknown): e is Error & { isPromoProblem: true } => e instanceof Error && (e as { isPromoProblem?: boolean }).isPromoProblem === true

export function createQuoteController(opts: QuoteControllerOptions) {
  const delay = opts.delayMs ?? QUOTE_DEBOUNCE_MS
  const now = opts.now ?? Date.now
  const cache = new Map<string, { at: number; state: Extract<QuoteState, { kind: 'ready' }> }>()

  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: AbortController | undefined
  let seq = 0
  let currentKey: string | null = null
  let last: QuoteState = { kind: 'idle' }
  let disposed = false

  const emit = (state: QuoteState) => {
    last = state
    if (!disposed) opts.onState(state)
  }
  const previousQuote = (): Quote | null => (last.kind === 'ready' ? last.quote : last.kind === 'loading' ? last.previous : null)
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    abort?.abort()
    abort = undefined
    seq++ // whatever was in flight is now stale
  }

  async function run(request: QuoteRequest, mySeq: number) {
    const controller = new AbortController()
    abort = controller
    const stale = () => disposed || mySeq !== seq
    try {
      let state: Extract<QuoteState, { kind: 'ready' }>
      try {
        state = { kind: 'ready', quote: await opts.fetchQuote(request, controller.signal), promoError: null }
      } catch (e) {
        if (isAbort(e) || stale()) return
        if (!isPromoProblem(e) || !request.promoCode) throw e
        // The code was refused: show the price without it, plus why.
        const plain = await opts.fetchQuote({ serviceId: request.serviceId, quantity: request.quantity }, controller.signal)
        state = { kind: 'ready', quote: plain, promoError: e.message }
      }
      if (stale()) return
      cache.set(keyOf(request), { at: now(), state })
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
      emit(state)
    } catch (e) {
      if (isAbort(e) || stale()) return
      emit({ kind: 'error', message: e instanceof Error ? e.message : 'Could not refresh the price.' })
    }
  }

  return {
    /** Call on every change of the inputs. `null` = no valid quantity (nothing to price). */
    update(request: QuoteRequest | null) {
      if (disposed) return
      if (!request) {
        cancel()
        currentKey = null
        emit({ kind: 'idle' })
        return
      }
      const key = keyOf(request)
      if (key === currentKey) return // same input: already priced or already on its way
      cancel()
      currentKey = key

      const hit = cache.get(key)
      if (hit && now() - hit.at < QUOTE_CACHE_MS) {
        emit(hit.state)
        return
      }
      emit({ kind: 'loading', previous: previousQuote() })
      const mySeq = seq
      timer = setTimeout(() => {
        timer = undefined
        void run(request, mySeq)
      }, delay)
    },

    /** Forget the cache and re-price the current input right away (e.g. after a failed order, when a promo may have changed). */
    invalidate() {
      cache.clear()
      currentKey = null
    },

    dispose() {
      cancel()
      disposed = true
    },
  }
}
