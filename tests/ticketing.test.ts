import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { handleAdminTickets, handleUserTickets, mapTicketError, parseAdminRequest, parseUserRequest, toTicketDto } from '../supabase/functions/_shared/tickets'
import { buildMessage } from '../supabase/functions/_shared/telegram-notify'

const U1 = '00000000-0000-4000-8000-000000000001'
const T1 = '00000000-0000-4000-8000-0000000000a1'

describe('request parsing', () => {
  it('customer: every action is validated, ids are UUIDs, the text is trimmed and bounded', () => {
    expect(parseUserRequest({ action: 'create_ticket', subject: ' Order stuck ', message: ' help ', orderId: T1.toUpperCase() })).toEqual({ action: 'create_ticket', subject: 'Order stuck', message: 'help', orderId: T1 })
    expect(parseUserRequest({ action: 'create_ticket', subject: 'Order stuck', message: 'help' })).toMatchObject({ orderId: null })
    for (const bad of [
      { action: 'create_ticket', subject: 'ab', message: 'x' }, { action: 'create_ticket', subject: 'a'.repeat(121), message: 'x' }, { action: 'create_ticket', subject: 'Order stuck', message: '   ' },
      { action: 'create_ticket', subject: 'Order stuck', message: 'x'.repeat(4001) }, { action: 'create_ticket', subject: 'Order stuck', message: 'x', orderId: 'nope' },
      { action: 'create_ticket', subject: 5, message: 'x' }, { action: 'get_ticket', ticketId: 'x' }, { action: 'add_message', ticketId: T1 }, { action: 'list_my_tickets', limit: 0 },
      { action: 'list_my_tickets', limit: 101 }, { action: 'list_my_tickets', offset: -1 }, null, [], 5,
    ]) expect(parseUserRequest(bad)).toHaveProperty('error')
    expect(parseUserRequest({ action: 'LIST_MY_TICKETS' })).toEqual({ action: 'list_my_tickets', limit: 30, offset: 0 })
  })

  it('the admin actions do not exist for a customer, and the customer actions do not exist for the admin function', () => {
    for (const a of ['list_all_tickets', 'reply_to_ticket', 'close_ticket', 'resolve_ticket']) expect(parseUserRequest({ action: a, ticketId: T1, message: 'x' })).toEqual({ error: 'Unknown action.' })
    for (const a of ['create_ticket', 'list_my_tickets', 'add_message']) expect(parseAdminRequest({ action: a, ticketId: T1, message: 'x', subject: 'abc' })).toEqual({ error: 'Unknown action.' })
  })

  it('admin: status filter and ids are validated', () => {
    expect(parseAdminRequest({ action: 'list_all_tickets' })).toEqual({ action: 'list_all_tickets', status: null, limit: 50, offset: 0 })
    expect(parseAdminRequest({ action: 'list_all_tickets', status: 'open' })).toMatchObject({ status: 'open' })
    expect(parseAdminRequest({ action: 'list_all_tickets', status: 'pending' })).toHaveProperty('error')
    expect(parseAdminRequest({ action: 'reply_to_ticket', ticketId: T1, message: ' ok ' })).toEqual({ action: 'reply_to_ticket', ticketId: T1, message: 'ok' })
    expect(parseAdminRequest({ action: 'close_ticket', ticketId: 'x' })).toHaveProperty('error')
    expect(parseAdminRequest({ action: 'reply_to_ticket', ticketId: T1, message: '' })).toHaveProperty('error')
  })
})

describe('error mapping and DTO', () => {
  it('business errors have their own status, anything else is a plain 500', () => {
    expect(mapTicketError('ticket_not_found').status).toBe(404)
    expect(mapTicketError('order_not_found: x').status).toBe(404)
    expect(mapTicketError('ticket_closed: x').status).toBe(409)
    expect(mapTicketError('too_many_open_tickets: x').status).toBe(429)
    expect(mapTicketError('rate_limited: x').status).toBe(429)
    expect(mapTicketError('forbidden: actor is not an admin').status).toBe(403)
    expect(mapTicketError('invalid_parameter_value: the subject must be 3 to 120 characters')).toMatchObject({ status: 400, message: 'the subject must be 3 to 120 characters' })
    expect(mapTicketError('connection refused 10.0.0.5')).toMatchObject({ status: 500, error: 'server_error' })
  })

  it('maps the SQL json to camelCase and survives garbage', () => {
    const dto = toTicketDto({ id: 't', subject: 's', status: 'open', created_at: 'a', updated_at: 'b', order: { id: 'o', status: 'completed', quantity: '10', charge_amount: '0.5', service_name: 'V' },
      messages: [{ id: 'm1', is_admin: true, text: 'hi', created_at: 'c' }, null, 5], user: { id: 'u', first_name: 'A', username: null } })
    expect(dto).toMatchObject({ order: { quantity: 10, chargeAmount: 0.5, serviceName: 'V' }, messages: [{ id: 'm1', isAdmin: true, text: 'hi' }], user: { firstName: 'A', username: null } })
    expect(() => toTicketDto({ id: 't', subject: 's', status: 'open', created_at: 'a', updated_at: 'b', messages: 'nope' })).not.toThrow()
  })
})

describe('customer handler: the caller is the JWT user', () => {
  const ticketRow = { id: T1, subject: 's', status: 'open', created_at: 'a', updated_at: 'b' }
  const ok = (data: unknown) => Promise.resolve({ data, error: null })

  it('uses the verified user id and ignores any user id in the body', async () => {
    const rpc = vi.fn(() => ok(ticketRow))
    const r = await handleUserTickets(U1, { action: 'get_ticket', ticketId: T1, userId: 'someone-else', user_id: 'x', p_user_id: 'y' }, { rpc })
    expect(r.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('support_get_ticket', { p_user_id: U1, p_ticket_id: T1 })
  })

  it('create / add_message / list all pass the JWT user to SQL; create answers 201', async () => {
    const rpc = vi.fn((fn: string) => ok(fn === 'support_list_my_tickets' ? [ticketRow] : ticketRow))
    expect((await handleUserTickets(U1, { action: 'create_ticket', subject: 'Order stuck', message: 'help', orderId: T1 }, { rpc })).status).toBe(201)
    expect(rpc).toHaveBeenLastCalledWith('support_create_ticket', { p_user_id: U1, p_subject: 'Order stuck', p_message: 'help', p_order_id: T1 })
    await handleUserTickets(U1, { action: 'add_message', ticketId: T1, message: 'more' }, { rpc })
    expect(rpc).toHaveBeenLastCalledWith('support_add_message', { p_user_id: U1, p_ticket_id: T1, p_text: 'more' })
    const list = await handleUserTickets(U1, { action: 'list_my_tickets' }, { rpc })
    expect(rpc).toHaveBeenLastCalledWith('support_list_my_tickets', { p_user_id: U1, p_limit: 30, p_offset: 0 })
    expect(list.body).toMatchObject({ success: true, tickets: [{ id: T1 }] })
  })

  it('a customer naming an admin action gets "unknown action" and no database call', async () => {
    const rpc = vi.fn(() => ok({}))
    for (const action of ['list_all_tickets', 'reply_to_ticket', 'close_ticket', 'resolve_ticket', 'admin_support_reply']) {
      const r = await handleUserTickets(U1, { action, ticketId: T1, message: 'x' }, { rpc })
      expect(r).toMatchObject({ status: 400, body: { error: 'invalid_input' } })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('someone else\'s ticket is a plain 404; database errors never leak', async () => {
    const notMine = await handleUserTickets(U1, { action: 'get_ticket', ticketId: T1 }, { rpc: async () => ({ data: null, error: { message: 'ticket_not_found' } }) })
    expect(notMine).toMatchObject({ status: 404, body: { error: 'ticket_not_found' } })
    const broken = await handleUserTickets(U1, { action: 'get_ticket', ticketId: T1 }, { rpc: async () => ({ data: null, error: { message: 'relation "x" at 10.0.0.5' } }) })
    expect(broken.status).toBe(500)
    expect(JSON.stringify(broken.body)).not.toContain('10.0.0.5')
    const thrown = await handleUserTickets(U1, { action: 'get_ticket', ticketId: T1 }, { rpc: async () => { throw new Error('boom') } })
    expect(thrown.status).toBe(500)
  })
})

describe('admin handler: 403 before anything else', () => {
  const ok = (data: unknown) => Promise.resolve({ data, error: null })
  const ticket = { id: T1, subject: 'Order stuck', status: 'answered', created_at: 'a', updated_at: 'b', user_id: U1, message_id: 'm9' }

  it('a regular user gets 403 for every action, and the database is never touched', async () => {
    const rpc = vi.fn(() => ok({}))
    const adminCheck = vi.fn(async () => false)
    for (const body of [{ action: 'list_all_tickets' }, { action: 'get_ticket', ticketId: T1 }, { action: 'reply_to_ticket', ticketId: T1, message: 'x' }, { action: 'close_ticket', ticketId: T1 }, { action: 'garbage' }, null]) {
      const r = await handleAdminTickets(body, { adminCheck, rpc, actorId: U1 })
      expect(r).toMatchObject({ status: 403, body: { success: false, error: 'forbidden' } })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('if the role lookup fails nobody gets in (500, no query)', async () => {
    const rpc = vi.fn(() => ok({}))
    expect((await handleAdminTickets({ action: 'list_all_tickets' }, { adminCheck: async () => { throw new Error('db') }, rpc, actorId: U1 })).status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('an admin: the list carries counts for every status; actions go to the admin SQL functions with the admin as actor', async () => {
    const rpc = vi.fn((fn: string) => ok(fn === 'admin_support_list' ? { counts: { open: 2, answered: 1 }, tickets: [ticket] } : ticket))
    const deps = { adminCheck: async () => true, rpc, actorId: 'admin-1' }
    const list = await handleAdminTickets({ action: 'list_all_tickets', status: 'open' }, deps)
    expect(rpc).toHaveBeenLastCalledWith('admin_support_list', { p_actor: 'admin-1', p_status: 'open', p_limit: 50, p_offset: 0 })
    expect(list.body).toMatchObject({ counts: { open: 2, answered: 1, resolved: 0, closed: 0 }, tickets: [{ id: T1 }] })
    await handleAdminTickets({ action: 'close_ticket', ticketId: T1 }, deps)
    expect(rpc).toHaveBeenLastCalledWith('admin_support_set_status', { p_actor: 'admin-1', p_ticket_id: T1, p_status: 'closed' })
    await handleAdminTickets({ action: 'resolve_ticket', ticketId: T1 }, deps)
    expect(rpc).toHaveBeenLastCalledWith('admin_support_set_status', { p_actor: 'admin-1', p_ticket_id: T1, p_status: 'resolved' })
    expect((await handleAdminTickets({ action: 'list_all_tickets', status: 'bogus' }, deps)).status).toBe(400)
  })

  it('a reply tells the customer afterwards; a failing notification never changes the answer', async () => {
    const afterReply = vi.fn(async () => { throw new Error('telegram down') })
    const r = await handleAdminTickets({ action: 'reply_to_ticket', ticketId: T1, message: ' We fixed it ' }, { adminCheck: async () => true, rpc: async () => ok(ticket), actorId: 'a', afterReply })
    expect(r.status).toBe(200)
    expect(afterReply).toHaveBeenCalledWith({ userId: U1, ticketId: T1, messageId: 'm9', subject: 'Order stuck' })
    // no notification for other actions or failed replies
    const other = vi.fn()
    await handleAdminTickets({ action: 'close_ticket', ticketId: T1 }, { adminCheck: async () => true, rpc: async () => ok(ticket), actorId: 'a', afterReply: other })
    await handleAdminTickets({ action: 'reply_to_ticket', ticketId: T1, message: 'x' }, { adminCheck: async () => true, rpc: async () => ({ data: null, error: { message: 'ticket_closed: x' } }), actorId: 'a', afterReply: other })
    expect(other).not.toHaveBeenCalled()
  })

  it('the two Edge Functions keep their sides of the boundary (source check)', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')
    const user = read('supabase/functions/user-tickets/index.ts')
    const admin = read('supabase/functions/admin-tickets/index.ts')
    expect(user).not.toMatch(/admin_support|handleAdminTickets|is_admin/)
    expect(user).toContain('handleUserTickets(userId, body')
    expect(admin).toContain('handleAdminTickets(body')
    expect(admin).toMatch(/is_admin', true\)\.eq\('is_banned', false\)/)
    expect(admin.indexOf('authenticate(req, jwtSecret)')).toBeLessThan(admin.indexOf('handleAdminTickets('))
  })
})

describe('the Telegram message for a reply', () => {
  it('is bilingual, short and escaped', () => {
    expect(buildMessage({ type: 'ticket_reply', ticketId: 'abcdef12-0000', subject: 'Order <b>stuck</b>' }, 'en')).toMatch(/Support answered your ticket[\s\S]*#abcdef12[\s\S]*Order &lt;b&gt;stuck&lt;\/b&gt;/)
    expect(buildMessage({ type: 'ticket_reply', ticketId: 'abcdef12-0000', subject: 'x y z' }, 'uk')).toContain('Підтримка відповіла')
  })
})

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------
describe('ticketing (SQL)', () => {
  let db: PGlite
  let admin: string, admin2: string, alice: string, bob: string, svc: string
  let n = 0

  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const call = async (sql: string, p: unknown[] = []) => (await db.query<{ r: any }>(`select ${sql} r`, p)).rows[0].r
  const newUser = async (o: { admin?: boolean; banned?: boolean } = {}) =>
    one<string>(`insert into users(telegram_id, first_name, username, is_admin, is_banned) values ($1, $2, $3, $4, $5) returning id v`, [6000 + ++n, `User${n}`, `user${n}`, o.admin ?? false, o.banned ?? false])
  const order = async (user: string) => {
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100::numeric, null, 'fund', $2)`, [user, `fund-${user}-${++n}`])
    const offer = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [svc]))[0]
    return one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, $6)`, [user, svc, offer.id, offer.provider_id, offer.provider_service_id, `k-${++n}`])
  }
  const create = (user: string, subject = 'Order stuck', message = 'Please help', orderId: string | null = null) =>
    call(`support_create_ticket($1::uuid, $2, $3, $4::uuid)`, [user, subject, message, orderId])
  const reply = (actor: string, ticket: string, text = 'We are on it') => call(`admin_support_reply($1::uuid, $2::uuid, $3)`, [actor, ticket, text])
  const status = (ticket: string) => one<string>(`select status::text v from support_tickets where id = $1`, [ticket])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin = await newUser({ admin: true })
    admin2 = await newUser({ admin: true })
    alice = await newUser()
    bob = await newUser()
    const provider = await one<string>(`insert into providers(name, api_url) values ('P', 'https://p.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'Views', 2, 1, 1000000) returning id v`, [provider])
    svc = await one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'Views', $2, 4, 1, 1000000) returning id v`, [cat, ps])
  }, 180_000)

  describe('access', () => {
    it('service role only; the tables have row level security and no client privileges at all', async () => {
      const fns = ['support_create_ticket(uuid, text, text, uuid)', 'support_list_my_tickets(uuid, integer, integer)', 'support_get_ticket(uuid, uuid)', 'support_add_message(uuid, uuid, text)',
        'admin_support_list(uuid, ticket_status, integer, integer)', 'admin_support_get(uuid, uuid)', 'admin_support_reply(uuid, uuid, text)', 'admin_support_set_status(uuid, uuid, ticket_status)']
      for (const fn of fns) {
        const g = (await rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, has_function_privilege('service_role', '${fn}', 'execute') s`))[0]
        expect([g.a, g.u, g.s]).toEqual([false, false, true])
      }
      for (const t of ['support_tickets', 'ticket_messages']) {
        const g = (await rows(`select has_table_privilege('anon', '${t}', 'select') a, has_table_privilege('authenticated', '${t}', 'select') u, has_table_privilege('authenticated', '${t}', 'insert') w, relrowsecurity rls from pg_class where relname = '${t}'`))[0]
        expect([g.a, g.u, g.w, g.rls]).toEqual([false, false, false, true])
      }
    })
  })

  describe('a customer and their tickets', () => {
    it('creates a ticket with its first message; it starts open and can be about one of their own orders', async () => {
      const o = await order(alice)
      const t = await create(alice, ' Order stuck ', ' It has not moved for two days ', o)
      expect(t).toMatchObject({ subject: 'Order stuck', status: 'open', order: { id: o, service_name: 'Views', quantity: 1000 } })
      expect(t.messages).toHaveLength(1)
      expect(t.messages[0]).toMatchObject({ is_admin: false, text: 'It has not moved for two days' })
    })

    it('refuses someone else\'s order and an unknown order with the same answer', async () => {
      const bobsOrder = await order(bob)
      await expect(create(alice, 'Order stuck', 'help', bobsOrder)).rejects.toThrow(/order_not_found/)
      await expect(create(alice, 'Order stuck', 'help', '00000000-0000-4000-8000-0000000000ff')).rejects.toThrow(/order_not_found/)
      expect(await rows(`select 1 from support_tickets where user_id = $1 and subject = 'Order stuck' and order_id = $2`, [alice, bobsOrder])).toEqual([])
    })

    it('validates the text and caps the open tickets (5) and the messages per hour (20)', async () => {
      const u = await newUser()
      await expect(create(u, 'ab', 'x')).rejects.toThrow(/subject must be 3 to 120/)
      await expect(create(u, 'Order stuck', '   ')).rejects.toThrow(/message must be 1 to 4000/)
      await expect(create(u, 'Order stuck', 'x'.repeat(4001))).rejects.toThrow(/message must be 1 to 4000/)
      for (let i = 0; i < 5; i++) await create(u, `Problem ${i}`, 'help')
      await expect(create(u, 'One more', 'help')).rejects.toThrow(/too_many_open_tickets/)
      // an answered ticket still counts as open; a closed one does not
      const first = (await call(`support_list_my_tickets($1::uuid)`, [u]))[0].id
      await call(`admin_support_set_status($1::uuid, $2::uuid, 'closed')`, [admin, first])
      await create(u, 'Now it fits', 'help')

      const chatty = await newUser()
      const t = await create(chatty, 'Chatty', 'one')
      for (let i = 0; i < 19; i++) await call(`support_add_message($1::uuid, $2::uuid, $3)`, [chatty, t.id, `m${i}`])
      await expect(call(`support_add_message($1::uuid, $2::uuid, 'too many')`, [chatty, t.id])).rejects.toThrow(/rate_limited/)
    })

    it('lists only their own tickets, newest activity first, with a preview of the last message', async () => {
      const u = await newUser(), v = await newUser()
      const a = await create(u, 'First ticket', 'first')
      const b = await create(u, 'Second ticket', 'second')
      await create(v, 'Not yours', 'secret')
      await call(`support_add_message($1::uuid, $2::uuid, 'first again')`, [u, a.id])
      const list = await call(`support_list_my_tickets($1::uuid)`, [u])
      expect(list.map((t: any) => t.id)).toEqual([a.id, b.id])
      expect(list[0]).toMatchObject({ last_message: 'first again', last_from_support: false })
      expect(JSON.stringify(list)).not.toContain('secret')
    })
  })

  describe('authorization: a customer cannot reach another customer\'s ticket', () => {
    it('get: someone else\'s ticket answers exactly like one that does not exist', async () => {
      const t = await create(alice, 'Private matter', 'My private details')
      await expect(call(`support_get_ticket($1::uuid, $2::uuid)`, [bob, t.id])).rejects.toThrow(/^ticket_not_found$|ticket_not_found/)
      await expect(call(`support_get_ticket($1::uuid, $2::uuid)`, [bob, '00000000-0000-4000-8000-0000000000ff'])).rejects.toThrow(/ticket_not_found/)
      expect((await call(`support_get_ticket($1::uuid, $2::uuid)`, [alice, t.id])).messages[0].text).toBe('My private details')
    })

    it('add_message: only the owner; nothing is written for anyone else', async () => {
      const t = await create(alice, 'Private matter', 'hello')
      await expect(call(`support_add_message($1::uuid, $2::uuid, 'I am Bob')`, [bob, t.id])).rejects.toThrow(/ticket_not_found/)
      expect(num(await one(`select count(*) v from ticket_messages where ticket_id = $1`, [t.id]))).toBe(1)
    })

    it('the database itself refuses a forged message even when called with the right ticket id', async () => {
      const t = await create(alice, 'Private matter', 'hello')
      // a customer's message must come from the ticket owner
      await expect(db.query(`insert into ticket_messages(ticket_id, sender_id, is_admin, message_text) values ($1, $2, false, 'forged')`, [t.id, bob])).rejects.toThrow(/only the ticket owner/)
      // a support message must come from an admin
      await expect(db.query(`insert into ticket_messages(ticket_id, sender_id, is_admin, message_text) values ($1, $2, true, 'I am support')`, [t.id, bob])).rejects.toThrow(/only an admin/)
      await expect(db.query(`insert into ticket_messages(ticket_id, sender_id, is_admin, message_text) values ($1, $2, true, 'I am support')`, [t.id, alice])).rejects.toThrow(/only an admin/)
    })

    it('the customer functions never accept an admin action: a regular user cannot reply, list all or close', async () => {
      const t = await create(alice, 'Private matter', 'hello')
      await expect(reply(bob, t.id)).rejects.toThrow(/forbidden/)
      await expect(reply(alice, t.id)).rejects.toThrow(/forbidden/)
      await expect(call(`admin_support_list($1::uuid)`, [alice])).rejects.toThrow(/forbidden/)
      await expect(call(`admin_support_get($1::uuid, $2::uuid)`, [alice, t.id])).rejects.toThrow(/forbidden/)
      await expect(call(`admin_support_set_status($1::uuid, $2::uuid, 'closed')`, [alice, t.id])).rejects.toThrow(/forbidden/)
      expect(await status(t.id)).toBe('open')
    })

    it('a banned admin is not an admin', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const banned = await newUser({ admin: true, banned: true })
      const t = await create(alice, 'Private matter', 'hello')
      await expect(reply(banned, t.id)).rejects.toThrow(/forbidden/)
      await expect(call(`admin_support_list($1::uuid)`, [banned])).rejects.toThrow(/forbidden/)
    })
  })

  describe('status triggers', () => {
    it('open -> (support replies) answered -> (customer writes) open', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Status flow', 'hello')
      expect(await status(t.id)).toBe('open')
      expect((await reply(admin, t.id)).status).toBe('answered')
      expect(await status(t.id)).toBe('answered')
      await call(`support_add_message($1::uuid, $2::uuid, 'thanks, but still broken')`, [alice, t.id])
      expect(await status(t.id)).toBe('open')
    })

    it('updated_at moves with every message and status change', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Clock', 'hello')
      const t0 = await one<string>(`select updated_at::text v from support_tickets where id = $1`, [t.id])
      await db.query(`select pg_sleep(0.02)`)
      await reply(admin, t.id)
      const t1 = await one<string>(`select updated_at::text v from support_tickets where id = $1`, [t.id])
      expect(t1 > t0).toBe(true)
      await db.query(`select pg_sleep(0.02)`)
      await call(`admin_support_set_status($1::uuid, $2::uuid, 'resolved')`, [admin, t.id])
      expect((await one<string>(`select updated_at::text v from support_tickets where id = $1`, [t.id])) > t1).toBe(true)
    })

    it('resolved: a customer reply reopens it; closed: final for everyone', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Reopen', 'hello')
      await call(`admin_support_set_status($1::uuid, $2::uuid, 'resolved')`, [admin, t.id])
      expect(await status(t.id)).toBe('resolved')
      await call(`support_add_message($1::uuid, $2::uuid, 'not solved after all')`, [alice, t.id])
      expect(await status(t.id)).toBe('open')

      await call(`admin_support_set_status($1::uuid, $2::uuid, 'closed')`, [admin, t.id])
      await expect(call(`support_add_message($1::uuid, $2::uuid, 'hello?')`, [alice, t.id])).rejects.toThrow(/ticket_closed/)
      await expect(reply(admin, t.id)).rejects.toThrow(/ticket_closed/)
      await expect(call(`admin_support_set_status($1::uuid, $2::uuid, 'resolved')`, [admin, t.id])).rejects.toThrow(/ticket_closed/)
      await expect(db.query(`update support_tickets set status = 'open' where id = $1`, [t.id])).rejects.toThrow(/cannot be reopened/)
      await expect(db.query(`insert into ticket_messages(ticket_id, sender_id, is_admin, message_text) values ($1, $2, false, 'sneaky')`, [t.id, alice])).rejects.toThrow(/ticket_closed/)
    })

    it('who owns a ticket, what it is about and its subject never change; messages are append-only', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Frozen', 'hello')
      await expect(db.query(`update support_tickets set user_id = $2 where id = $1`, [t.id, bob])).rejects.toThrow(/cannot change/)
      await expect(db.query(`update support_tickets set subject = 'Changed' where id = $1`, [t.id])).rejects.toThrow(/cannot change/)
      await expect(db.query(`update support_tickets set order_id = null, created_at = now() where id = $1`, [t.id])).rejects.toThrow(/cannot change/)
      await expect(db.query(`update ticket_messages set message_text = 'edited'`)).rejects.toThrow(/append-only/)
      await expect(db.query(`delete from ticket_messages`)).rejects.toThrow(/append-only/)
      await expect(db.query(`truncate ticket_messages`)).rejects.toThrow(/append-only/)
    })
  })

  describe('admin queue', () => {
    it('open tickets first, the one waiting longest on top; then the rest by latest activity; filter and counts', async () => {
      const fresh = new PGlite()
      void fresh
      const u = await newUser()
      const make = async (subject: string) => (await create(u, subject, 'hello')).id as string
      // use distinct ages by rewriting updated_at after the fact (tickets are the one place a clock can be set back)
      const oldest = await make('Waiting longest')
      const newer = await make('Waiting less')
      const answered = await make('Answered one')
      await reply(admin, answered)
      const resolved = await make('Resolved one')
      await call(`admin_support_set_status($1::uuid, $2::uuid, 'resolved')`, [admin, resolved])
      await db.query(`alter table support_tickets disable trigger trg_tickets_guard`)
      await db.query(`update support_tickets set updated_at = now() - interval '3 hours' where id = $1`, [oldest])
      await db.query(`update support_tickets set updated_at = now() - interval '1 hour' where id = $1`, [newer])
      await db.query(`update support_tickets set updated_at = now() - interval '2 hours' where id = $1`, [answered])
      await db.query(`update support_tickets set updated_at = now() - interval '5 hours' where id = $1`, [resolved])
      await db.query(`alter table support_tickets enable trigger trg_tickets_guard`)

      const all = await call(`admin_support_list($1::uuid, null, 200)`, [admin])
      const mine = all.tickets.filter((t: any) => [oldest, newer, answered, resolved].includes(t.id)).map((t: any) => t.subject)
      expect(mine).toEqual(['Waiting longest', 'Waiting less', 'Answered one', 'Resolved one'])
      expect(all.tickets.find((t: any) => t.id === oldest)).toMatchObject({ user: { id: u }, last_message: 'hello' })

      const openOnly = await call(`admin_support_list($1::uuid, 'open', 200)`, [admin])
      expect(openOnly.tickets.every((t: any) => t.status === 'open')).toBe(true)
      expect(all.counts.open).toBeGreaterThan(0)
      expect(Object.keys(all.counts).every((k) => ['open', 'answered', 'resolved', 'closed'].includes(k))).toBe(true)
    })

    it('get shows the whole conversation and who is asking; any admin can answer', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Two admins', 'hello')
      await reply(admin, t.id, 'First answer')
      const full = await call(`admin_support_reply($1::uuid, $2::uuid, 'Second admin here')`, [admin2, t.id])
      expect(full.messages.map((m: any) => [m.is_admin, m.text])).toEqual([[false, 'hello'], [true, 'First answer'], [true, 'Second admin here']])
      expect(full).toMatchObject({ status: 'answered', user_id: alice, message_id: expect.any(String), subject: 'Two admins' })
      const view = await call(`admin_support_get($1::uuid, $2::uuid)`, [admin, t.id])
      expect(view.user).toMatchObject({ id: alice })
      await expect(call(`admin_support_get($1::uuid, $2::uuid)`, [admin, '00000000-0000-4000-8000-0000000000ff'])).rejects.toThrow(/ticket_not_found/)
    })

    it('replies and status changes are audited without the text of the message; set_status takes only resolved / closed and is idempotent', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Audit me', 'hello')
      await reply(admin, t.id, 'secret answer text')
      await call(`admin_support_set_status($1::uuid, $2::uuid, 'resolved')`, [admin, t.id])
      await call(`admin_support_set_status($1::uuid, $2::uuid, 'resolved')`, [admin, t.id]) // again: no second entry
      await expect(call(`admin_support_set_status($1::uuid, $2::uuid, 'open')`, [admin, t.id])).rejects.toThrow(/resolved or closed/)
      const audit = await rows(`select action, details::text d from admin_audit_log where target_id = $1 order by created_at, id`, [t.id])
      expect(audit.map((a) => a.action)).toEqual(['support_reply', 'support_resolved'])
      expect(JSON.stringify(audit)).not.toContain('secret answer text')
    })

    it('an empty or over-long reply is refused', async () => {      const alice = await newUser() // a fresh customer: the caps are per customer

      const t = await create(alice, 'Bounds', 'hello')
      await expect(reply(admin, t.id, '   ')).rejects.toThrow(/message must be 1 to 4000/)
      await expect(reply(admin, t.id, 'x'.repeat(4001))).rejects.toThrow(/message must be 1 to 4000/)
    })
  })
})

const num = (v: unknown) => Number(v)
