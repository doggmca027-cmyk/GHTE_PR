import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canReply, checkMessage, checkSubject, defaultSubjectFor, orderOptionLabel, statusMeta } from '../src/lib/ticket-view'
import { createMockTickets } from '../src/services/api/mock-tickets'
import { TicketApiError, ticketErrorFrom } from '../src/services/api/ticket-errors'
import type { AuthSession } from '../src/services/api/auth'
import type { Ticket } from '../src/types/tickets'

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: '3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12', subject: 'Order stuck', status: 'open', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:05:00Z', order: null,
  messages: [
    { id: 'm1', isAdmin: false, text: 'My order has not moved', createdAt: '2026-10-01T10:00:00Z' },
    { id: 'm2', isAdmin: true, text: 'We are checking <b>now</b>', createdAt: '2026-10-01T10:04:00Z' },
  ], ...over,
})

const render = async (pick: (m: { TicketThread: any; StatusPill: any; TicketGroup: any; TicketQueue: any; NewTicketModal: any }) => [unknown, Record<string, unknown>]) => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const thread = await import('../src/components/support/TicketThread')
  const screen = await import('../src/components/support/SupportScreen')
  const tab = await import('../src/components/admin/SupportTab')
  const modal = await import('../src/components/support/NewTicketModal')
  const [c, props] = pick({ TicketThread: thread.TicketThread, StatusPill: thread.StatusPill, TicketGroup: screen.TicketGroup, TicketQueue: tab.TicketQueue, NewTicketModal: modal.NewTicketModal })
  return renderToStaticMarkup(createElement(c as never, props))
}

const customerSession = (isMock = true, admin = false): AuthSession => ({ token: 'jwt', expiresAt: 0, isMock, wallet: { balance: 0, currency: 'USD' }, user: { id: 'cust-1', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: admin } })

describe('view rules', () => {
  it('statuses read differently for the customer and for support', () => {
    expect(statusMeta('open').label).toBe('Waiting for support')
    expect(statusMeta('open', 'admin').label).toBe('Needs reply')
    expect(statusMeta('answered').label).toBe('Support replied')
    expect(statusMeta('answered', 'admin').label).toBe('Answered')
    expect(statusMeta('closed').label).toBe('Closed')
  })

  it('only a closed ticket takes no more messages', () => {
    expect(['open', 'answered', 'resolved'].every((s) => canReply(s as never))).toBe(true)
    expect(canReply('closed')).toBe(false)
  })

  it('subject and message limits match the server', () => {
    expect(checkSubject('ab')).toMatch(/at least 3/)
    expect(checkSubject('   abc   ')).toBeNull()
    expect(checkSubject('x'.repeat(121))).toMatch(/under 120/)
    expect(checkMessage('   ')).toBe('Write a message.')
    expect(checkMessage('x'.repeat(4001))).toMatch(/under 4,000/)
    expect(checkMessage('ok')).toBeNull()
  })

  it('names orders in the picker and suggests a subject for "Report an issue"', () => {
    expect(orderOptionLabel({ id: 'abcdef123456', serviceName: 'Telegram Views', quantity: 1000, createdAt: '2026-05-09T10:00:00Z' })).toBe('Telegram Views · 1,000 · 05-09 · #abcdef')
    expect(defaultSubjectFor({ serviceName: 'Telegram Views' })).toBe('Problem with my order: Telegram Views')
    expect(defaultSubjectFor(null)).toBe('')
    expect(defaultSubjectFor({ serviceName: 'x'.repeat(300) }).length).toBe(120)
  })
})

describe('TicketThread', () => {
  const view = (t: Ticket, viewer: 'customer' | 'admin') => render((m) => [m.TicketThread, { ticket: t, viewer, onSend: async () => {}, onBack: () => {} }])

  it('customer view: their messages are on the right as "You", support on the left as "Support", with a reply box', async () => {
    const html = await view(ticket(), 'customer')
    for (const text of ['Order stuck', 'Waiting for support', 'My order has not moved', 'You · ', 'Support · ', 'aria-label="Back to tickets"', 'placeholder="Write a message…"', 'Send']) expect(html).toContain(text)
    expect(html.indexOf('<li class="flex flex-col items-end"')).toBeGreaterThan(-1)
    expect(html.indexOf('<li class="flex flex-col items-end"')).toBeLessThan(html.indexOf('<li class="flex flex-col items-start"')) // the customer\'s bubble first, on the right
  })

  it('admin view: roles flip, the customer is named, and the status reads "Needs reply"', async () => {
    const html = await view(ticket({ user: { id: 'u', firstName: 'Anna', username: 'anna_s' } }), 'admin')
    expect(html).toContain('Needs reply')
    expect(html).toContain('Anna · @anna_s')
    expect(html).toContain('Customer · ')
    expect(html).toContain('placeholder="Reply to the customer…"')
  })

  it('message text is escaped (HTML in a ticket never becomes markup)', async () => {
    const html = await view(ticket(), 'customer')
    expect(html).not.toContain('<b>now</b>')
    expect(html).toContain('&lt;b&gt;now&lt;/b&gt;')
  })

  it('shows the order the ticket is about', async () => {
    const html = await view(ticket({ order: { id: 'abcdef12-3456', status: 'completed', quantity: 1000, chargeAmount: 4, serviceName: 'Telegram Views' } }), 'customer')
    expect(html).toContain('About order')
    expect(html).toContain('#abcdef12')
    expect(html).toContain('Telegram Views')
    expect(html).toContain('$4.00')
  })

  it('a closed ticket has no reply box, only a notice', async () => {
    const html = await view(ticket({ status: 'closed' }), 'customer')
    expect(html).not.toContain('<textarea')
    expect(html).toContain('This ticket is closed')
  })

  it('the header can carry the admin actions', async () => {
    const html = await render((m) => [m.TicketThread, { ticket: ticket(), viewer: 'admin', onSend: async () => {}, actions: 'ACTIONS-HERE' }])
    expect(html).toContain('ACTIONS-HERE')
  })
})

describe('lists', () => {
  const list = (tickets: Ticket[]) => render((m) => [m.TicketGroup, { title: 'Active', tickets, onOpen: () => {} }])

  it('customer list: subject, status pill, preview of the last message (prefixed when support wrote it), order and age', async () => {
    const html = await list([ticket({ lastMessage: 'Fixed, please check', lastFromSupport: true, status: 'answered', order: { id: 'abcdef12-3456', status: 'completed', quantity: 1, chargeAmount: 1, serviceName: null } })])
    for (const text of ['Order stuck', 'Support replied', 'Support: Fixed, please check', 'Order #abcdef12', 'updated']) expect(html).toContain(text)
  })

  it('admin queue: customers named, waiting tickets flagged and "waiting" instead of "updated"', async () => {
    const html = await render((m) => [m.TicketQueue, { tickets: [ticket({ lastMessage: 'help', user: { id: 'u', firstName: 'Anna', username: null } }), ticket({ id: 'x2', status: 'answered' })], onOpen: () => {} }])
    expect(html).toContain('Needs reply')
    expect(html).toContain('border-rose-200')
    expect(html).toContain('Anna')
    expect(html).toContain('ждёт ')
    expect(html).toContain('Answered')
  })
})

describe('NewTicketModal', () => {
  it('has the order picker (optional), subject and message, and a submit button', async () => {
    const html = await render((m) => [m.NewTicketModal, { session: customerSession(), onClose: () => {}, onCreate: async () => {} }])
    for (const text of ['Report an issue', 'Not about a specific order', 'Subject', 'Message', 'Send to support', 'role="dialog"', '(optional)']) expect(html).toContain(text)
  })

  it('"Report an issue" on an order preselects that order, even before the order list has loaded', async () => {
    const html = await render((m) => [m.NewTicketModal, { session: customerSession(), orderId: 'abcdef12-3456-7890', onClose: () => {}, onCreate: async () => {} }])
    expect(html).toMatch(/<option value="abcdef12-3456-7890"[^>]*selected[^>]*>Order #abcdef12<\/option>/)
  })
})

describe('Order history: "Report an issue"', () => {
  const order = { id: 'o1', serviceName: 'Views', platform: 'telegram', targetUrl: 'https://t.me/x', quantity: 100, chargeAmount: 1, status: 'in_progress', remains: 50, startCount: null, refundedAmount: 0, createdAt: '2026-10-01T10:00:00Z' }
  const card = async (onReportIssue?: () => void) => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { OrderCard } = await import('../src/components/orders/OrderCard')
    return renderToStaticMarkup(createElement(OrderCard, { order: order as never, onReportIssue }))
  }

  it('the card offers the button when the screen supports it, and not otherwise', async () => {
    expect(await card(() => {})).toContain('Report an issue')
    expect(await card()).not.toContain('Report an issue')
  })

  it('the header has a Support button and the tab is wired from the orders screen (source check)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')
    expect(read('src/components/layout/Header.tsx')).toContain("aria-label={t('Support')}")
    expect(read('src/App.tsx')).toMatch(/setSupportRequest\(\{ orderId: order\.id \}\); setTab\('support'\)/)
    expect(read('src/components/admin/AdminScreen.tsx')).toContain("label: 'Поддержка'")
  })
})

// ---------------------------------------------------------------------------
// The dev mock follows the database's rules
// ---------------------------------------------------------------------------
describe('mock tickets', () => {
  it('owner-only reads, replies move the status, closed is final', () => {
    let t = 0
    const m = createMockTickets(() => (t += 1000))
    const a = m.create('alice', { subject: 'Order stuck', message: 'help', orderId: 'o1' })
    expect(a).toMatchObject({ status: 'open', order: { id: 'o1' } })
    expect(() => m.get('bob', a.id)).toThrow(TicketApiError)
    expect(() => m.addMessage('bob', a.id, 'hi')).toThrow(/not found/)
    expect(m.adminReply(a.id, 'We are on it').status).toBe('answered')
    expect(m.addMessage('alice', a.id, 'thanks').status).toBe('open')
    expect(m.adminSetStatus(a.id, 'resolved').status).toBe('resolved')
    expect(m.addMessage('alice', a.id, 'not solved').status).toBe('open')
    m.adminSetStatus(a.id, 'closed')
    expect(() => m.addMessage('alice', a.id, 'hello?')).toThrow(/closed/)
    expect(() => m.adminReply(a.id, 'x')).toThrow(/closed/)
    expect(() => m.adminSetStatus(a.id, 'resolved')).toThrow(/closed/)
  })

  it('the admin queue lists waiting tickets first, oldest first; counts per status', () => {
    let t = 0
    const m = createMockTickets(() => (t += 1000))
    const first = m.create('alice', { subject: 'First one', message: 'a' })
    const second = m.create('bob', { subject: 'Second one', message: 'b' })
    const third = m.create('alice', { subject: 'Third one', message: 'c' })
    m.adminReply(third.id, 'done')
    const list = m.adminList(null)
    expect(list.tickets.map((x) => x.id)).toEqual([first.id, second.id, third.id])
    expect(list.counts).toEqual({ open: 2, answered: 1, resolved: 0, closed: 0 })
    expect(m.adminList('answered').tickets.map((x) => x.id)).toEqual([third.id])
  })

  it('validates text and caps open tickets', () => {
    const m = createMockTickets()
    expect(() => m.create('a', { subject: 'ab', message: 'x' })).toThrow(/subject/)
    expect(() => m.create('a', { subject: 'Valid subject', message: '  ' })).toThrow(/message/)
    for (let i = 0; i < 5; i++) m.create('a', { subject: `Problem ${i}`, message: 'x' })
    expect(() => m.create('a', { subject: 'Problem 6', message: 'x' })).toThrow(/too many open tickets/)
    expect(m.create('b', { subject: 'Other user', message: 'x' }).status).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------
describe('ticket clients', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

  it('the customer client posts to user-tickets with the JWT and never sends a user id', async () => {
    reply(201, { success: true, ticket: ticket() })
    const { createTicket } = await import('../src/services/api/tickets')
    await createTicket(customerSession(false), { subject: 'Order stuck', message: 'help', orderId: 'o-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/user-tickets')
    expect(init.headers.Authorization).toBe('Bearer jwt')
    expect(JSON.parse(init.body)).toEqual({ action: 'create_ticket', subject: 'Order stuck', message: 'help', orderId: 'o-1' })
  })

  it('list / get / add_message use their own actions', async () => {
    const { listMyTickets, getTicket, addTicketMessage } = await import('../src/services/api/tickets')
    reply(200, { success: true, tickets: [ticket()] })
    expect(await listMyTickets(customerSession(false))).toHaveLength(1)
    reply(200, { success: true, ticket: ticket() })
    await getTicket(customerSession(false), 't1')
    reply(200, { success: true, ticket: ticket() })
    await addTicketMessage(customerSession(false), 't1', 'more')
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).action)).toEqual(['list_my_tickets', 'get_ticket', 'add_message'])
  })

  it('the admin client posts to admin-tickets; a regular user gets the server\'s 403 as "forbidden"', async () => {
    const { adminListTickets, adminReply, adminSetTicketStatus } = await import('../src/services/api/admin-tickets')
    reply(200, { success: true, counts: { open: 1, answered: 0, resolved: 0, closed: 0 }, tickets: [] })
    await adminListTickets(customerSession(false, true), 'open')
    reply(200, { success: true, ticket: ticket() })
    await adminReply(customerSession(false, true), 't1', 'hi')
    reply(200, { success: true, ticket: ticket() })
    await adminSetTicketStatus(customerSession(false, true), 't1', 'closed')
    expect(fetchMock.mock.calls.map((c) => [c[0].split('/').pop(), JSON.parse(c[1].body).action])).toEqual([['admin-tickets', 'list_all_tickets'], ['admin-tickets', 'reply_to_ticket'], ['admin-tickets', 'close_ticket']])
    reply(403, { success: false, error: 'forbidden', message: 'Admin access required.' })
    await expect(adminListTickets(customerSession(false, false), null)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('maps server errors to typed errors with the server\'s safe message; failures to network / server', async () => {
    const { getTicket } = await import('../src/services/api/tickets')
    reply(404, { success: false, error: 'ticket_not_found', message: 'Ticket not found.' })
    await expect(getTicket(customerSession(false), 't')).rejects.toMatchObject({ code: 'ticket_not_found', message: 'Ticket not found.' })
    reply(409, { success: false, error: 'ticket_closed', message: 'This ticket is closed.' })
    await expect(getTicket(customerSession(false), 't')).rejects.toMatchObject({ code: 'ticket_closed' })
    reply(500, { success: false })
    await expect(getTicket(customerSession(false), 't')).rejects.toMatchObject({ code: 'server' })
    fetchMock.mockRejectedValueOnce(new TypeError('failed'))
    await expect(getTicket(customerSession(false), 't')).rejects.toMatchObject({ code: 'network' })
    expect(ticketErrorFrom(401, null).code).toBe('unauthorized')
  })

  it('dev mock: the admin tab is refused for a non-admin', async () => {
    const { adminListTickets } = await import('../src/services/api/admin-tickets')
    await expect(adminListTickets(customerSession(true, false), null)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(adminListTickets(customerSession(true, true), null)).resolves.toMatchObject({ counts: expect.any(Object) })
  })
})
