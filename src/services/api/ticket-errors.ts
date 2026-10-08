import type { TicketErrorCode } from '@/types/tickets'

export class TicketApiError extends Error {
  readonly code: TicketErrorCode
  constructor(code: TicketErrorCode, message: string) {
    super(message)
    this.name = 'TicketApiError'
    this.code = code
  }
}

const KNOWN: readonly TicketErrorCode[] = ['ticket_not_found', 'order_not_found', 'ticket_closed', 'too_many_open_tickets', 'rate_limited', 'invalid_input', 'forbidden', 'unauthorized']

/** The server's JSON error -> a typed error with its own (safe) message. */
export function ticketErrorFrom(status: number, body: { error?: string; message?: string } | null): TicketApiError {
  const code = KNOWN.find((c) => c === body?.error)
  if (code) return new TicketApiError(code, body?.message ?? 'Request refused.')
  if (status === 401) return new TicketApiError('unauthorized', 'Please reopen the app.')
  if (status === 403) return new TicketApiError('forbidden', 'Admin access required.')
  return new TicketApiError('server', 'Something went wrong. Please try again.')
}
