// Supabase Edge Function (Deno): POST /user-tickets   (signed-in customers)
//   Authorization: Bearer <JWT issued by telegram-auth>
//
//   { action: "create_ticket", subject, message, orderId? }  -> 201 { success, ticket }   (orderId must be one of YOUR orders)
//   { action: "list_my_tickets", limit?, offset? }           -> { success, tickets: [{ id, subject, status, order, lastMessage, lastFromSupport, ... }] }
//   { action: "get_ticket", ticketId }                       -> { success, ticket: { ..., messages: [{ id, isAdmin, text, createdAt }] } }
//   { action: "add_message", ticketId, message }             -> { success, ticket }   (reopens an answered / resolved ticket; closed = 409)
//
// The customer is always the JWT's user; a user id in the body is never read, and every SQL function filters by it: someone else's
// ticket is "not found", exactly like one that does not exist. No admin action exists here (see admin-tickets).
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { handleUserTickets } from '../_shared/tickets.ts'

Deno.serve(instrument('user-tickets', async (req: Request, { log }): Promise<Response> => {
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
  try {
    const result = await handleUserTickets(userId, body, {
      rpc: async (fn, args) => {
        const { data, error } = await db.rpc(fn, args)
        if (error && !/not found|not_found|closed|too_many|rate_limited|invalid_parameter/.test(error.message)) {
          log.error('ticket query failed', { err: error, error_code: 'ticket_query_failed', fn })
        }
        return { data, error }
      },
    })
    return json(result.body, result.status)
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
