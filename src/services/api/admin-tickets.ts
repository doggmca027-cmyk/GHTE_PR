// Client of the admin-tickets Edge Function. Admins only: the server answers 403 to anyone else (the app only hides the tab).
import type { AuthSession } from '@/services/api/auth'
import { mockTickets } from './mock-tickets'
import { TicketApiError } from './ticket-errors'
import { callTickets } from './tickets'
import type { Ticket, TicketStatus } from '@/types/tickets'

const guard = (session: AuthSession) => {
  if (!session.user.isAdmin) throw new TicketApiError('forbidden', 'Admin access required.')
}

export interface AdminTicketList {
  counts: Record<TicketStatus, number>
  tickets: Ticket[]
}

export async function adminListTickets(session: AuthSession, status: TicketStatus | null): Promise<AdminTicketList> {
  if (session.isMock) {
    guard(session)
    return mockTickets().adminList(status)
  }
  return callTickets<AdminTicketList>('admin-tickets', session, { action: 'list_all_tickets', ...(status ? { status } : {}) })
}

export async function adminGetTicket(session: AuthSession, ticketId: string): Promise<Ticket> {
  if (session.isMock) {
    guard(session)
    return mockTickets().adminGet(ticketId)
  }
  return (await callTickets<{ ticket: Ticket }>('admin-tickets', session, { action: 'get_ticket', ticketId })).ticket
}

export async function adminReply(session: AuthSession, ticketId: string, message: string): Promise<Ticket> {
  if (session.isMock) {
    guard(session)
    return mockTickets().adminReply(ticketId, message)
  }
  return (await callTickets<{ ticket: Ticket }>('admin-tickets', session, { action: 'reply_to_ticket', ticketId, message })).ticket
}

export async function adminSetTicketStatus(session: AuthSession, ticketId: string, status: 'resolved' | 'closed'): Promise<Ticket> {
  if (session.isMock) {
    guard(session)
    return mockTickets().adminSetStatus(ticketId, status)
  }
  return (await callTickets<{ ticket: Ticket }>('admin-tickets', session, { action: status === 'closed' ? 'close_ticket' : 'resolve_ticket', ticketId })).ticket
}
