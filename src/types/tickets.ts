// Shapes of the user-tickets / admin-tickets Edge Functions (POST, signed-in users / admins only).
export type { TicketDto as Ticket, TicketMessageDto as TicketMessage, TicketStatus } from '../../supabase/functions/_shared/tickets.ts'
export { TICKET_STATUSES } from '../../supabase/functions/_shared/tickets.ts'

export interface NewTicketInput {
  subject: string
  message: string
  /** One of the customer's own orders; the server refuses anyone else's. */
  orderId?: string | null
}

export type TicketErrorCode =
  | 'ticket_not_found'
  | 'order_not_found'
  | 'ticket_closed'
  | 'too_many_open_tickets'
  | 'rate_limited'
  | 'invalid_input'
  | 'forbidden'
  | 'unauthorized'
  | 'network'
  | 'server'
