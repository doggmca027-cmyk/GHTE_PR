// Supabase Edge Function (Deno): POST /cryptopay-webhook   (called by Crypto Pay / @CryptoBot only)
//   Header: crypto-pay-api-signature = hex( HMAC-SHA256( SHA256(CRYPTO_PAY_API_TOKEN), raw body ) )
//   Body:   { update_id, update_type: 'invoice_paid', request_date, payload: { invoice_id, status, ... } }
//
// Credits a customer's balance when an invoice made by create-crypto-invoice is paid. Set this URL as the webhook of the app in @CryptoPayBot
// (Crypto Pay -> My Apps -> your app -> Webhooks): https://<project>.supabase.co/functions/v1/cryptopay-webhook
//   * the signature is checked first, on the raw body, in constant time (see _shared/crypto-pay.ts); a request that fails it is 401 and nothing else happens
//   * CryptoBot is then asked about the invoice (getInvoices) and the credit follows what it answers
//   * the credit is complete_crypto_pay_invoice(): one transaction, ledger key 'cryptopay:<invoice_id>', so a webhook that arrives twice (or a status poll
//     and a webhook together) credits once; it also queues the Telegram message in the outbox
//   * 200 for anything that is handled or is not ours; 503 / 500 when it could not be done now, so CryptoBot sends it again
// Secrets: CRYPTO_PAY_API_TOKEN, CRYPTO_PAY_NETWORK ('mainnet' | 'testnet', default mainnet). Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { MAX_WEBHOOK_BYTES, createCryptoPayClient, looksLikeCryptoPayToken, type CryptoInvoice } from '../_shared/crypto-pay.ts'
import { handleWebhook, type CreditResult } from '../_shared/crypto-pay-flow.ts'
import { corsHeaders, fail, instrument, json, readBoundedText } from '../_shared/http.ts'
import { registerSecret } from '../_shared/logger.ts'

Deno.serve(instrument('cryptopay-webhook', async (req: Request, { log }): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const token = Deno.env.get('CRYPTO_PAY_API_TOKEN')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey || !looksLikeCryptoPayToken(token)) {
    log.error('crypto pay is not configured', { error_code: 'payments_unconfigured' })
    return fail(503, 'unavailable', 'Not configured.')
  }
  registerSecret(token) // the token is the secret the signature is made from: it must never reach a log line

  const raw = await readBoundedText(req, MAX_WEBHOOK_BYTES)
  if (raw === null) return fail(413, 'too_large', 'Request too large.')

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const answer = await handleWebhook(raw, req.headers.get('crypto-pay-api-signature'), token, {
    client: createCryptoPayClient({ token, network: Deno.env.get('CRYPTO_PAY_NETWORK') }),
    log,
    async complete(invoice: CryptoInvoice): Promise<CreditResult | null> {
      const { data, error } = await db.rpc('complete_crypto_pay_invoice', {
        p_invoice_id: invoice.invoiceId,
        p_paid_asset: invoice.paidAsset,
        p_paid_amount: invoice.paidAmount,
        p_fiat: invoice.fiat,
        p_fiat_amount: invoice.amount,
      })
      if (error) {
        if (/unknown_invoice/.test(error.message)) return null // not an invoice of ours: nothing to credit, nothing to retry
        throw new Error(`complete_crypto_pay_invoice: ${error.message}`)
      }
      const r = data as { result?: CreditResult['result']; amount_usd?: number | string; balance?: number | string } | null
      if (!r || (r.result !== 'credited' && r.result !== 'already_credited' && r.result !== 'review')) throw new Error('complete_crypto_pay_invoice: unexpected answer')
      return { result: r.result, amountUsd: Number(r.amount_usd), ...(r.balance !== undefined ? { balance: Number(r.balance) } : {}) }
    },
  })
  return json(answer.body, answer.status)
}))
