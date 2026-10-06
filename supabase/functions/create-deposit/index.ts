// Supabase Edge Function (Deno): POST /create-deposit
//   Authorization: Bearer <JWT from telegram-auth>
//   Body: { amountUsd: number, asset: 'TON' | 'USDT', quoteOnly?: boolean }
//
// Creates a pending deposit intent (unique memo + quoted crypto amount, rate locked) and returns
// what the wallet must send. With quoteOnly it just returns the quote and writes nothing.
// The deposit is NOT credited here: only verify-deposit does that, after seeing the transaction on chain.
//
// Secrets: JWT_SECRET, TON_RECIPIENT_ADDRESS, TON_NETWORK ('mainnet'|'testnet', default mainnet),
//          MOCK_MODE (dev only: allows a fixed fallback rate), TON_USD_FALLBACK_RATE (dev only).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { authenticate, corsHeaders, fail, json, readJson } from '../_shared/http.ts'
import {
  DEPOSIT_VALIDITY_SECONDS,
  MAX_PENDING_DEPOSITS,
  generateMemo,
  parseCoinGeckoTonUsd,
  parseTonAddress,
  quoteDeposit,
  validateDepositAmountUsd,
  type DepositAsset,
} from '../_shared/ton.ts'

const RATE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd'
const RATE_CACHE_MS = 60_000
let cachedRate: { rate: number; at: number } | null = null

/** Live TON/USD. Production never quotes from a constant: no fresh rate means no quote. */
async function getTonUsdRate(): Promise<number | null> {
  if (cachedRate && Date.now() - cachedRate.at < RATE_CACHE_MS) return cachedRate.rate
  try {
    const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } })
    if (res.ok) {
      const rate = parseCoinGeckoTonUsd(await res.json())
      if (rate) {
        cachedRate = { rate, at: Date.now() }
        return rate
      }
    }
  } catch (e) {
    console.error('create-deposit: rate fetch failed', e)
  }
  if (Deno.env.get('MOCK_MODE') === 'true') return Number(Deno.env.get('TON_USD_FALLBACK_RATE') ?? '5')
  // A recent (< 10 min) cached value is acceptable if the feed hiccups; anything older is not.
  return cachedRate && Date.now() - cachedRate.at < 10 * 60_000 ? cachedRate.rate : null
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const recipient = Deno.env.get('TON_RECIPIENT_ADDRESS')
  const network = Deno.env.get('TON_NETWORK') === 'testnet' ? 'testnet' : 'mainnet'
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    console.error('create-deposit: missing environment configuration')
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }
  try {
    if (!recipient) throw new Error('missing')
    parseTonAddress(recipient)
  } catch {
    console.error('create-deposit: TON_RECIPIENT_ADDRESS is missing or invalid')
    return fail(503, 'deposits_unavailable', 'Deposits are temporarily unavailable.')
  }

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Please reopen the app and try again.')

  const body = (await readJson(req)) as { amountUsd?: unknown; asset?: unknown; quoteOnly?: unknown } | null
  if (!body || typeof body !== 'object') return fail(400, 'invalid_input', 'Request body must be valid JSON.')

  const amount = validateDepositAmountUsd(body.amountUsd)
  if (!amount.ok) return fail(400, 'invalid_input', amount.error)
  const asset = body.asset as DepositAsset
  if (asset !== 'TON' && asset !== 'USDT') return fail(400, 'invalid_input', 'asset must be TON or USDT')
  // USDT needs a jetton transfer payload and jetton-transfer verification; not shipped yet.
  if (asset === 'USDT') return fail(400, 'asset_unavailable', 'USDT deposits are not available yet. Please use TON.')

  const rate = await getTonUsdRate()
  if (!rate) return fail(503, 'rate_unavailable', 'Could not get a live exchange rate. Please try again in a minute.')
  const quote = quoteDeposit(amount.value / 100, rate, asset)

  const quotePayload = {
    asset,
    amountUsd: quote.amountUsd,
    amountCrypto: quote.amountCrypto,
    amountNano: quote.amountBase.toString(),
    rateUsd: quote.rateUsd,
    network,
  }
  if (body.quoteOnly === true) return json({ success: true, quote: quotePayload })

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const { data: user } = await db.from('users').select('is_banned').eq('id', userId).maybeSingle()
  if (!user) return fail(401, 'unauthorized', 'Please reopen the app and try again.')
  if (user.is_banned) return fail(403, 'banned', 'Your account is suspended.')

  // Tidy old intents, then cap how many open ones a user can hold.
  await db.from('deposits').update({ status: 'expired' }).eq('status', 'pending').lt('valid_until', new Date(Date.now() - 24 * 3600_000).toISOString())
  const { count } = await db
    .from('deposits')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('valid_until', new Date().toISOString())
  if ((count ?? 0) >= MAX_PENDING_DEPOSITS) {
    return fail(429, 'too_many_pending', 'You have several unpaid deposits open. Please complete or wait for them to expire.')
  }

  const validUntilSec = Math.floor(Date.now() / 1000) + DEPOSIT_VALIDITY_SECONDS
  for (let attempt = 0; attempt < 3; attempt++) {
    const memo = generateMemo()
    const { data, error } = await db
      .from('deposits')
      .insert({
        user_id: userId,
        amount_usd: quote.amountUsd,
        amount_crypto: quote.amountCrypto,
        asset,
        rate_usd: quote.rateUsd,
        network,
        memo,
        recipient_address: recipient,
        valid_until: new Date(validUntilSec * 1000).toISOString(),
      })
      .select('id')
      .single()
    if (error?.code === '23505') continue // memo collision: astronomically unlikely, retry with a new one
    if (error || !data) {
      console.error('create-deposit: insert failed', error)
      return fail(500, 'internal_error', 'Something went wrong. Please try again.')
    }
    return json({
      success: true,
      depositId: data.id,
      memo,
      recipientAddress: recipient,
      validUntil: validUntilSec,
      ...quotePayload,
    })
  }
  return fail(500, 'internal_error', 'Something went wrong. Please try again.')
})
