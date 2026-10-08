import { useEffect, useRef, useState } from 'react'
import { createQuoteController } from '@/lib/quote-controller'
import type { AuthSession } from '@/services/api/auth'
import { getQuote } from '@/services/api/quotes'
import type { QuoteState } from '@/types/quote'

/**
 * The live price of an order. `quantity` is null until it is valid (nothing is requested then). Typing is debounced and
 * superseded requests are aborted: see lib/quote-controller.ts.
 */
export function useQuote(session: AuthSession, serviceId: string, quantity: number | null, promoCode: string): { state: QuoteState; invalidate: () => void } {
  const [state, setState] = useState<QuoteState>({ kind: 'idle' })
  const sessionRef = useRef(session)
  sessionRef.current = session
  const controllerRef = useRef<ReturnType<typeof createQuoteController> | null>(null)

  useEffect(() => {
    const controller = createQuoteController({ fetchQuote: (request, signal) => getQuote(sessionRef.current, request, signal), onState: setState })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [])

  const code = promoCode.trim()
  useEffect(() => {
    controllerRef.current?.update(quantity === null ? null : { serviceId, quantity, ...(code ? { promoCode: code } : {}) })
  }, [serviceId, quantity, code])

  return { state, invalidate: () => controllerRef.current?.invalidate() }
}
