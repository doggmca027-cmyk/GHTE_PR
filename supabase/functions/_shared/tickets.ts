// Support tickets: request parsing, error mapping, response shapes and the two request handlers (customer / admin) with all I/O
// injected, so the authorization boundary is unit-tested without a server.
//
// THE BOUNDARY
//   user-tickets   the caller is the JWT's user. A user id in the body is never read. Every SQL function it calls filters by that
//                  id, so another customer's ticket answers "not found" (the same as a ticket that does not exist).
//   admin-tickets  adminCheck() runs FIRST: for anyone else the answer is 403 and nothing is queried. The SQL functions check the
//                  admin role again. The two functions do not share any action: a customer cannot reach an admin one by naming it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const TICKET_STATUSES = ['open', 'answered', 'resolved', 'closed'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

type Obj = Record<string, unknown>
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const absent = (v: unknown) => v === undefined || v === null || v === ''

function text(b: Obj, key: string, min: number, max: number, label: string): string | { error: string } {
  const v = b[key]
  if (typeof v !== 'string') return { error: `${label} is required.` }
  const t = v.trim()
  if (t.length < min || t.length > max) return { error: `${label} must be ${min} to ${max} characters.` }
  return t
}
function page(b: Obj): { limit: number; offset: number } | { error: string } {
  const limit = absent(b.limit) ? 30 : b.limit
  const offset = absent(b.offset) ? 0 : b.offset
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be a whole number from 1 to 100.' }
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return { error: 'offset must be a whole number from 0 to 100000.' }
  return { limit, offset }
}
const failed = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v

// ---------------------------------------------------------------------------
// Customer requests
// ---------------------------------------------------------------------------
export type UserRequest =
  | { action: 'create_ticket'; subject: string; message: string; orderId: string | null }
  | { action: 'list_my_tickets'; limit: number; offset: number }
  | { action: 'get_ticket'; ticketId: string }
  | { action: 'add_message'; ticketId: string; message: string }

export function parseUserRequest(body: unknown): UserRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toLowerCase() : ''
  if (action === 'create_ticket') {
    const subject = text(b, 'subject', 3, 120, 'subject')
    const message = text(b, 'message', 1, 4000, 'message')
    if (failed(subject)) return subject
    if (failed(message)) return message
    if (!absent(b.orderId) && !isUuid(b.orderId)) return { error: 'orderId must be a UUID.' }
    return { action, subject, message, orderId: absent(b.orderId) ? null : (b.orderId as string).toLowerCase() }
  }
  if (action === 'list_my_tickets') {
    const p = page(b)
    return failed(p) ? p : { action, ...p }
  }
  if (action === 'get_ticket') return isUuid(b.ticketId) ? { action, ticketId: b.ticketId.toLowerCase() } : { error: 'ticketId must be a UUID.' }
  if (action === 'add_message') {
    if (!isUuid(b.ticketId)) return { error: 'ticketId must be a UUID.' }
    const message = text(b, 'message', 1, 4000, 'message')
    return failed(message) ? message : { action, ticketId: b.ticketId.toLowerCase(), message }
  }
  return { error: 'Unknown action.' }
}

// ---------------------------------------------------------------------------
// Admin requests
// ---------------------------------------------------------------------------
export type AdminRequest =
  | { action: 'list_all_tickets'; status: TicketStatus | null; limit: number; offset: number }
  | { action: 'get_ticket'; ticketId: string }
  | { action: 'reply_to_ticket'; ticketId: string; message: string }
  | { action: 'resolve_ticket'; ticketId: string }
  | { action: 'close_ticket'; ticketId: string }

export function parseAdminRequest(body: unknown): AdminRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toLowerCase() : ''
  if (action === 'list_all_tickets') {
    if (!absent(b.status) && !(TICKET_STATUSES as readonly unknown[]).includes(b.status)) return { error: 'status must be open, answered, resolved or closed.' }
    const p = page({ ...b, limit: absent(b.limit) ? 50 : b.limit })
    return failed(p) ? p : { action, status: absent(b.status) ? null : (b.status as TicketStatus), ...p }
  }
  if (action === 'get_ticket' || action === 'resolve_ticket' || action === 'close_ticket') {
    return isUuid(b.ticketId) ? { action, ticketId: b.ticketId.toLowerCase() } : { error: 'ticketId must be a UUID.' }
  }
  if (action === 'reply_to_ticket') {
    if (!isUuid(b.ticketId)) return { error: 'ticketId must be a UUID.' }
    const message = text(b, 'message', 1, 4000, 'message')
    return failed(message) ? message : { action, ticketId: b.ticketId.toLowerCase(), message }
  }
  return { error: 'Unknown action.' }
}

// ---------------------------------------------------------------------------
// Errors and response shapes
// ---------------------------------------------------------------------------
/** A database error (the SQL exception text) -> the HTTP answer. 500 = not a business error (the text is never shown). */
export function mapTicketError(message: string): { status: number; error: string; message: string } {
  if (/^forbidden:|actor is not an admin/.test(message)) return { status: 403, error: 'forbidden', message: 'Admin access required.' }
  if (/ticket_not_found/.test(message)) return { status: 404, error: 'ticket_not_found', message: 'Ticket not found.' }
  if (/order_not_found/.test(message)) return { status: 404, error: 'order_not_found', message: 'That order was not found.' }
  if (/ticket_closed/.test(message)) return { status: 409, error: 'ticket_closed', message: 'This ticket is closed.' }
  if (/too_many_open_tickets/.test(message)) return { status: 429, error: 'too_many_open_tickets', message: 'You have too many open tickets. Please wait for an answer.' }
  if (/rate_limited/.test(message)) return { status: 429, error: 'rate_limited', message: 'Too many messages. Please try again later.' }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: message.replace(/^.*invalid_parameter_value: ?/, '') || 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

const n = (v: unknown) => Number(v ?? 0)
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)) : [])

export interface TicketMessageDto { id: string; isAdmin: boolean; text: string; createdAt: string }
export interface TicketDto {
  id: string
  subject: string
  status: TicketStatus
  createdAt: string
  updatedAt: string
  order: { id: string; status: string; quantity: number; chargeAmount: number; serviceName: string | null } | null
  lastMessage?: string | null
  lastFromSupport?: boolean | null
  user?: { id: string; firstName: string | null; username: string | null }
  messages?: TicketMessageDto[]
}

export function toTicketDto(r: Obj): TicketDto {
  const o = r.order as Obj | null | undefined
  const u = r.user as Obj | null | undefined
  return {
    id: String(r.id), subject: String(r.subject), status: String(r.status) as TicketStatus, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    order: o ? { id: String(o.id), status: String(o.status), quantity: n(o.quantity), chargeAmount: n(o.charge_amount), serviceName: (o.service_name as string | null) ?? null } : null,
    ...('last_message' in r ? { lastMessage: (r.last_message as string | null) ?? null } : {}),
    ...('last_from_support' in r ? { lastFromSupport: (r.last_from_support as boolean | null) ?? null } : {}),
    ...(u ? { user: { id: String(u.id), firstName: (u.first_name as string | null) ?? null, username: (u.username as string | null) ?? null } } : {}),
    ...('messages' in r ? { messages: arr(r.messages).map((m) => ({ id: String(m.id), isAdmin: m.is_admin === true, text: String(m.text), createdAt: String(m.created_at) })) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Handlers (I/O injected)
// ---------------------------------------------------------------------------
type RpcResult = { data: unknown; error: { message: string } | null }
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>
export type HandlerResult = { status: number; body: Record<string, unknown> }

const failure = (status: number, error: string, message: string): HandlerResult => ({ status, body: { success: false, error, message } })

async function call(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<{ data: Obj } | { result: HandlerResult }> {
  let res: RpcResult
  try {
    res = await rpc(fn, args)
  } catch {
    return { result: failure(500, 'server_error', 'Something went wrong. Please try again.') }
  }
  if (res.error) {
    const m = mapTicketError(res.error.message)
    return { result: failure(m.status, m.error, m.message) }
  }
  return { data: res.data as Obj }
}

/** The signed-in customer's own tickets. `userId` is the verified JWT subject; nothing in the body can change it. */
export async function handleUserTickets(userId: string, body: unknown, deps: { rpc: Rpc }): Promise<HandlerResult> {
  const req = parseUserRequest(body)
  if ('error' in req) return failure(400, 'invalid_input', req.error)

  if (req.action === 'list_my_tickets') {
    const r = await call(deps.rpc, 'support_list_my_tickets', { p_user_id: userId, p_limit: req.limit, p_offset: req.offset })
    if ('result' in r) return r.result
    return { status: 200, body: { success: true, tickets: (r.data as unknown as Obj[]).map(toTicketDto) } }
  }
  const r = req.action === 'create_ticket'
    ? await call(deps.rpc, 'support_create_ticket', { p_user_id: userId, p_subject: req.subject, p_message: req.message, p_order_id: req.orderId })
    : req.action === 'get_ticket'
      ? await call(deps.rpc, 'support_get_ticket', { p_user_id: userId, p_ticket_id: req.ticketId })
      : await call(deps.rpc, 'support_add_message', { p_user_id: userId, p_ticket_id: req.ticketId, p_text: req.message })
  if ('result' in r) return r.result
  return { status: req.action === 'create_ticket' ? 201 : 200, body: { success: true, ticket: toTicketDto(r.data) } }
}

export interface AdminTicketDeps {
  /** True only for a signed-in, non-banned admin. Called first. */
  adminCheck: () => Promise<boolean>
  rpc: Rpc
  /** The admin's own user id (from the JWT). */
  actorId: string
  /** Called after a reply was stored. Best effort: its failure never changes the answer. */
  afterReply?: (info: { userId: string; ticketId: string; messageId: string; subject: string }) => Promise<void> | void
}

export async function handleAdminTickets(body: unknown, deps: AdminTicketDeps): Promise<HandlerResult> {
  let isAdmin: boolean
  try {
    isAdmin = await deps.adminCheck()
  } catch {
    return failure(500, 'server_error', 'Something went wrong. Please try again.')
  }
  if (!isAdmin) return failure(403, 'forbidden', 'Admin access required.')

  const req = parseAdminRequest(body)
  if ('error' in req) return failure(400, 'invalid_input', req.error)
  const actor = { p_actor: deps.actorId }

  if (req.action === 'list_all_tickets') {
    const r = await call(deps.rpc, 'admin_support_list', { ...actor, p_status: req.status, p_limit: req.limit, p_offset: req.offset })
    if ('result' in r) return r.result
    const counts = (r.data.counts ?? {}) as Obj
    return {
      status: 200,
      body: { success: true, counts: Object.fromEntries(TICKET_STATUSES.map((s) => [s, n(counts[s])])), tickets: arr(r.data.tickets).map(toTicketDto) },
    }
  }
  const r = req.action === 'get_ticket'
    ? await call(deps.rpc, 'admin_support_get', { ...actor, p_ticket_id: req.ticketId })
    : req.action === 'reply_to_ticket'
      ? await call(deps.rpc, 'admin_support_reply', { ...actor, p_ticket_id: req.ticketId, p_text: req.message })
      : await call(deps.rpc, 'admin_support_set_status', { ...actor, p_ticket_id: req.ticketId, p_status: req.action === 'close_ticket' ? 'closed' : 'resolved' })
  if ('result' in r) return r.result

  if (req.action === 'reply_to_ticket' && deps.afterReply) {
    try {
      await deps.afterReply({ userId: String(r.data.user_id), ticketId: req.ticketId, messageId: String(r.data.message_id), subject: String(r.data.subject) })
    } catch { /* telling the customer is best effort: the reply is already stored */ }
  }
  return { status: 200, body: { success: true, ticket: toTicketDto(r.data) } }
}
