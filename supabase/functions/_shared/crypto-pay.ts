// Crypto Pay (@CryptoBot): the signature of its webhooks, the two API calls we make, and the rules for what a paid invoice may credit. Pure except for the
// injected `fetch`, so it is tested in Node without a network.
//
// THE WEBHOOK SIGNATURE. CryptoBot signs every webhook: the header `crypto-pay-api-signature` is the hex of
//     HMAC-SHA256( key = SHA256(API token), message = the RAW body of the request )
// Anyone who does not have the API token cannot compute it, so a request that passes is from CryptoBot. It is checked against the raw bytes as they came
// (never re-serialised JSON) and compared in constant time, before the body is parsed or anything is read from the database.

import { timingSafeEqual } from './telegram.ts'

export const CRYPTO_PAY_MAINNET = 'https://pay.crypt.bot/api'
export const CRYPTO_PAY_TESTNET = 'https://testnet-pay.crypt.bot/api'

/** What a customer may deposit this way, in dollars. The most is the platform's own deposit ceiling. */
export const CRYPTO_PAY_MIN_USD = 1
export const CRYPTO_PAY_MAX_USD = 500
/** How long an invoice can be paid, and how many unpaid ones a customer may have open. */
export const INVOICE_TTL_SECONDS = 3_600
export const MAX_PENDING_INVOICES = 5
/** The coins offered on the payment page. CryptoBot converts the dollars to them at its own current rate. */
export const ACCEPTED_ASSETS = 'USDT,TON'
export const MAX_WEBHOOK_BYTES = 65_536

const encoder = new TextEncoder()

export const cryptoPayBase = (network: string | undefined): string => (network === 'testnet' ? CRYPTO_PAY_TESTNET : CRYPTO_PAY_MAINNET)

/** An API token of an app made in @CryptoPayBot looks like `12345:AAxxxxxxxx`. */
export const looksLikeCryptoPayToken = (token: string | undefined): token is string => typeof token === 'string' && /^\d{1,12}:[A-Za-z0-9]{10,100}$/.test(token)

// ---- the signature ----------------------------------------------------------------------------------------------------------------------------

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The signature CryptoBot puts on a body: HMAC-SHA256 under SHA256(token), in lower-case hex. */
export async function signWebhookBody(token: string, rawBody: string): Promise<string> {
  const secret = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)))
}

/**
 * Does `signature` belong to this raw body? False for anything that is not exactly the 64 hex characters of the right answer: a missing header, another
 * length, a body changed by one byte, another token. The comparison does not stop at the first difference.
 */
export async function verifyWebhookSignature(token: string, rawBody: string, signature: string | null | undefined): Promise<boolean> {
  if (typeof signature !== 'string' || !/^[0-9a-fA-F]{64}$/.test(signature)) return false
  const expected = await signWebhookBody(token, rawBody)
  return timingSafeEqual(encoder.encode(expected), encoder.encode(signature.toLowerCase()))
}

// ---- what comes in ----------------------------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An invoice as CryptoBot describes it, with only the fields we use, each checked for its type. */
export interface CryptoInvoice {
  invoiceId: number
  status: string
  /** What we put in the invoice when we made it: our own row id. */
  payload: string | null
  /** For an invoice made in a fiat currency: that currency and the amount in it (as CryptoBot reports them). */
  fiat: string | null
  amount: number | null
  paidAsset: string | null
  paidAmount: number | null
  botUrl: string | null
  miniAppUrl: string | null
  webAppUrl: string | null
}

const text = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export function parseInvoice(raw: unknown): CryptoInvoice | null {
  if (!isRecord(raw)) return null
  const id = num(raw.invoice_id)
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null
  return {
    invoiceId: id,
    status: typeof raw.status === 'string' ? raw.status : '',
    payload: text(raw.payload, 200),
    fiat: text(raw.fiat, 10),
    amount: num(raw.amount),
    paidAsset: text(raw.paid_asset, 20) ?? text(raw.asset, 20),
    paidAmount: num(raw.paid_amount),
    botUrl: text(raw.bot_invoice_url),
    miniAppUrl: text(raw.mini_app_invoice_url),
    webAppUrl: text(raw.web_app_invoice_url),
  }
}

/** The update of a webhook: only `invoice_paid` with an invoice in it is something we act on. */
export function parsePaidUpdate(body: unknown): { invoice: CryptoInvoice } | { ignore: string } {
  if (!isRecord(body)) return { ignore: 'not an update' }
  if (body.update_type !== 'invoice_paid') return { ignore: `update type ${typeof body.update_type === 'string' ? body.update_type.slice(0, 40) : '?'}` }
  const invoice = parseInvoice(body.payload)
  return invoice ? { invoice } : { ignore: 'no invoice in the update' }
}

// ---- the calls we make ----------------------------------------------------------------------------------------------------------------------

export class CryptoPayError extends Error {
  constructor(readonly kind: 'unavailable' | 'rejected', message: string) {
    super(message)
  }
}

export interface CryptoPayClient {
  /** A fiat (USD) invoice: the customer pays the dollars' worth in USDT or TON. `payload` comes back to us in the webhook. */
  createInvoice(args: { amountUsd: number; payload: string; description: string; expiresInSeconds: number }): Promise<CryptoInvoice>
  /** The invoice as CryptoBot has it now, or null when it knows no such invoice. */
  getInvoice(invoiceId: number): Promise<CryptoInvoice | null>
}

export function createCryptoPayClient(config: { token: string; network?: string; fetch?: typeof fetch; timeoutMs?: number }): CryptoPayClient {
  const base = cryptoPayBase(config.network)
  const doFetch = config.fetch ?? fetch
  const call = async (method: string, params: Record<string, string | number | boolean>): Promise<unknown> => {
    let res: Response
    try {
      res = await doFetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': config.token },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(config.timeoutMs ?? 8_000),
      })
    } catch {
      throw new CryptoPayError('unavailable', `${method}: no answer`)
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      /* an error page: handled below */
    }
    if (res.status >= 500 || (!isRecord(body) && !res.ok)) throw new CryptoPayError('unavailable', `${method}: HTTP ${res.status}`)
    if (!isRecord(body) || body.ok !== true) {
      const error = isRecord(body) && isRecord(body.error) ? text(body.error.name, 80) ?? text(body.error.code, 20) : null
      throw new CryptoPayError('rejected', `${method}: ${error ?? `HTTP ${res.status}`}`)
    }
    return body.result
  }

  return {
    async createInvoice({ amountUsd, payload, description, expiresInSeconds }) {
      const result = await call('createInvoice', {
        currency_type: 'fiat',
        fiat: 'USD',
        accepted_assets: ACCEPTED_ASSETS,
        amount: amountUsd.toFixed(2),
        description,
        payload,
        expires_in: expiresInSeconds,
        allow_comments: false,
        allow_anonymous: false,
      })
      const invoice = parseInvoice(result)
      if (!invoice || !(invoice.botUrl || invoice.miniAppUrl || invoice.webAppUrl)) throw new CryptoPayError('rejected', 'createInvoice: no invoice or no link in the answer')
      return invoice
    },
    async getInvoice(invoiceId) {
      const result = await call('getInvoices', { invoice_ids: String(invoiceId) })
      const items = isRecord(result) && Array.isArray(result.items) ? result.items : Array.isArray(result) ? result : []
      for (const item of items) {
        const invoice = parseInvoice(item)
        if (invoice && invoice.invoiceId === invoiceId) return invoice
      }
      return null
    },
  }
}

// ---- what a paid invoice may credit -----------------------------------------------------------------------------------------------------------

/** Whole cents from dollars with at most 2 decimals, within the limits of this channel; an error sentence otherwise. */
export function validateInvoiceAmountUsd(amountUsd: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) return { ok: false, error: 'Enter a deposit amount' }
  const cents = Math.round(amountUsd * 100)
  if (Math.abs(cents / 100 - amountUsd) > 1e-9) return { ok: false, error: 'Use at most 2 decimal places' }
  if (cents < CRYPTO_PAY_MIN_USD * 100) return { ok: false, error: `Minimum deposit is $${CRYPTO_PAY_MIN_USD.toFixed(2)}` }
  if (cents > CRYPTO_PAY_MAX_USD * 100) return { ok: false, error: `Maximum deposit is $${CRYPTO_PAY_MAX_USD.toFixed(2)}` }
  return { ok: true, value: cents / 100 }
}
