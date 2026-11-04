// What happens when CryptoBot says an invoice is paid: the signature, a second look at the invoice, the credit. All I/O is a port, so the whole path is
// tested without a network or a database; the Edge Functions only wire the ports.
//
// The order of the checks is the point:
//   1. the signature of the RAW body (nothing is parsed or read from the database before it passes)
//   2. the update is an `invoice_paid` with an invoice id
//   3. CryptoBot is ASKED about that invoice (getInvoices): a signed webhook is believed to be from CryptoBot, but money is credited on what CryptoBot says
//      the invoice is now, not on what a request says
//   4. the database credits it, once (complete_crypto_pay_invoice: the ledger key 'cryptopay:<invoice_id>')

import { CryptoPayError, MAX_WEBHOOK_BYTES, parsePaidUpdate, verifyWebhookSignature, type CryptoInvoice, type CryptoPayClient } from './crypto-pay.ts'

export type CreditResult = { result: 'credited' | 'already_credited' | 'review'; amountUsd: number; balance?: number }

export interface CreditPorts {
  client: CryptoPayClient
  /** complete_crypto_pay_invoice; null when the invoice is not one of ours; throws when the database fails. */
  complete(invoice: CryptoInvoice): Promise<CreditResult | null>
  log: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void }
}

export type Settled =
  | { kind: 'credited' | 'already_credited' | 'review'; amountUsd: number; balance?: number }
  /** CryptoBot says the invoice is not paid (yet), or does not know it. */
  | { kind: 'not_paid'; status: string }
  | { kind: 'unknown' }

/**
 * Asks CryptoBot about the invoice and, if it is paid, credits it. Used by the webhook and by the customer's own status check, so a webhook that never
 * arrived costs nothing. Throws CryptoPayError when CryptoBot cannot be reached (the caller answers "try again") and the database's error when it fails.
 */
export async function settleInvoice(invoiceId: number, ports: CreditPorts): Promise<Settled> {
  const invoice = await ports.client.getInvoice(invoiceId)
  if (!invoice) return { kind: 'not_paid', status: 'not_found' }
  if (invoice.status !== 'paid') return { kind: 'not_paid', status: invoice.status || 'unknown' }
  const credited = await ports.complete(invoice)
  if (!credited) return { kind: 'unknown' }
  return { kind: credited.result, amountUsd: credited.amountUsd, ...(credited.balance !== undefined ? { balance: credited.balance } : {}) }
}

export interface WebhookAnswer {
  status: number
  body: Record<string, unknown>
}

/**
 * A webhook of CryptoBot. 200 = taken care of (also for what is none of our business, so that CryptoBot stops sending it); 401 = not from CryptoBot;
 * 503 / 500 = could not do it now, CryptoBot should send it again.
 */
export async function handleWebhook(rawBody: string, signature: string | null, token: string, ports: CreditPorts): Promise<WebhookAnswer> {
  if (rawBody.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: 'too_large' } }
  if (!(await verifyWebhookSignature(token, rawBody, signature))) {
    ports.log.warn('webhook with a bad signature refused', { error_code: 'bad_signature' })
    return { status: 401, body: { error: 'invalid_signature' } }
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid_input' } }
  }
  const update = parsePaidUpdate(body)
  if ('ignore' in update) {
    ports.log.info('webhook ignored', { reason: update.ignore })
    return { status: 200, body: { ok: true, ignored: true } }
  }

  let settled: Settled
  try {
    settled = await settleInvoice(update.invoice.invoiceId, ports)
  } catch (e) {
    if (e instanceof CryptoPayError) {
      ports.log.warn('the invoice could not be confirmed with CryptoBot; it will be sent again', { error_code: 'confirm_failed', kind: e.kind })
      return { status: 503, body: { error: 'unavailable' } }
    }
    ports.log.error('the deposit could not be booked; it will be sent again', { err: e, error_code: 'credit_failed', invoice_id: update.invoice.invoiceId })
    return { status: 500, body: { error: 'server_error' } }
  }

  switch (settled.kind) {
    case 'credited':
      ports.log.info('deposit credited', { invoice_id: update.invoice.invoiceId, amount_usd: settled.amountUsd })
      return { status: 200, body: { ok: true, result: 'credited' } }
    case 'already_credited':
      return { status: 200, body: { ok: true, result: 'already_credited' } }
    case 'review':
      ports.log.error('a paid invoice does not match what was asked for: nothing credited, it needs a look', { error_code: 'invoice_mismatch', invoice_id: update.invoice.invoiceId })
      return { status: 200, body: { ok: true, result: 'review' } }
    case 'not_paid':
      ports.log.warn('a signed webhook for an invoice that CryptoBot does not call paid: ignored', { status: settled.status, invoice_id: update.invoice.invoiceId })
      return { status: 200, body: { ok: true, ignored: true } }
    default:
      ports.log.warn('a paid invoice that is not one of ours: ignored', { invoice_id: update.invoice.invoiceId })
      return { status: 200, body: { ok: true, ignored: true } }
  }
}
