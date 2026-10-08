import type { QuoteErrorCode } from '@/types/quote'

export class QuoteApiError extends Error {
  readonly code: QuoteErrorCode
  constructor(code: QuoteErrorCode, message: string) {
    super(message)
    this.name = 'QuoteApiError'
    this.code = code
  }
  /** The code the customer typed was refused (the price without it is still valid). */
  get isPromoProblem(): boolean {
    return this.code.startsWith('promo_')
  }
}
