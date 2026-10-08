// Supabase Edge Function (Deno): POST /admin-tickets   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//
//   { action: "list_all_tickets", status?, limit?, offset? } -> { success, counts: {open, answered, resolved, closed}, tickets }
//        waiting tickets (status open) first, the one waiting longest on top; then the rest, newest activity first
//   { action: "get_ticket", ticketId }                       -> { success, ticket: { ..., user, messages } }
//   { action: "reply_to_ticket", ticketId, message }         -> { success, ticket }   status becomes answered; the customer is told on Telegram
//   { action: "resolve_ticket", ticketId }                   -> { success, ticket }   the customer may still reply and reopen it
//   { action: "close_ticket", ticketId }                     -> { success, ticket }   final
//
// Anyone who is not a signed-in, non-banned admin gets 403 BEFORE anything is queried (the check runs first, in the handler), and
// the SQL functions check the admin role again.
// Secrets: JWT_SECRET, TELEGRAM_BOT_TOKEN. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { createNotifier } from '../_shared/notify-db.ts'
import { fireAndForget } from '../_shared/telegram-notify.ts'
import { handleAdminTickets } from '../_shared/tickets.ts'

Deno.serve(instrument('admin-tickets', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Sign in again.')
  log.bind({ userId })

  const body = await readJson(req, 16_384)
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const notify = createNotifier(db, Deno.env, { info: (m: unknown) => log.info(String(m)), warn: (m: unknown) => log.warn(String(m)) })
  try {
    const result = await handleAdminTickets(body, {
      actorId: userId,
      adminCheck: async () => {
        const { data, error } = await db.from('users').select('id').eq('id', userId).eq('is_admin', true).eq('is_banned', false).maybeSingle()
        if (error) throw new Error(`admin check: ${error.message}`)
        return data !== null
      },
      rpc: async (fn, args) => {
        const { data, error } = await db.rpc(fn, args)
        if (error && !/not found|not_found|closed|invalid_parameter|forbidden/.test(error.message)) {
          log.error('ticket query failed', { err: error, error_code: 'ticket_query_failed', fn })
        }
        return { data, error }
      },
      // The customer hears about the answer on Telegram: after the reply is stored, in the background, deduplicated per message.
      afterReply: ({ userId: customer, ticketId, messageId, subject }) =>
        fireAndForget(notify(customer, { type: 'ticket_reply', ticketId, subject }, `ticket:${messageId}`)),
    })
    return json(result.body, result.status)
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
