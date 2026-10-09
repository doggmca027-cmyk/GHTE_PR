import { tr } from '@/i18n'
// Client of the user-tickets Edge Function (the signed-in customer's own tickets).
import type { AuthSession } from '@/services/api/auth'
import { mockTickets } from './mock-tickets'
import { TicketApiError, ticketErrorFrom } from './ticket-errors'
import type { NewTicketInput, Ticket } from '@/types/tickets'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TIMEOUT_MS = 15_000

export { TicketApiError }

/** POSTs one action to a ticket function. Shared with the admin client. */
export async function callTickets<T>(fn: 'user-tickets' | 'admin-tickets', session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new TicketApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new TicketApiError('network', tr('Connection lost. Please try again.'))
  }
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean; error?: string; message?: string }) | null
  if (res.ok && data?.success) return data
  throw ticketErrorFrom(res.status, data)
}

export async function createTicket(session: AuthSession, input: NewTicketInput): Promise<Ticket> {
  if (session.isMock) return mockTickets().create(session.user.id, input)
  return (await callTickets<{ ticket: Ticket }>('user-tickets', session, { action: 'create_ticket', subject: input.subject, message: input.message, ...(input.orderId ? { orderId: input.orderId } : {}) })).ticket
}

export async function listMyTickets(session: AuthSession): Promise<Ticket[]> {
  if (session.isMock) return mockTickets().listMine(session.user.id)
  return (await callTickets<{ tickets: Ticket[] }>('user-tickets', session, { action: 'list_my_tickets' })).tickets
}

export async function getTicket(session: AuthSession, ticketId: string): Promise<Ticket> {
  if (session.isMock) return mockTickets().get(session.user.id, ticketId)
  return (await callTickets<{ ticket: Ticket }>('user-tickets', session, { action: 'get_ticket', ticketId })).ticket
}

export async function addTicketMessage(session: AuthSession, ticketId: string, message: string): Promise<Ticket> {
  if (session.isMock) return mockTickets().addMessage(session.user.id, ticketId, message)
  return (await callTickets<{ ticket: Ticket }>('user-tickets', session, { action: 'add_message', ticketId, message })).ticket
}
