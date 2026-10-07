// Supabase Edge Function (Deno): POST /admin-treasury   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action: "GET", limit?, beforeSeq? }
//       -> { success, balance, updatedAt, transactions: [...newest first], nextBefore }  (nextBefore = cursor for the next page, or null)
//   { action: "APPROVE_PROPOSAL" | "REJECT_PROPOSAL", proposalId }
//       -> approve debits the treasury (provider_topup) and marks the proposal approved in ONE database transaction
//          (approve_topup_proposal); reject only marks it. GET also returns the pending proposals.
//   APPROVE_PROPOSAL also creates the outbound provider payment (Phase 6): limits + reserve + treasury debit in one locked
//   database transaction, then the transfer instruction (PAYMENT_CREATED). No real broadcaster exists yet: in production the
//   admin sends the transfer and records it; in MOCK_MODE a simulated broadcaster takes it to COMPLETED.
//   { action: "RECORD_PAYMENT_BROADCAST", paymentId, txHash, markConfirming? } | { action: "ADVANCE_PAYMENT", paymentId, to }
//   | { action: "FAIL_PAYMENT" | "CANCEL_PAYMENT", paymentId, reason }   (fail / cancel return the money to the treasury)
//   | { action: "CREATE_INSTRUCTION", paymentId }   (VALIDATED -> PAYMENT_CREATED, e.g. after an approval whose second step failed)
//   Every payment action is one guarded SQL transition (the state machine lives in the database, not here).
//   GET also returns minimumReserve and the payments (all in progress + the latest 20), each with the reconciliation
//   detector's live verdict (`issue`, same rules as the cron that opens the cases).
//   { action: "MANUAL_ADJUSTMENT", amount (signed), description, idempotencyKey }
//       -> books a manual_adjustment through process_treasury_transaction (row lock, no negative balance, audit entry
//          written in the same transaction). Re-sending the same idempotencyKey books it once.
//
// Auth: JWT verified here, then users.is_admin / not banned is re-checked in the database. The treasury tables and the
// ledger function are service-role only; clients can never reach them directly.
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapTreasuryError, parseTreasuryRequest, paymentView } from '../_shared/admin-treasury.ts'
import { confirmProviderPayment, executeProviderPayment, mockBroadcastToBlockchain, type PaymentInstruction, type PaymentPorts } from '../_shared/provider-payment-flow.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const COLUMNS = 'id, seq, type, amount, balance_after, description, reference_id, created_at'

const publicTx = (r: Record<string, unknown>) => ({
  id: String(r.id), seq: Number(r.seq), type: String(r.type), amount: Number(r.amount), balanceAfter: Number(r.balance_after),
  description: (r.description as string | null) ?? null, referenceId: (r.reference_id as string | null) ?? null, createdAt: String(r.created_at),
})

Deno.serve(instrument('admin-treasury', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Sign in again.')
  log.bind({ userId })

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

    // Database-backed payment ports (every step a guarded transition in SQL).
    const call = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await db.rpc(fn, args)
      if (error) throw new Error(error.message)
      return data as Record<string, unknown>
    }
    const ports: PaymentPorts = {
      async createInstruction(paymentId) {
        const r = await call('create_provider_payment_instruction', { p_payment_id: paymentId, p_actor: userId })
        if (r.already) {
          const { data } = await db.from('provider_payments').select('destination_wallet, amount, asset, network, idempotency_key').eq('id', paymentId).single()
          Object.assign(r, data)
        }
        return { paymentId, destinationWallet: String(r.destination_wallet), amount: Number(r.amount), asset: String(r.asset), network: String(r.network), idempotencyKey: String(r.idempotency_key) } satisfies PaymentInstruction
      },
      async recordBroadcast(paymentId, txHash) { await call('record_provider_payment_broadcast', { p_payment_id: paymentId, p_tx_hash: txHash, p_actor: userId }) },
      async markUnknown(paymentId, reason) { await call('mark_provider_payment_unknown', { p_payment_id: paymentId, p_reason: reason, p_actor: userId }) },
      async fail(paymentId, reason) { await call('fail_provider_payment', { p_payment_id: paymentId, p_reason: reason, p_actor: userId }) },
      async advance(paymentId, to) { await call('advance_provider_payment', { p_payment_id: paymentId, p_to: to, p_actor: userId }) },
    }
    const businessError = (e: unknown, what: string) => {
      const m = mapTreasuryError(e instanceof Error ? e.message : String(e))
      if (m.status === 500) throw new Error(`${what}: ${e instanceof Error ? e.message : e}`)
      return fail(m.status, m.error, m.message)
    }

    if (parsed.action === 'APPROVE_PROPOSAL' || parsed.action === 'REJECT_PROPOSAL') {
      const fn = parsed.action === 'APPROVE_PROPOSAL' ? 'approve_topup_proposal' : 'reject_topup_proposal'
      let data: Record<string, unknown>
      try {
        data = await call(fn, { p_proposal_id: parsed.proposalId, p_actor: userId })
      } catch (e) {
        return businessError(e, fn)
      }
      if (parsed.action === 'REJECT_PROPOSAL') return json({ success: true, result: data })

      const paymentId = String(data.payment_id)
      if (Deno.env.get('MOCK_MODE') === 'true') {
        // Simulated end to end (no blockchain): broadcast, confirm, verify, complete.
        const sent = await executeProviderPayment(paymentId, ports, mockBroadcastToBlockchain())
        const done = sent.kind === 'broadcasted'
          ? await confirmProviderPayment({ id: paymentId, status: 'BROADCASTED', txHash: sent.txHash }, { chainConfirmed: async () => true, providerBalanceCredited: async () => true }, ports)
          : sent
        return json({ success: true, result: { ...data, payment: { mock: true, broadcast: sent, confirmation: done } } })
      }
      // Production: no automatic broadcaster yet. The instruction is fixed server-side; the admin sends the transfer and
      // records its hash with RECORD_PAYMENT_BROADCAST.
      const instruction = await ports.createInstruction(paymentId)
      return json({ success: true, result: { ...data, payment_status: 'PAYMENT_CREATED', instruction } })
    }

    if (parsed.action === 'CREATE_INSTRUCTION') {
      try {
        return json({ success: true, result: { payment_id: parsed.paymentId, status: 'PAYMENT_CREATED', instruction: await ports.createInstruction(parsed.paymentId) } })
      } catch (e) {
        return businessError(e, parsed.action)
      }
    }

    if (parsed.action === 'RECORD_PAYMENT_BROADCAST' || parsed.action === 'ADVANCE_PAYMENT' || parsed.action === 'FAIL_PAYMENT' || parsed.action === 'CANCEL_PAYMENT') {
      try {
        let r: Record<string, unknown>
        if (parsed.action === 'RECORD_PAYMENT_BROADCAST') {
          r = await call('record_provider_payment_broadcast', { p_payment_id: parsed.paymentId, p_tx_hash: parsed.txHash, p_actor: userId })
          // a second guarded step; if it fails the payment simply stays BROADCASTED (the hash is already saved)
          if (parsed.markConfirming) r = await call('advance_provider_payment', { p_payment_id: parsed.paymentId, p_to: 'CONFIRMING', p_actor: userId })
        } else if (parsed.action === 'ADVANCE_PAYMENT') {
          r = await call('advance_provider_payment', { p_payment_id: parsed.paymentId, p_to: parsed.to, p_actor: userId })
        } else {
          r = await call(parsed.action === 'FAIL_PAYMENT' ? 'fail_provider_payment' : 'cancel_provider_payment', { p_payment_id: parsed.paymentId, p_reason: parsed.reason, p_actor: userId })
        }
        return json({ success: true, result: r })
      } catch (e) {
        return businessError(e, parsed.action)
      }
    }

    if (parsed.action !== 'GET') return fail(400, 'invalid_input', 'Unknown action.')

    // GET: balance + one page (fetch one extra row to know whether there is a next page).
    const { data: state, error: stateError } = await db.from('treasury_state').select('balance, updated_at').eq('id', 1).single()
    if (stateError) throw new Error(`treasury state: ${stateError.message}`)
    let q = db.from('treasury_transactions').select(COLUMNS).order('seq', { ascending: false }).limit(parsed.limit + 1)
    if (parsed.beforeSeq !== null) q = q.lt('seq', parsed.beforeSeq)
    const { data: rows, error: rowsError } = await q
    if (rowsError) throw new Error(`treasury transactions: ${rowsError.message}`)
    const { data: pending, error: pendingError } = await db
      .from('topup_proposals')
      .select('id, provider_id, amount, currency, created_at, provider:providers(name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (pendingError) throw new Error(`pending proposals: ${pendingError.message}`)
    const proposals = (pending ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id), providerId: String(r.provider_id), providerName: String((r.provider as { name?: string } | null)?.name ?? 'Provider'),
      amount: Number(r.amount), currency: String(r.currency), createdAt: String(r.created_at),
    }))
    const { data: payRows, error: payError } = await db.rpc('list_provider_payments', { p_limit: 20 })
    if (payError) throw new Error(`provider payments: ${payError.message}`)
    const now = Date.now()
    const payments = ((payRows ?? []) as Record<string, unknown>[]).map((r) => paymentView(r, now))
    const { data: settings, error: settingsError } = await db.from('platform_settings').select('minimum_treasury_reserve').eq('id', 1).single()
    if (settingsError) throw new Error(`platform settings: ${settingsError.message}`)
    const page = (rows ?? []).slice(0, parsed.limit).map(publicTx)
    const hasMore = (rows ?? []).length > parsed.limit
    return json({
      success: true,
      balance: Number(state.balance),
      minimumReserve: Number(settings.minimum_treasury_reserve ?? 0),
      updatedAt: String(state.updated_at),
      transactions: page,
      proposals,
      payments,
      nextBefore: hasMore ? page[page.length - 1].seq : null,
    })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
