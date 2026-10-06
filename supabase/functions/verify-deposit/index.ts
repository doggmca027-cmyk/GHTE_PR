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
import { authenticate, corsHeaders, fail, json, readJson } from '../_shared/http.ts'
import { fireAndForget } from '../_shared/telegram-notify.ts'
import { createNotifier } from '../_shared/notify-db.ts'
import { addressesEqual, findMatchingTransfer, fetchRecentTransfers, formatBaseUnits, toRawAddress } from '../_shared/ton.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const recipient = Deno.env.get('TON_RECIPIENT_ADDRESS')
  if (!jwtSecret || !supabaseUrl || !serviceKey || !recipient) {
    console.error('verify-deposit: missing environment configuration')
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Please reopen the app and try again.')

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
    .select('id, user_id, status, memo, recipient_address, amount_crypto, asset, created_at, valid_until, amount_usd')
    .eq('id', body.depositId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.error('verify-deposit: lookup failed', error)
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

  // 1. Idempotency: already credited.
  if (deposit.status === 'completed') {
    const wallet = await walletOf()
    notifyCredited(wallet?.balance) // self-heals a notification lost to a crash; deduplicated
    return json({ success: true, status: 'completed', newBalance: wallet?.balance, wallet })
  }
  if (deposit.status === 'failed') return fail(409, 'deposit_failed', 'This deposit has failed.')
  if (deposit.asset !== 'TON') return fail(400, 'asset_unavailable', 'Only TON deposits can be verified right now.')

  // The recipient we verify against is the one stored on the deposit; it must still be ours.
  if (!addressesEqual(deposit.recipient_address, recipient)) {
    console.error('verify-deposit: deposit recipient does not match TON_RECIPIENT_ADDRESS', deposit.id)
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  // 2. Look for the payment on chain.
  const createdAtSec = Math.floor(Date.parse(deposit.created_at) / 1000)
  const validUntilSec = Math.floor(Date.parse(deposit.valid_until) / 1000)
  const baseUrl = Deno.env.get('TONCENTER_URL') ?? (Deno.env.get('TON_NETWORK') === 'testnet' ? 'https://testnet.toncenter.com' : 'https://toncenter.com')

  let match
  try {
    const transfers = await fetchRecentTransfers({
      baseUrl,
      account: recipient,
      sinceUtime: createdAtSec - 300,
      apiKey: Deno.env.get('TONCENTER_API_KEY'),
    })
    // amount_crypto is NUMERIC(20,9): parse the exact decimal into nanoton without floats.
    const amountText = String(deposit.amount_crypto)
    if (!/^\d+(\.\d+)?$/.test(amountText)) throw new Error(`unexpected amount format: ${amountText}`)
    const [whole, frac = ''] = amountText.split('.')
    const amountBase = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0').slice(0, 9))
    match = findMatchingTransfer(transfers, {
      memo: deposit.memo,
      recipientAddress: recipient,
      amountBase,
      createdAtSec,
      validUntilSec,
    })
  } catch (e) {
    console.error('verify-deposit: chain lookup failed', e)
    return fail(502, 'chain_unavailable', 'Could not reach the TON network. Please try again shortly.')
  }

  if (!match.found) {
    if (match.reason === 'underpaid') {
      console.warn(`verify-deposit: deposit ${deposit.id} underpaid (tx ${match.transfer?.hash})`)
      return fail(422, 'underpaid', 'We received less than the required amount. Please contact support with your deposit ID.', {
        received: match.transfer ? formatBaseUnits(match.transfer.valueBase, 9) : undefined,
        required: String(deposit.amount_crypto),
      })
    }
    if (match.reason === 'outside_window') {
      console.warn(`verify-deposit: deposit ${deposit.id} paid outside its validity window (tx ${match.transfer?.hash})`)
      return fail(422, 'payment_expired', 'The payment arrived after this deposit expired. Please contact support with your deposit ID.')
    }
    // Not indexed yet (normal for the first ~10-30 s): the client keeps polling.
    return json({ success: true, status: 'pending', message: 'Waiting for the transaction to appear on the TON network.' }, 202)
  }

  // 3. Credit atomically (status + tx_hash claim + ledger in one DB transaction).
  const { error: rpcError } = await db.rpc('complete_deposit', {
    p_deposit_id: deposit.id,
    p_tx_hash: match.transfer.hash,
    p_sender_address: match.transfer.source ? toRawAddress(match.transfer.source) : null,
  })
  if (rpcError) {
    if (/tx_already_used/.test(rpcError.message)) {
      console.warn(`verify-deposit: tx ${match.transfer.hash} already credited; blocked for deposit ${deposit.id}`)
      return fail(409, 'tx_already_used', 'This transaction was already credited.')
    }
    console.error('verify-deposit: complete_deposit failed', rpcError)
    return fail(500, 'internal_error', 'Something went wrong. Please try again.')
  }

  const wallet = await walletOf()
  notifyCredited(wallet?.balance)
  return json({ success: true, status: 'completed', newBalance: wallet?.balance, wallet })
})
