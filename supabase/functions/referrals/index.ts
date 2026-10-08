// Supabase Edge Function (Deno): POST /referrals   (signed-in users)
//   Authorization: Bearer <JWT issued by telegram-auth>
//
//   { action: "SUMMARY" }
//       -> { success, code, startParam, referred, percentage, holdDays, invitees,
//            balance: { total, pending, available }, recent: [{ id, type, amount, orderId, availableAt, createdAt }] }
//          Your invite code and your affiliate balance. The balance is always the sum of the append-only referral ledger:
//          `pending` = rewards still inside the hold period, `available` = what TRANSFER can move now.
//   { action: "APPLY_CODE", code }                       (code or the Telegram start parameter "ref_<code>")
//       -> { success, applied: true, alreadyApplied }
//          Attributes you to the owner of the code. Refused for your own code, a loop, a second different referrer
//          (the referrer can never change) and after your first order.
//   { action: "TRANSFER", amount?, idempotencyKey? }     (amount omitted = everything available)
//       -> { success, transferred, replayed, walletBalance, balance }
//          Moves cleared earnings into the main wallet in one transaction; two parallel requests can never spend the same money.
//
// The caller is always the JWT's user; a user id in the body is never read. Every rule lives in SQL (service-role functions).
// Secrets: JWT_SECRET. Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { mapReferralError, parseReferralRequest, toSummaryDto } from '../_shared/referrals.ts'

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

Deno.serve(instrument('referrals', async (req: Request, { log }): Promise<Response> => {
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

  const parsed = parseReferralRequest(await readJson(req))
  if ('error' in parsed) return fail(400, 'invalid_input', parsed.error)

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  try {
    const call = async (fn: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> } | { response: Response }> => {
      const { data, error } = await db.rpc(fn, args)
      if (error) {
        const m = mapReferralError(error.message)
        if (m.status === 500) throw new Error(`${fn}: ${error.message}`)
        return { response: fail(m.status, m.error, m.message) }
      }
      return { data: data as Record<string, unknown> }
    }

    if (parsed.action === 'SUMMARY') {
      const r = await call('referral_summary', { p_user_id: userId, p_recent: 20 })
      if ('response' in r) return r.response
      return json({ success: true, ...toSummaryDto(r.data) })
    }

    if (parsed.action === 'APPLY_CODE') {
      const r = await call('apply_referral', { p_user_id: userId, p_code: parsed.code })
      if ('response' in r) return r.response
      log.info('referral applied', { alreadyApplied: r.data.already_applied === true })
      return json({ success: true, applied: true, alreadyApplied: r.data.already_applied === true })
    }

    const r = await call('transfer_affiliate_balance_to_wallet', { p_user_id: userId, p_amount: parsed.amount, p_idempotency_key: parsed.idempotencyKey })
    if ('response' in r) return r.response
    const d = r.data
    const b = (d.balance ?? {}) as Record<string, unknown>
    log.info('affiliate balance transferred', { replayed: d.replayed === true })
    return json({
      success: true, transferred: Number(d.transferred), replayed: d.replayed === true,
      walletBalance: d.wallet_balance == null ? null : Number(d.wallet_balance),
      balance: { total: Number(b.total ?? 0), pending: Number(b.pending ?? 0), available: Number(b.available ?? 0) },
    })
  } catch (e) {
    log.error('request failed', { err: e, error_code: 'server_error' })
    return fail(500, 'server_error', 'Something went wrong. Please try again.')
  }
}))
