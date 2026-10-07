// Supabase Edge Function (Deno): POST /verify-deposit
//   Authorization: Bearer <JWT from telegram-auth>
//   Body: { depositId: uuid, txHash?: string, boc?: string }
//
// Credits a deposit ONLY after finding a matching transaction on the TON blockchain.
// `txHash` / `boc` from the client are accepted for compatibility but never trusted: the
// server looks for the payment itself, by memo, in the recipient's incoming transactions.
//
// Secrets: JWT_SECRET, TON_RECIPIENT_ADDRESS (must equal the one used by create-deposit),
//          TON_NETWORK, TONCENTER_API_KEY (optional, higher rate limit), TONCENTER_URL (optional override).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { fireAndForget } from '../_shared/telegram-notify.ts'
import { createNotifier } from '../_shared/notify-db.ts'
import { fetchRecentTransfers } from '../_shared/ton.ts'
import { verifyDeposit } from '../_shared/deposit-verify.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(instrument('verify-deposit', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const recipient = Deno.env.get('TON_RECIPIENT_ADDRESS')
  if (!jwtSecret || !supabaseUrl || !serviceKey || !recipient) {
    log.error('missing environment configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Please reopen the app and try again.')
  log.bind({ userId })

  const body = (await readJson(req, 16_384)) as { depositId?: unknown; txHash?: unknown; boc?: unknown } | null
  if (!body || typeof body.depositId !== 'string' || !UUID_RE.test(body.depositId)) {
    return fail(400, 'invalid_input', 'depositId must be a UUID.')
  }
  if (body.txHash !== undefined && (typeof body.txHash !== 'string' || body.txHash.length > 128)) {
    return fail(400, 'invalid_input', 'txHash is invalid.')
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Only the owner can verify their own deposit.
  const { data: deposit, error } = await db
    .from('deposits')
    .select('id, user_id, status, memo, recipient_address, amount_crypto, asset, network, created_at, valid_until, amount_usd')
    .eq('id', body.depositId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    log.error('deposit lookup failed', { err: error, error_code: 'lookup_failed', depositId: body.depositId })
    return fail(500, 'internal_error', 'Something went wrong. Please try again.')
  }
  if (!deposit) return fail(404, 'not_found', 'Deposit not found.')

  const walletOf = async () => {
    const { data } = await db.from('wallets').select('balance, currency').eq('user_id', userId).maybeSingle()
    return data ? { balance: Number(data.balance), currency: data.currency as string } : undefined
  }

  // Best-effort Telegram message. Deduplicated per deposit, so the repeated polls that follow a
  // completion (and any retry after a crash) can never notify twice, and a failure here can never
  // affect the credit: it runs after the DB commit and swallows every error.
  const notifyCredited = (balance: number | undefined) => {
    if (balance === undefined) return
    fireAndForget(
      createNotifier(db, Deno.env)(
        userId,
        {
          type: 'deposit_completed',
          amountUsd: Number(deposit.amount_usd),
          asset: deposit.asset,
          amountCrypto: String(deposit.amount_crypto),
          balance,
        },
        `deposit:${deposit.id}`,
      ),
    )
  }

  // The whole decision lives in _shared/deposit-verify.ts (also run by scripts/ton-e2e.ts): network, recipient, memo,
  // amount and window must match; the credit is one atomic, idempotent database call.
  const network = Deno.env.get('TON_NETWORK') === 'testnet' ? 'testnet' : 'mainnet'
  const baseUrl = Deno.env.get('TONCENTER_URL') ?? (network === 'testnet' ? 'https://testnet.toncenter.com' : 'https://toncenter.com')
  let outcome
  try {
    outcome = await verifyDeposit(deposit, { network, recipient }, {
      loadTransfers: (sinceUtime) => fetchRecentTransfers({ baseUrl, account: recipient, sinceUtime, apiKey: Deno.env.get('TONCENTER_API_KEY') }),
      async completeDeposit({ depositId, txHash, senderRaw, receivedNano }) {
        const { error: rpcError } = await db.rpc('complete_deposit', {
          p_deposit_id: depositId, p_tx_hash: txHash, p_sender_address: senderRaw, p_received_nano: receivedNano.toString(),
        })
        if (rpcError) throw new Error(rpcError.message)
      },
      async flagIssue(depositId, reason) {
        log.warn('deposit flagged for reconciliation', { depositId, reason, error_code: 'deposit_flagged' })
        const { error: flagError } = await db.rpc('flag_deposit_issue', { p_deposit_id: depositId, p_reason: reason })
        if (flagError) log.error('could not flag deposit', { err: flagError, error_code: 'flag_failed', depositId })
      },
    })
  } catch (e) {
    log.error('verification failed', { err: e, error_code: 'verification_failed', depositId: deposit.id })
    return fail(500, 'internal_error', 'Something went wrong. Please try again.')
  }

  if (outcome.kind === 'pending') {
    // Not indexed yet (normal for the first ~10-30 s), or no transfer carries this memo: the client keeps polling.
    return json({ success: true, status: 'pending', message: 'Waiting for the transaction to appear on the TON network.' }, 202)
  }
  if (outcome.kind === 'rejected') {
    if (outcome.error === 'server_misconfigured') log.error('deposit recipient does not match TON_RECIPIENT_ADDRESS', { depositId: deposit.id, error_code: 'recipient_mismatch' })
    else log.info('deposit not credited', { depositId: deposit.id, error_code: outcome.error })
    return fail(outcome.httpStatus, outcome.error, outcome.message, outcome.extra ?? {})
  }

  log.info('deposit credited', { depositId: deposit.id, asset: deposit.asset })
  const wallet = await walletOf()
  notifyCredited(wallet?.balance)
  return json({ success: true, status: 'completed', newBalance: wallet?.balance, wallet })
}))
