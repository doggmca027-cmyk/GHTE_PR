// Offline tickets for the dev mock mode: one in-memory conversation store shared by the customer and admin screens, with the same
// rules as the database (owner-only reads, closed is final, replies move the status).
import { TicketApiError } from './ticket-errors'
import type { NewTicketInput, Ticket, TicketMessage, TicketStatus } from '@/types/tickets'

interface Stored { ticket: Omit<Ticket, 'messages'>; owner: string; messages: TicketMessage[] }

export function createMockTickets(now: () => number = Date.now) {
  const store: Stored[] = []
  let seq = 0
  const iso = () => new Date(now()).toISOString()
  const find = (id: string, owner?: string) => {
    const s = store.find((x) => x.ticket.id === id && (owner === undefined || x.owner === owner))
    if (!s) throw new TicketApiError('ticket_not_found', 'Ticket not found.')
    return s
  }
  const view = (s: Stored, withMessages = true): Ticket => ({ ...s.ticket, ...(withMessages ? { messages: [...s.messages] } : {}) })
  const push = (s: Stored, isAdmin: boolean, text: string) => {
    if (s.ticket.status === 'closed') throw new TicketApiError('ticket_closed', 'This ticket is closed.')
    s.messages.push({ id: `mock-msg-${++seq}`, isAdmin, text, createdAt: iso() })
    s.ticket.status = isAdmin ? 'answered' : 'open'
    s.ticket.updatedAt = iso()
  }
  const checkText = (text: string): string => {
    const t = text.trim()
    if (t.length < 1 || t.length > 4000) throw new TicketApiError('invalid_input', 'The message must be 1 to 4000 characters.')
    return t
  }
  return {
    create(owner: string, input: NewTicketInput): Ticket {
      const subject = input.subject.trim()
      if (subject.length < 3 || subject.length > 120) throw new TicketApiError('invalid_input', 'The subject must be 3 to 120 characters.')
      const message = checkText(input.message)
      if (store.filter((s) => s.owner === owner && (s.ticket.status === 'open' || s.ticket.status === 'answered')).length >= 5) {
        throw new TicketApiError('too_many_open_tickets', 'You have too many open tickets. Please wait for an answer.')
      }
      const t: Stored = {
        owner, messages: [],
        ticket: {
          id: `mock-ticket-${++seq}`, subject, status: 'open', createdAt: iso(), updatedAt: iso(),
          order: input.orderId ? { id: input.orderId, status: 'submitted', quantity: 0, chargeAmount: 0, serviceName: 'Demo order' } : null,
        },
      }
      store.unshift(t)
      push(t, false, message)
      return view(t)
    },
    listMine(owner: string): Ticket[] {
      return store.filter((s) => s.owner === owner).sort((a, b) => b.ticket.updatedAt.localeCompare(a.ticket.updatedAt))
        .map((s) => ({ ...view(s, false), lastMessage: s.messages.at(-1)?.text ?? null, lastFromSupport: s.messages.at(-1)?.isAdmin ?? null }))
    },
    get(owner: string, id: string): Ticket {
      return view(find(id, owner))
    },
    addMessage(owner: string, id: string, text: string): Ticket {
      const s = find(id, owner)
      push(s, false, checkText(text))
      return view(s)
    },
    // ---- admin ----
    adminList(status: TicketStatus | null): { counts: Record<TicketStatus, number>; tickets: Ticket[] } {
      const counts = { open: 0, answered: 0, resolved: 0, closed: 0 }
      for (const s of store) counts[s.ticket.status]++
      const rows = store.filter((s) => status === null || s.ticket.status === status)
      rows.sort((a, b) => {
        const au = a.ticket.status === 'open' ? 0 : 1
        const bu = b.ticket.status === 'open' ? 0 : 1
        if (au !== bu) return au - bu
        return au === 0 ? a.ticket.updatedAt.localeCompare(b.ticket.updatedAt) : b.ticket.updatedAt.localeCompare(a.ticket.updatedAt)
      })
      return {
        counts,
        tickets: rows.map((s) => ({ ...view(s, false), user: { id: s.owner, firstName: 'Demo', username: 'dev_user' }, lastMessage: s.messages.at(-1)?.text ?? null })),
      }
    },
    adminGet(id: string): Ticket {
      const s = find(id)
      return { ...view(s), user: { id: s.owner, firstName: 'Demo', username: 'dev_user' } }
    },
    adminReply(id: string, text: string): Ticket {
      const s = find(id)
      push(s, true, checkText(text))
      return view(s)
    },
    adminSetStatus(id: string, status: 'resolved' | 'closed'): Ticket {
      const s = find(id)
      if (s.ticket.status === 'closed') throw new TicketApiError('ticket_closed', 'This ticket is closed.')
      s.ticket.status = status
      s.ticket.updatedAt = iso()
      return view(s)
    },
  }
}

let store: ReturnType<typeof createMockTickets> | undefined
export const mockTickets = () => (store ??= createMockTickets())
