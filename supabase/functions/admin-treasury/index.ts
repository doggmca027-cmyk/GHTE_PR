// Supabase Edge Function (Deno): POST /admin-treasury   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action: "GET", limit?, beforeSeq? }
//       -> { success, balance, updatedAt, transactions: [...newest first], nextBefore }  (nextBefore = cursor for the next page, or null)
//   { action: "MANUAL_ADJUSTMENT", amount (signed), description, idempotencyKey }
//       -> books a manual_adjustment through process_treasury_transaction (row lock, no negative balance, audit entry
//          written in the same transaction). Re-sending the same idempotencyKey books it once.
//
// Auth: JWT verified here, then users.is_admin / not banned is re-checked in the database. The treasury tables and the
// ledger function are service-role only; clients can never reach them directly.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, json, readJson } from '../_shared/http.ts'
import { mapTreasuryError, parseTreasuryRequest } from '../_shared/admin-treasury.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const COLUMNS = 'id, seq, type, amount, balance_after, description, reference_id, created_at'

const publicTx = (r: Record<string, unknown>) => ({
  id: String(r.id), seq: Number(r.seq), type: String(r.type), amount: Number(r.amount), balanceAfter: Number(r.balance_after),
  description: (r.description as string | null) ?? null, referenceId: (r.reference_id as string | null) ?? null, createdAt: String(r.created_at),
})

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    console.error('admin-treasury: missing configuration')
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Sign in again.')

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  try {
    const { data: admin, error: adminError } = await db.from('users').select('id').eq('id', userId).eq('is_admin', true).eq('is_banned', false).maybeSingle()
    if (adminError) throw new Error(`admin check: ${adminError.message}`)
    if (!admin) return fail(403, 'forbidden', 'Admin access required.')

    const parsed = parseTreasuryRequest(await readJson(req))
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    if (parsed.action === 'MANUAL_ADJUSTMENT') {
      const { data, error } = await db.rpc('process_treasury_transaction', {
        p_type: 'manual_adjustment',
        p_amount: parsed.amount,
        p_description: parsed.description,
        p_reference_id: `manual:${parsed.idempotencyKey}`,
        p_actor: userId,
      })
      if (error) {
        const m = mapTreasuryError(error.message)
        if (m.status === 500) throw new Error(`treasury transaction: ${error.message}`)
        return fail(m.status, m.error, m.message)
      }
      return json({ success: true, transaction: publicTx(data as Record<string, unknown>) })
    }

    // GET: balance + one page (fetch one extra row to know whether there is a next page).
    const { data: state, error: stateError } = await db.from('treasury_state').select('balance, updated_at').eq('id', 1).single()
    if (stateError) throw new Error(`treasury state: ${stateError.message}`)
    let q = db.from('treasury_transactions').select(COLUMNS).order('seq', { ascending: false }).limit(parsed.limit + 1)
    if (parsed.beforeSeq !== null) q = q.lt('seq', parsed.beforeSeq)
    const { data: rows, error: rowsError } = await q
    if (rowsError) throw new Error(`treasury transactions: ${rowsError.message}`)
    const page = (rows ?? []).slice(0, parsed.limit).map(publicTx)
    const hasMore = (rows ?? []).length > parsed.limit
    return json({
      success: true,
      balance: Number(state.balance),
      updatedAt: String(state.updated_at),
      transactions: page,
      nextBefore: hasMore ? page[page.length - 1].seq : null,
    })
  } catch (e) {
    console.error('admin-treasury failed', e instanceof Error ? e.message : 'unknown')
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
})
