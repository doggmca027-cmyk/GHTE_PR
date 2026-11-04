// Supabase Edge Function (Deno): POST /create-crypto-invoice   (signed-in customers)
//   Authorization: Bearer <JWT from telegram-auth>
//   Body: { amountUsd: number }                 -> 200 { success, invoice: { id, payUrl, miniAppUrl, webAppUrl, amountUsd, expiresAt } }
//         { action: 'status', invoiceId: uuid } -> 200 { success, status: 'pending' | 'paid' | 'expired' | 'failed' | 'review', amountUsd, balance? }
//
// A deposit through Crypto Pay (@CryptoBot): the customer enters dollars, we make a USD invoice there, CryptoBot converts it to USDT / TON at its current
// rate and shows its payment page (payUrl for the bot, miniAppUrl inside a Mini App). The balance is credited when the invoice is paid, by cryptopay-webhook.
//   * the row is written first (with a cap of 5 unpaid invoices per customer), CryptoBot is called after it, so a paid invoice always has a row to land on
//   * 'status' lets the app ask after paying: if CryptoBot says it is paid and the webhook has not arrived yet, it is credited here (the same one-time
//     credit as the webhook's: whichever comes first books it, the other finds it booked)
// Secrets: JWT_SECRET, CRYPTO_PAY_API_TOKEN, CRYPTO_PAY_NETWORK (default mainnet). Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  CryptoPayError, INVOICE_TTL_SECONDS, MAX_PENDING_INVOICES, createCryptoPayClient, looksLikeCryptoPayToken, validateInvoiceAmountUsd, type CryptoInvoice,
} from '../_shared/crypto-pay.ts'
import { settleInvoice, type CreditResult } from '../_shared/crypto-pay-flow.ts'
import { authenticate, corsHeaders, fail, instrument, json, readJson } from '../_shared/http.ts'
import { assertSwitchOn, loadPlatformSettings } from '../_shared/platform-settings.ts'
import { registerSecret } from '../_shared/logger.ts'
import { ServiceUnavailableError } from '../_shared/routing.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(instrument('create-crypto-invoice', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const token = Deno.env.get('CRYPTO_PAY_API_TOKEN')
  const network = Deno.env.get('CRYPTO_PAY_NETWORK') === 'testnet' ? 'testnet' : 'mainnet'
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    log.error('missing environment configuration', { error_code: 'server_misconfigured' })
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }
  if (!looksLikeCryptoPayToken(token)) {
    log.error('CRYPTO_PAY_API_TOKEN is missing or malformed', { error_code: 'deposits_unavailable' })
    return fail(503, 'deposits_unavailable', 'Deposits through CryptoBot are temporarily unavailable.')
  }
  registerSecret(token)

  const userId = await authenticate(req, jwtSecret)
  if (!userId) return fail(401, 'unauthorized', 'Please reopen the app and try again.')
  log.bind({ userId })
  const body = (await readJson(req)) as { amountUsd?: unknown; action?: unknown; invoiceId?: unknown } | null
  if (!body || typeof body !== 'object') return fail(400, 'invalid_input', 'Request body must be valid JSON.')

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const client = createCryptoPayClient({ token, network })

  // ---- status: has this invoice been paid? ------------------------------------------------------------------------------------------------------
  if (body.action === 'status') {
    if (typeof body.invoiceId !== 'string' || !UUID_RE.test(body.invoiceId)) return fail(400, 'invalid_input', 'invoiceId must be an invoice id.')
    const { data: row } = await db.from('crypto_pay_invoices').select('id, user_id, status, amount_usd, invoice_id').eq('id', body.invoiceId.toLowerCase()).maybeSingle()
    if (!row || row.user_id !== userId) return fail(404, 'not_found', 'Invoice not found.') // another customer's invoice is "not found", not "forbidden"
    if (row.status === 'pending' && row.invoice_id) {
      try {
        const settled = await settleInvoice(Number(row.invoice_id), {
          client,
          log,
          async complete(invoice: CryptoInvoice): Promise<CreditResult | null> {
            const { data, error } = await db.rpc('complete_crypto_pay_invoice', {
              p_invoice_id: invoice.invoiceId, p_paid_asset: invoice.paidAsset, p_paid_amount: invoice.paidAmount, p_fiat: invoice.fiat, p_fiat_amount: invoice.amount,
            })
            if (error) throw new Error(`complete_crypto_pay_invoice: ${error.message}`)
            const r = data as { result: CreditResult['result']; amount_usd: number | string; balance?: number | string }
            return { result: r.result, amountUsd: Number(r.amount_usd), ...(r.balance !== undefined ? { balance: Number(r.balance) } : {}) }
          },
        })
        if (settled.kind === 'credited' || settled.kind === 'already_credited') return json({ success: true, status: 'paid', amountUsd: Number(row.amount_usd), ...('balance' in settled && settled.balance !== undefined ? { balance: settled.balance } : {}) })
        if (settled.kind === 'review') return json({ success: true, status: 'review', amountUsd: Number(row.amount_usd) })
      } catch (e) {
        if (!(e instanceof CryptoPayError)) log.error('status check failed', { err: e, error_code: 'status_failed' })
        // CryptoBot could not be asked: say what we have (still pending); the webhook may yet come
      }
      return json({ success: true, status: 'pending', amountUsd: Number(row.amount_usd) })
    }
    return json({ success: true, status: row.status, amountUsd: Number(row.amount_usd) })
  }

  // ---- a new invoice ----------------------------------------------------------------------------------------------------------------------------
  const amount = validateInvoiceAmountUsd(body.amountUsd)
  if (!amount.ok) return fail(400, 'invalid_input', amount.error)

  // Kill switch: no new invoice while payments are paused (a paid one is still credited by the webhook). Fails closed.
  try {
    assertSwitchOn(await loadPlatformSettings(db, log), 'payments')
  } catch (e) {
    if (e instanceof ServiceUnavailableError) return fail(503, 'deposits_unavailable', e.message)
    throw e
  }

  const made = await db.rpc('create_crypto_pay_invoice', { p_user_id: userId, p_amount_usd: amount.value, p_network: network, p_ttl_seconds: INVOICE_TTL_SECONDS, p_max_pending: MAX_PENDING_INVOICES })
  if (made.error) {
    if (/banned/.test(made.error.message)) return fail(403, 'banned', 'Your account is suspended.')
    if (/too_many_pending/.test(made.error.message)) return fail(429, 'too_many_pending', 'You have several unpaid invoices open. Please pay one or wait for them to expire.')
    if (/no_data_found|not found/.test(made.error.message)) return fail(401, 'unauthorized', 'Please reopen the app and try again.')
    log.error('invoice row failed', { err: made.error, error_code: 'invoice_insert_failed' })
    return fail(500, 'internal_error', 'Something went wrong. Please try again.')
  }
  const row = made.data as { id: string; expires_at: string }

  let invoice: CryptoInvoice
  try {
    invoice = await client.createInvoice({ amountUsd: amount.value, payload: row.id, description: 'GRAM Hub balance top-up', expiresInSeconds: INVOICE_TTL_SECONDS })
  } catch (e) {
    await db.from('crypto_pay_invoices').update({ status: 'failed' }).eq('id', row.id)
    log.error('CryptoBot refused or did not answer', { err: e, error_code: 'create_invoice_failed' })
    return fail(502, 'provider_unavailable', 'CryptoBot is not answering. Please try again in a minute.')
  }
  const { error: attachError } = await db.from('crypto_pay_invoices')
    .update({ invoice_id: invoice.invoiceId, pay_url: invoice.botUrl, mini_app_url: invoice.miniAppUrl, web_app_url: invoice.webAppUrl })
    .eq('id', row.id)
  if (attachError) {
    // The invoice exists at CryptoBot but we could not note its id: it must not be paid. It is left to expire there; the customer is asked to retry.
    await db.from('crypto_pay_invoices').update({ status: 'failed' }).eq('id', row.id)
    log.error('invoice id could not be saved', { err: attachError, error_code: 'invoice_attach_failed' })
    return fail(500, 'internal_error', 'Something went wrong. Please try again.')
  }
  return json({
    success: true,
    invoice: { id: row.id, payUrl: invoice.botUrl, miniAppUrl: invoice.miniAppUrl, webAppUrl: invoice.webAppUrl, amountUsd: amount.value, expiresAt: row.expires_at },
  })
}))
