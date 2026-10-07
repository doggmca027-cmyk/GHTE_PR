// Supabase Edge Function (Deno): POST /admin-reconciliation   (admins only)
//   Authorization: Bearer <JWT issued by telegram-auth>
//   { action: "GET_CASES" }
//       -> { success, cases: [{ id, entityType, entityId, reason, createdAt, order: {...} | null, payment: {...} | null }] }
//          (open cases, oldest first; the detector runs first, for orders and provider payments)
//   { action: "RESOLVE_REFUND", caseId, reason? }
//       -> full refund to the customer's wallet, order -> refunded, case -> resolved, in ONE database transaction
//          (resolve_case_refund). A resolved case is a no-op, so it can never be refunded twice.
//   { action: "RESOLVE_RETRY", caseId }
//       -> claims the retry (atomic marker on the order), re-submits to the SAME provider offer the order was charged
//          for, then order -> submitted + case -> resolved atomically. On a refusal or an unknown outcome the case
//          stays open with a note; nothing is refunded automatically.
//   { action: "MARK_RESOLVED", caseId, note?, providerOrderId? }
//       -> closes the case without any financial action. A provider payment that still needs a decision keeps its case:
//          it closes when the payment is completed or marked failed (Admin -> Treasury).
//
// Auth: JWT verified here, then users.is_admin re-checked in the database; the SQL resolvers check the actor again.
// Secrets: JWT_SECRET, PROVIDER_KEY_SECRET / PROVIDER_<NAME>_API_KEY, MOCK_MODE (dev only).
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, json } from '../_shared/http.ts'
import { executeRetry, mapReconError, parseReconRequest } from '../_shared/reconciliation.ts'
import { OFFER_SELECT, buildCandidates, type OfferRow } from '../_shared/routing.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const publicCase = (c: Record<string, unknown>) => {
  const o = c.order as Record<string, unknown> | null
  const p = (c.payment ?? null) as Record<string, unknown> | null
  return {
    id: String(c.id), entityType: String(c.entity_type), entityId: String(c.entity_id), reason: String(c.reason), createdAt: String(c.created_at),
    order: o && {
      status: String(o.status), chargeAmount: Number(o.charge_amount), quantity: Number(o.quantity), targetUrl: String(o.target_url),
      providerOrderId: (o.provider_order_id as string | null) ?? null, errorMessage: (o.error_message as string | null) ?? null,
      createdAt: String(o.created_at), serviceName: String(o.service_name ?? 'Service'), username: (o.username as string | null) ?? null,
      telegramId: Number(o.telegram_id), canRetry: o.status === 'processing' && !o.provider_order_id && o.has_routing_snapshot === true,
    },
    payment: p && {
      status: String(p.status), providerName: String(p.provider_name ?? 'Provider'), amount: Number(p.amount), currency: String(p.currency ?? 'USD'),
      asset: String(p.asset), network: String(p.network), destinationWallet: String(p.destination_wallet), txHash: (p.tx_hash as string | null) ?? null,
      broadcastedAt: (p.broadcasted_at as string | null) ?? null, confirmedAt: (p.confirmed_at as string | null) ?? null, createdAt: String(p.created_at),
    },
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const jwtSecret = Deno.env.get('JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    console.error('admin-reconciliation: missing configuration')
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Sign in again.')

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  try {
    const { data: admin, error: adminError } = await db.from('users').select('id').eq('id', userId).eq('is_admin', true).eq('is_banned', false).maybeSingle()
    if (adminError) throw new Error(`admin check: ${adminError.message}`)
    if (!admin) return fail(403, 'forbidden', 'Admin access required.')

    const raw = await req.text()
    let body: unknown = null
    if (raw.trim() !== '') {
      if (raw.length > 4096) return fail(400, 'invalid_input', 'Request too large.')
      try { body = JSON.parse(raw) } catch { return fail(400, 'invalid_input', 'Body must be valid JSON.') }
    }
    const parsed = parseReconRequest(body)
    if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

    // Wraps an RPC whose database error is one of the expected business errors.
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await db.rpc(fn, args)
      if (error) {
        const m = mapReconError(error.message)
        if (m.status === 500) throw new Error(`${fn}: ${error.message}`)
        return { response: fail(m.status, m.error, m.message) }
      }
      return { data }
    }

    if (parsed.action === 'GET_CASES') {
      // Catch orders that became stuck purely with time, then list.
      const synced = await db.rpc('sync_reconciliation_cases')
      if (synced.error) console.error('admin-reconciliation: sync failed', synced.error.message)
      const { data, error } = await db.rpc('list_reconciliation_cases')
      if (error) throw new Error(`list_reconciliation_cases: ${error.message}`)
      return json({ success: true, cases: ((data ?? []) as Record<string, unknown>[]).map(publicCase) })
    }

    if (parsed.action === 'RESOLVE_REFUND') {
      const r = await rpc('resolve_case_refund', { p_case_id: parsed.caseId, p_actor: userId, p_reason: parsed.reason })
      return r.response ?? json({ success: true, result: r.data })
    }

    if (parsed.action === 'MARK_RESOLVED') {
      const r = await rpc('resolve_case_manual', { p_case_id: parsed.caseId, p_actor: userId, p_note: parsed.note, p_provider_order_id: parsed.providerOrderId })
      return r.response ?? json({ success: true, result: r.data })
    }

    // ---- RESOLVE_RETRY ----------------------------------------------------------------------------
    const begun = await rpc('begin_case_retry', { p_case_id: parsed.caseId, p_actor: userId })
    if (begun.response) return begun.response
    const job = begun.data as { order_id: string; target_url: string; quantity: number; provider_offer_id: string }

    const release = async (note: string) => {
      const { error } = await db.rpc('release_case_retry', { p_case_id: parsed.caseId, p_note: note })
      if (error) console.error('admin-reconciliation: release failed', error.message)
    }

    // The SAME offer the order was charged for: an order is never silently re-routed.
    const { data: offerRows, error: offerError } = await db.from('provider_service_offers').select(OFFER_SELECT).eq('id', job.provider_offer_id)
    if (offerError) {
      await release('retry could not start: offer lookup failed')
      throw new Error(`offer lookup: ${offerError.message}`)
    }
    const candidates = buildCandidates((offerRows ?? []) as unknown as OfferRow[])
    const details = candidates.details.get(job.provider_offer_id)
    const provider = candidates.providers[0]
    if (!details || !provider) {
      await release('retry could not start: the provider service is no longer available')
      return fail(409, 'offer_unavailable', "The provider service this order was placed with is no longer available. Refund the order or mark it resolved.")
    }

    let apiKey = ''
    try {
      apiKey = await resolveProviderApiKey({ name: details.providerName, api_key_encrypted: details.apiKeyEncrypted }, Deno.env)
    } catch (e) {
      console.error('admin-reconciliation: provider key could not be decrypted', e)
    }
    if (!apiKey && Deno.env.get('MOCK_MODE') !== 'true') {
      await release('retry could not start: no provider API key configured')
      return fail(503, 'provider_unavailable', 'The provider is not configured, so the order cannot be retried right now.')
    }
    const adapter = createSMMv2Adapter({ id: provider.id, name: provider.name, apiUrl: details.apiUrl, apiKey }, { MOCK_MODE: Deno.env.get('MOCK_MODE') })

    const outcome = await executeRetry(
      { externalServiceId: details.externalServiceId, link: job.target_url, quantity: job.quantity },
      {
        async finish(providerOrderId) {
          const { error } = await db.rpc('finish_case_retry', { p_case_id: parsed.caseId, p_actor: userId, p_provider_order_id: providerOrderId })
          if (error) throw new Error(error.message)
        },
        release,
      },
      adapter,
    )
    if (outcome.kind === 'submitted') return json({ success: true, result: { status: 'resolved', resolution: 'retry', providerOrderId: outcome.providerOrderId } })
    if (outcome.kind === 'rejected') return fail(422, 'provider_rejected', outcome.message)
    return fail(202, 'outcome_unknown', outcome.message)
  } catch (e) {
    console.error('admin-reconciliation failed', e instanceof Error ? e.message : 'unknown')
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
})
