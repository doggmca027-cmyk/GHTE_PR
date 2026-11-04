// Deposits through Crypto Pay (@CryptoBot), the parts that need no database: the signature of a webhook, what is read from CryptoBot's answers, the two API
// calls, and the whole path of a webhook (signature -> a second look at the invoice -> the credit) on stand-in ports.
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ACCEPTED_ASSETS, CRYPTO_PAY_MAINNET, CRYPTO_PAY_MAX_USD, CRYPTO_PAY_MIN_USD, CRYPTO_PAY_TESTNET, CryptoPayError, createCryptoPayClient, cryptoPayBase,
  looksLikeCryptoPayToken, parseInvoice, parsePaidUpdate, signWebhookBody, validateInvoiceAmountUsd, verifyWebhookSignature, type CryptoInvoice,
} from '../supabase/functions/_shared/crypto-pay.ts'
import { handleWebhook, settleInvoice, type CreditPorts, type CreditResult } from '../supabase/functions/_shared/crypto-pay-flow.ts'

const TOKEN = '12345:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr' // secret-scan:allow (test-only value)
const BODY = JSON.stringify({ update_id: 7, update_type: 'invoice_paid', request_date: '2026-11-05T10:00:00Z', payload: { invoice_id: 555, status: 'paid' } })
/** The signature as CryptoBot documents it, computed here with node:crypto, not with the code under test. */
const reference = (token: string, body: string) => createHmac('sha256', createHash('sha256').update(token).digest()).update(body).digest('hex')

describe('the signature of a webhook', () => {
  it('is HMAC-SHA256 of the raw body under SHA-256 of the API token, in hex: the same as an independent implementation', async () => {
    expect(await signWebhookBody(TOKEN, BODY)).toBe(reference(TOKEN, BODY))
    expect(await signWebhookBody(TOKEN, '')).toBe(reference(TOKEN, ''))
    expect(await signWebhookBody(TOKEN, 'тело с юникодом ✓')).toBe(reference(TOKEN, 'тело с юникодом ✓'))
  })
  it('accepts the right one, in upper case too', async () => {
    const good = reference(TOKEN, BODY)
    expect(await verifyWebhookSignature(TOKEN, BODY, good)).toBe(true)
    expect(await verifyWebhookSignature(TOKEN, BODY, good.toUpperCase())).toBe(true)
  })
  it('refuses everything else: a body changed by one character, another token, a missing, short, long or non-hex signature', async () => {
    const good = reference(TOKEN, BODY)
    expect(await verifyWebhookSignature(TOKEN, BODY.replace('555', '556'), good)).toBe(false)
    expect(await verifyWebhookSignature(TOKEN, `${BODY} `, good)).toBe(false)
    expect(await verifyWebhookSignature(`${TOKEN}x`, BODY, good)).toBe(false)
    expect(await verifyWebhookSignature(TOKEN, BODY, reference('other:token000000', BODY))).toBe(false)
    for (const bad of [null, undefined, '', good.slice(1), `${good}0`, `${good.slice(0, 63)}g`, ` ${good}`, `${good} `, 'sha256=' + good]) {
      expect(await verifyWebhookSignature(TOKEN, BODY, bad), String(bad).slice(0, 12)).toBe(false)
    }
  })
  it('is checked on the bytes as they came: re-serialised JSON is another body', async () => {
    const good = reference(TOKEN, BODY)
    expect(await verifyWebhookSignature(TOKEN, JSON.stringify(JSON.parse(BODY), null, 2), good)).toBe(false)
    expect(await verifyWebhookSignature(TOKEN, JSON.stringify({ ...JSON.parse(BODY) }), good)).toBe(true) // the same text again
  })
})

describe('the app token and the network', () => {
  it('a token looks like <digits>:<letters and digits>', () => {
    expect(looksLikeCryptoPayToken(TOKEN)).toBe(true)
    for (const bad of [undefined, '', 'AAbbCCddEEffGG', '12345:', '12345:short', '12345:has space in it', 'x:AAbbCCddEEffGGhh', '1234567890123:AAbbCCddEEffGGhh']) expect(looksLikeCryptoPayToken(bad), String(bad)).toBe(false)
  })
  it('testnet only when it says so', () => {
    expect(cryptoPayBase('testnet')).toBe(CRYPTO_PAY_TESTNET)
    for (const n of ['mainnet', undefined, '', 'TESTNET', 'prod']) expect(cryptoPayBase(n)).toBe(CRYPTO_PAY_MAINNET)
  })
})

describe('what is read from CryptoBot', () => {
  const invoice = { invoice_id: 555, status: 'paid', payload: 'row-id', currency_type: 'fiat', fiat: 'USD', amount: '25.00', paid_asset: 'USDT', paid_amount: '25.01', bot_invoice_url: 'https://t.me/CryptoBot?start=IVabc', mini_app_invoice_url: 'https://t.me/CryptoBot/app?startapp=invoice-abc', web_app_invoice_url: 'https://app.send.tg/invoices/abc' }
  it('an invoice with its numbers as numbers, whether CryptoBot writes them as text or as numbers', () => {
    expect(parseInvoice(invoice)).toEqual({
      invoiceId: 555, status: 'paid', payload: 'row-id', fiat: 'USD', amount: 25, paidAsset: 'USDT', paidAmount: 25.01,
      botUrl: 'https://t.me/CryptoBot?start=IVabc', miniAppUrl: 'https://t.me/CryptoBot/app?startapp=invoice-abc', webAppUrl: 'https://app.send.tg/invoices/abc',
    })
    expect(parseInvoice({ invoice_id: 7, status: 'active', amount: 5 })).toMatchObject({ invoiceId: 7, amount: 5, fiat: null, paidAsset: null, botUrl: null })
  })
  it.each([[null], ['x'], [[]], [{}], [{ invoice_id: 0 }], [{ invoice_id: -3 }], [{ invoice_id: 1.5 }], [{ invoice_id: 'abc' }], [{ invoice_id: 2 ** 60 }]])('%j is no invoice', (raw) => {
    expect(parseInvoice(raw)).toBeNull()
  })
  it('only an invoice_paid update with an invoice in it is acted on', () => {
    expect(parsePaidUpdate({ update_id: 1, update_type: 'invoice_paid', payload: invoice })).toMatchObject({ invoice: { invoiceId: 555 } })
    for (const body of [null, 'x', [], {}, { update_type: 'invoice_expired', payload: invoice }, { update_type: 'invoice_paid' }, { update_type: 'invoice_paid', payload: { status: 'paid' } }]) {
      expect(parsePaidUpdate(body), JSON.stringify(body)).toHaveProperty('ignore')
    }
  })
})

describe('the amount of a deposit', () => {
  it('whole cents between the minimum and the ceiling', () => {
    expect(validateInvoiceAmountUsd(10)).toEqual({ ok: true, value: 10 })
    expect(validateInvoiceAmountUsd(12.34)).toEqual({ ok: true, value: 12.34 })
    expect(validateInvoiceAmountUsd(CRYPTO_PAY_MIN_USD)).toMatchObject({ ok: true })
    expect(validateInvoiceAmountUsd(CRYPTO_PAY_MAX_USD)).toMatchObject({ ok: true })
  })
  it.each([[0.5], [0.99], [CRYPTO_PAY_MAX_USD + 0.01], [1000], [-5], [10.005], [NaN], [Infinity], ['10'], [null], [undefined]])('%s is refused', (amount) => {
    expect(validateInvoiceAmountUsd(amount).ok).toBe(false)
  })
})

describe('the calls to CryptoBot', () => {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const calls: { url: string; init: RequestInit }[] = []
  const client = (reply: () => Response | Promise<Response>, network?: string) => {
    calls.length = 0
    return createCryptoPayClient({ token: TOKEN, network, fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return reply() }) as unknown as typeof fetch })
  }
  const created = { ok: true, result: { invoice_id: 555, status: 'active', bot_invoice_url: 'https://t.me/CryptoBot?start=IVabc', mini_app_invoice_url: 'https://t.me/CryptoBot/app?startapp=invoice-abc', payload: 'row-1' } }

  it('createInvoice: a fiat (USD) invoice paid in USDT or TON, with our row id as the payload, authenticated by the token header', async () => {
    const invoice = await client(() => answer(created)).createInvoice({ amountUsd: 12.5, payload: 'row-1', description: 'GRAM Hub balance top-up', expiresInSeconds: 3600 })
    expect(invoice).toMatchObject({ invoiceId: 555, botUrl: 'https://t.me/CryptoBot?start=IVabc', miniAppUrl: expect.stringContaining('startapp=invoice-abc') })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${CRYPTO_PAY_MAINNET}/createInvoice`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toMatchObject({ 'Crypto-Pay-API-Token': TOKEN, 'Content-Type': 'application/json' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      currency_type: 'fiat', fiat: 'USD', accepted_assets: ACCEPTED_ASSETS, amount: '12.50', description: 'GRAM Hub balance top-up', payload: 'row-1', expires_in: 3600,
      allow_comments: false, allow_anonymous: false,
    })
  })
  it('the testnet is another address', async () => {
    await client(() => answer(created), 'testnet').createInvoice({ amountUsd: 5, payload: 'r', description: 'd', expiresInSeconds: 600 })
    expect(calls[0]!.url).toBe(`${CRYPTO_PAY_TESTNET}/createInvoice`)
  })
  it('createInvoice: an answer without a link, an error of CryptoBot and a server error are told apart', async () => {
    const make = (reply: () => Response) => client(reply).createInvoice({ amountUsd: 5, payload: 'r', description: 'd', expiresInSeconds: 600 })
    await expect(make(() => answer({ ok: true, result: { invoice_id: 5, status: 'active' } }))).rejects.toMatchObject({ kind: 'rejected' })
    await expect(make(() => answer({ ok: false, error: { code: 400, name: 'AMOUNT_TOO_SMALL' } }, 400))).rejects.toThrow('AMOUNT_TOO_SMALL')
    await expect(make(() => answer({ ok: false, error: { code: 401, name: 'UNAUTHORIZED' } }, 401))).rejects.toMatchObject({ kind: 'rejected' })
    await expect(make(() => new Response('bad gateway', { status: 502 }))).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(make(() => new Response('<html>', { status: 200 }))).rejects.toBeInstanceOf(CryptoPayError)
  })
  it('a network failure or a timeout is "unavailable": it can be tried again', async () => {
    await expect(client(() => { throw new Error('ECONNRESET') }).getInvoice(5)).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(client(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))).getInvoice(5)).rejects.toMatchObject({ kind: 'unavailable' })
  })
  it('getInvoice asks for one id and finds it in the items; an invoice it does not know is null', async () => {
    const reply = { ok: true, result: { items: [{ invoice_id: 9, status: 'active' }, { invoice_id: 555, status: 'paid', fiat: 'USD', amount: '25' }] } }
    expect(await client(() => answer(reply)).getInvoice(555)).toMatchObject({ invoiceId: 555, status: 'paid', amount: 25 })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ invoice_ids: '555' })
    expect(calls[0]!.url).toBe(`${CRYPTO_PAY_MAINNET}/getInvoices`)
    expect(await client(() => answer({ ok: true, result: { items: [] } })).getInvoice(555)).toBeNull()
    expect(await client(() => answer({ ok: true, result: { items: [{ invoice_id: 9, status: 'paid' }] } })).getInvoice(555)).toBeNull() // another invoice is not this one
    expect(await client(() => answer({ ok: true, result: [{ invoice_id: 555, status: 'paid' }] })).getInvoice(555)).toMatchObject({ invoiceId: 555 }) // an older shape: a bare list
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The path of a webhook
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe('a webhook, from signature to credit', () => {
  const paid = (over: Partial<CryptoInvoice> = {}): CryptoInvoice => ({
    invoiceId: 555, status: 'paid', payload: 'row-1', fiat: 'USD', amount: 25, paidAsset: 'USDT', paidAmount: 25.01, botUrl: null, miniAppUrl: null, webAppUrl: null, ...over,
  })
  const harness = (parts: { invoice?: CryptoInvoice | null | Error; credit?: CreditResult | null | Error } = {}) => {
    const events: string[] = []
    const completed: CryptoInvoice[] = []
    const ports: CreditPorts = {
      client: {
        createInvoice: async () => { throw new Error('not used') },
        getInvoice: async (id) => {
          events.push(`ask ${id}`)
          const r = parts.invoice === undefined ? paid() : parts.invoice
          if (r instanceof Error) throw r
          return r
        },
      },
      complete: async (invoice) => {
        events.push('credit')
        completed.push(invoice)
        const r = parts.credit === undefined ? { result: 'credited' as const, amountUsd: 25, balance: 40 } : parts.credit
        if (r instanceof Error) throw r
        return r
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    return { ports, events, completed }
  }
  const signed = (body = BODY) => reference(TOKEN, body)

  it('a genuine webhook: CryptoBot is asked about the invoice, then it is credited, and the answer is 200', async () => {
    const h = harness()
    const res = await handleWebhook(BODY, signed(), TOKEN, h.ports)
    expect(res).toEqual({ status: 200, body: { ok: true, result: 'credited' } })
    expect(h.events).toEqual(['ask 555', 'credit']) // in this order
  })
  it('the credit follows what CryptoBot says the invoice is, not what the request says', async () => {
    const lying = JSON.stringify({ update_type: 'invoice_paid', payload: { invoice_id: 555, status: 'paid', fiat: 'USD', amount: '9999', paid_asset: 'TON' } })
    const h = harness({ invoice: paid({ amount: 25, paidAsset: 'USDT' }) })
    await handleWebhook(lying, signed(lying), TOKEN, h.ports)
    expect(h.completed[0]).toMatchObject({ amount: 25, paidAsset: 'USDT' })
  })

  it('a bad signature: 401, nothing is asked and nothing is credited', async () => {
    for (const signature of [null, '', 'abc', reference('another:tokenvalue00', BODY), signed().replace(/.$/, '0'), signed(`${BODY} `)]) {
      const h = harness()
      const res = await handleWebhook(BODY, signature, TOKEN, h.ports)
      expect(res.status, String(signature).slice(0, 10)).toBe(401)
      expect(h.events).toEqual([])
    }
  })
  it('a body changed after it was signed is refused', async () => {
    const h = harness()
    const tampered = BODY.replace('555', '556')
    expect((await handleWebhook(tampered, signed(), TOKEN, h.ports)).status).toBe(401)
    expect(h.events).toEqual([])
  })
  it('the signature is checked before the body is even read as JSON', async () => {
    const h = harness()
    expect((await handleWebhook('not json at all', 'f'.repeat(64), TOKEN, h.ports)).status).toBe(401)
    expect((await handleWebhook('not json at all', signed('not json at all'), TOKEN, h.ports)).status).toBe(400)
    expect(h.events).toEqual([])
  })
  it('a body that is too large is refused', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(70_000) })
    expect((await handleWebhook(big, signed(big), TOKEN, harness().ports)).status).toBe(413)
  })

  it('another kind of update is taken (200) and does nothing', async () => {
    const body = JSON.stringify({ update_type: 'invoice_expired', payload: { invoice_id: 555 } })
    const h = harness()
    expect(await handleWebhook(body, signed(body), TOKEN, h.ports)).toEqual({ status: 200, body: { ok: true, ignored: true } })
    expect(h.events).toEqual([])
  })
  it('a signed webhook for an invoice that CryptoBot does not call paid credits nothing', async () => {
    for (const invoice of [paid({ status: 'active' }), paid({ status: 'expired' }), paid({ status: '' }), null]) {
      const h = harness({ invoice })
      expect(await handleWebhook(BODY, signed(), TOKEN, h.ports), JSON.stringify(invoice)).toEqual({ status: 200, body: { ok: true, ignored: true } })
      expect(h.events).toEqual(['ask 555'])
    }
  })
  it('the same webhook twice: the second finds it credited already, still 200', async () => {
    const h = harness({ credit: { result: 'already_credited', amountUsd: 25 } })
    expect(await handleWebhook(BODY, signed(), TOKEN, h.ports)).toEqual({ status: 200, body: { ok: true, result: 'already_credited' } })
  })
  it('an invoice that is not one of ours is taken and ignored: CryptoBot should stop sending it', async () => {
    expect(await handleWebhook(BODY, signed(), TOKEN, harness({ credit: null }).ports)).toEqual({ status: 200, body: { ok: true, ignored: true } })
  })
  it('a paid invoice that does not match what was asked for is reported, with nothing credited by the flow', async () => {
    const h = harness({ credit: { result: 'review', amountUsd: 25 } })
    expect(await handleWebhook(BODY, signed(), TOKEN, h.ports)).toEqual({ status: 200, body: { ok: true, result: 'review' } })
    expect(h.ports.log.error).toHaveBeenCalledWith(expect.stringContaining('needs a look'), expect.objectContaining({ error_code: 'invoice_mismatch' }))
  })

  it('CryptoBot cannot be asked: 503, so that it sends the webhook again; nothing is credited', async () => {
    const h = harness({ invoice: new CryptoPayError('unavailable', 'getInvoices: HTTP 502') })
    expect((await handleWebhook(BODY, signed(), TOKEN, h.ports)).status).toBe(503)
    expect(h.events).toEqual(['ask 555'])
  })
  it('the database fails: 500, so that it is sent again', async () => {
    const h = harness({ credit: new Error('connection lost') })
    expect((await handleWebhook(BODY, signed(), TOKEN, h.ports)).status).toBe(500)
  })
  it('the token and the signature never reach the log', async () => {
    const h = harness({ credit: new Error('boom') })
    await handleWebhook(BODY, signed(), TOKEN, h.ports)
    await handleWebhook(BODY, 'a'.repeat(64), TOKEN, h.ports)
    const everything = JSON.stringify([h.ports.log.info, h.ports.log.warn, h.ports.log.error].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls))
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(signed())
  })
})

describe('asking after a payment (the customer\'s own check)', () => {
  it('credits an invoice that is paid, says "not paid" for one that is not, and reports CryptoBot being down by throwing', async () => {
    const ports = (invoice: CryptoInvoice | null | Error, credit: CreditResult | null = { result: 'credited', amountUsd: 5, balance: 9 }): CreditPorts => ({
      client: { createInvoice: async () => { throw new Error('unused') }, getInvoice: async () => { if (invoice instanceof Error) throw invoice; return invoice } },
      complete: async () => credit,
      log: { info() {}, warn() {}, error() {} },
    })
    const base: CryptoInvoice = { invoiceId: 1, status: 'paid', payload: null, fiat: 'USD', amount: 5, paidAsset: 'TON', paidAmount: 1, botUrl: null, miniAppUrl: null, webAppUrl: null }
    expect(await settleInvoice(1, ports(base))).toEqual({ kind: 'credited', amountUsd: 5, balance: 9 })
    expect(await settleInvoice(1, ports(base, { result: 'already_credited', amountUsd: 5 }))).toEqual({ kind: 'already_credited', amountUsd: 5 })
    expect(await settleInvoice(1, ports({ ...base, status: 'active' }))).toEqual({ kind: 'not_paid', status: 'active' })
    expect(await settleInvoice(1, ports(null))).toEqual({ kind: 'not_paid', status: 'not_found' })
    expect(await settleInvoice(1, ports(base, null))).toEqual({ kind: 'unknown' })
    await expect(settleInvoice(1, ports(new CryptoPayError('unavailable', 'x')))).rejects.toBeInstanceOf(CryptoPayError)
  })
})
