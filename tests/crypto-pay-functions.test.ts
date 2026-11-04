// The two Edge Functions of the CryptoBot deposit, RUN (Deno, the Supabase client and CryptoBot are stand-ins): the webhook with a real signature, and the
// customer's call that makes an invoice and asks whether it was paid.
import { createHash, createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { signJwt } from '../supabase/functions/_shared/jwt.ts'

const TOKEN = '12345:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr' // secret-scan:allow (test-only value)
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef' // secret-scan:allow (test-only value)
const USER_ID = '3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12'
const ROW_ID = '9c1b1f7e-2d3a-4c5b-8e6f-0a1b2c3d4e5f'
const sign = (body: string, token = TOKEN) => createHmac('sha256', createHash('sha256').update(token).digest()).update(body).digest('hex')

// ---- the Supabase client: rpc answers and a few tables -----------------------------------------------------------------------------------------
type Rpc = { name: string; args: Record<string, unknown> }
const rpcCalls: Rpc[] = []
const updates: { table: string; values: Record<string, unknown>; where: [string, unknown] }[] = []
let rpcAnswer: (c: Rpc) => { data: unknown; error: { message: string } | null } = () => ({ data: null, error: null })
let tables: Record<string, Record<string, unknown>[]> = {}

vi.mock('npm:@supabase/supabase-js@2', () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => { const c = { name, args }; rpcCalls.push(c); return rpcAnswer(c) },
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: unknown) => ({ maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => r[col] === val) ?? null, error: null }) }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async (col: string, val: unknown) => { updates.push({ table, values, where: [col, val] }); return { error: null } },
      }),
    }),
  }),
}))

describe('the Crypto Pay Edge Functions', () => {
  const handlers: Record<string, (req: Request) => Promise<Response>> = {}
  let env: Record<string, string | undefined> = {}
  let order: string[] = ['webhook', 'create']
  const lines: string[] = []
  const api: { method: string; body: Record<string, unknown> }[] = []
  let cryptoBot: (method: string, body: Record<string, unknown>) => Response

  beforeAll(async () => {
    ;(globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => env[name] }, serve: (h: (req: Request) => Promise<Response>) => { handlers[order.shift()!] = h } }
    const webhook = '../supabase/functions/cryptopay-webhook/index.ts'
    const create = '../supabase/functions/create-crypto-invoice/index.ts'
    await import(/* @vite-ignore */ webhook)
    await import(/* @vite-ignore */ create)
  })
  afterAll(() => { delete (globalThis as { Deno?: unknown }).Deno })

  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  beforeEach(() => {
    env = { CRYPTO_PAY_API_TOKEN: TOKEN, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', JWT_SECRET }
    rpcCalls.length = 0
    updates.length = 0
    api.length = 0
    lines.length = 0
    tables = { platform_settings: [{ id: 1, global_orders_enabled: true, global_payments_enabled: true, maintenance_mode: false, deferred_orders_enabled: false, deferred_orders_cap: 0, deferred_orders_ttl_hours: 24 }] }
    rpcAnswer = () => ({ data: null, error: null })
    cryptoBot = () => answer({ ok: false, error: { name: 'UNEXPECTED' } }, 500)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = String(url).split('/').pop()!
      api.push({ method, body: JSON.parse(String(init.body)) })
      return cryptoBot(method, JSON.parse(String(init.body)))
    }))
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  // ======================================================================================================================================================
  describe('cryptopay-webhook', () => {
    const body = JSON.stringify({ update_id: 1, update_type: 'invoice_paid', request_date: '2026-11-05T10:00:00Z', payload: { invoice_id: 555, status: 'paid', amount: '9999' } })
    const send = (raw = body, headers: Record<string, string> = { 'crypto-pay-api-signature': sign(raw) }) =>
      handlers.webhook!(new Request('https://x.supabase.co/functions/v1/cryptopay-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw }))
    const paidAtCryptoBot = () => { cryptoBot = () => answer({ ok: true, result: { items: [{ invoice_id: 555, status: 'paid', fiat: 'USD', amount: '25', paid_asset: 'USDT', paid_amount: '25.01' }] } }) }

    it('a genuine webhook credits what CryptoBot confirms, once, and answers 200', async () => {
      paidAtCryptoBot()
      rpcAnswer = () => ({ data: { result: 'credited', amount_usd: 25, balance: 40 }, error: null })
      const res = await send()
      expect([res.status, await res.json()]).toEqual([200, { ok: true, result: 'credited' }])
      expect(api).toEqual([{ method: 'getInvoices', body: { invoice_ids: '555' } }])
      // the credit is called with CryptoBot's answer (25), not with the 9999 the request carried
      expect(rpcCalls).toEqual([{ name: 'complete_crypto_pay_invoice', args: { p_invoice_id: 555, p_paid_asset: 'USDT', p_paid_amount: 25.01, p_fiat: 'USD', p_fiat_amount: 25 } }])
    })
    it('a bad or missing signature is 401: CryptoBot is not asked and nothing is credited', async () => {
      paidAtCryptoBot()
      const wrong: Record<string, string>[] = [{}, { 'crypto-pay-api-signature': 'f'.repeat(64) }, { 'crypto-pay-api-signature': sign(body, 'another:tokenvalue0000') }, { 'crypto-pay-api-signature': sign(body.replace('555', '556')) }]
      for (const headers of wrong) {
        expect((await send(body, headers)).status, JSON.stringify(headers).slice(0, 40)).toBe(401)
      }
      expect(api).toEqual([])
      expect(rpcCalls).toEqual([])
    })
    it('GET and the like are refused; a body that is too big is 413', async () => {
      expect((await handlers.webhook!(new Request('https://x/f', { method: 'GET' }))).status).toBe(405)
      expect((await send(JSON.stringify({ pad: 'x'.repeat(70_000) }), {})).status).toBe(413)
      expect(rpcCalls).toEqual([])
    })
    it('without a proper token the function does nothing and says it is not configured', async () => {
      for (const token of [undefined, '', 'not-a-token']) {
        env.CRYPTO_PAY_API_TOKEN = token
        expect((await send()).status, String(token)).toBe(503)
      }
      expect(rpcCalls).toEqual([])
    })
    it('the testnet token talks to the testnet', async () => {
      env.CRYPTO_PAY_NETWORK = 'testnet'
      paidAtCryptoBot()
      rpcAnswer = () => ({ data: { result: 'already_credited', amount_usd: 25 }, error: null })
      await send()
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://testnet-pay.crypt.bot/api/getInvoices')
      expect(vi.mocked(fetch).mock.calls[0]![1]!.headers).toMatchObject({ 'Crypto-Pay-API-Token': TOKEN })
    })
    it('a webhook that arrives again finds the invoice credited: 200 and nothing new', async () => {
      paidAtCryptoBot()
      rpcAnswer = () => ({ data: { result: 'already_credited', amount_usd: 25 }, error: null })
      expect(await (await send()).json()).toEqual({ ok: true, result: 'already_credited' })
    })
    it('an invoice that is not ours is 200 (CryptoBot stops sending it); a database error is 500 (it sends it again)', async () => {
      paidAtCryptoBot()
      rpcAnswer = () => ({ data: null, error: { message: 'unknown_invoice: no invoice 555 was created here' } })
      expect([(await send()).status]).toEqual([200])
      rpcAnswer = () => ({ data: null, error: { message: 'connection lost' } })
      expect((await send()).status).toBe(500)
      rpcAnswer = () => ({ data: { result: 'surprise' }, error: null })
      expect((await send()).status).toBe(500)
    })
    it('CryptoBot not answering is 503, and an invoice it does not call paid is ignored', async () => {
      cryptoBot = () => new Response('bad gateway', { status: 502 })
      expect((await send()).status).toBe(503)
      cryptoBot = () => answer({ ok: true, result: { items: [{ invoice_id: 555, status: 'active' }] } })
      expect(await (await send()).json()).toEqual({ ok: true, ignored: true })
      expect(rpcCalls).toEqual([])
    })
    it('a paid invoice reported with another amount is put aside by the database (review) and answered 200', async () => {
      paidAtCryptoBot()
      rpcAnswer = () => ({ data: { result: 'review', amount_usd: 25 }, error: null })
      expect(await (await send()).json()).toEqual({ ok: true, result: 'review' })
    })
    it('nothing it writes to its logs contains the token or a signature', async () => {
      paidAtCryptoBot()
      rpcAnswer = () => ({ data: null, error: { message: `boom ${TOKEN}` } })
      await send()
      await send(body, { 'crypto-pay-api-signature': 'a'.repeat(64) })
      const everything = lines.join('\n')
      expect(everything.length).toBeGreaterThan(0)
      expect(everything).not.toContain(TOKEN)
      expect(everything).not.toContain(sign(body))
    })
  })

  // ======================================================================================================================================================
  describe('create-crypto-invoice', () => {
    const jwt = () => signJwt({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', telegram_id: 777 }, JWT_SECRET, 3600).then((r) => r.token)
    const call = async (payload: unknown, token: string | null = null, method = 'POST') => {
      const t = token ?? (await jwt())
      return handlers.create!(new Request('https://x.supabase.co/functions/v1/create-crypto-invoice', { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: method === 'POST' ? JSON.stringify(payload) : undefined }))
    }
    const invoiceAtCryptoBot = { ok: true, result: { invoice_id: 555, status: 'active', bot_invoice_url: 'https://t.me/CryptoBot?start=IVabc', mini_app_invoice_url: 'https://t.me/CryptoBot/app?startapp=invoice-abc', web_app_invoice_url: 'https://app.send.tg/invoices/abc' } }
    const madeRow = () => { rpcAnswer = (c) => (c.name === 'create_crypto_pay_invoice' ? { data: { id: ROW_ID, expires_at: '2026-11-05T11:00:00Z' }, error: null } : { data: null, error: null }) }

    it('makes a USD invoice for exactly what the customer entered and returns the links', async () => {
      madeRow()
      cryptoBot = () => answer(invoiceAtCryptoBot)
      const res = await call({ amountUsd: 25 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        success: true,
        invoice: { id: ROW_ID, payUrl: 'https://t.me/CryptoBot?start=IVabc', miniAppUrl: 'https://t.me/CryptoBot/app?startapp=invoice-abc', webAppUrl: 'https://app.send.tg/invoices/abc', amountUsd: 25, expiresAt: '2026-11-05T11:00:00Z' },
      })
      // the row first (with the cap), then CryptoBot, then the id is saved on the row
      expect(rpcCalls).toEqual([{ name: 'create_crypto_pay_invoice', args: { p_user_id: USER_ID, p_amount_usd: 25, p_network: 'mainnet', p_ttl_seconds: 3600, p_max_pending: 5 } }])
      expect(api[0]).toMatchObject({ method: 'createInvoice', body: { currency_type: 'fiat', fiat: 'USD', amount: '25.00', payload: ROW_ID, accepted_assets: 'USDT,TON' } })
      expect(updates).toEqual([{ table: 'crypto_pay_invoices', values: { invoice_id: 555, pay_url: 'https://t.me/CryptoBot?start=IVabc', mini_app_url: 'https://t.me/CryptoBot/app?startapp=invoice-abc', web_app_url: 'https://app.send.tg/invoices/abc' }, where: ['id', ROW_ID] }])
    })
    it('the customer is the one in the token, never one named in the body', async () => {
      madeRow()
      cryptoBot = () => answer(invoiceAtCryptoBot)
      await call({ amountUsd: 5, userId: '00000000-0000-4000-8000-000000000001', user_id: 'x' })
      expect(rpcCalls[0]!.args.p_user_id).toBe(USER_ID)
    })
    it('refuses a request without a valid token of the app', async () => {
      expect((await call({ amountUsd: 5 }, 'not.a.jwt')).status).toBe(401)
      const forged = (await signJwt({ sub: USER_ID, role: 'authenticated', aud: 'authenticated' }, 'another-secret-another-secret-12345', 3600)).token
      expect((await call({ amountUsd: 5 }, forged)).status).toBe(401)
      expect(rpcCalls).toEqual([])
      expect(api).toEqual([])
    })
    it('refuses an amount outside the limits or with too many decimals before anything is written', async () => {
      for (const amountUsd of [0.5, 0, -5, 501, 1000, 10.005, '10', null, undefined]) {
        expect((await call({ amountUsd })).status, String(amountUsd)).toBe(400)
      }
      expect(rpcCalls).toEqual([])
      expect(api).toEqual([])
    })
    it('without a token of the Crypto Pay app, deposits this way are unavailable', async () => {
      env.CRYPTO_PAY_API_TOKEN = undefined
      expect((await call({ amountUsd: 5 })).status).toBe(503)
      expect(rpcCalls).toEqual([])
    })
    it('while payments are paused (the kill switch) no invoice is made', async () => {
      tables.platform_settings![0]!.global_payments_enabled = false
      const res = await call({ amountUsd: 5 })
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe('deposits_unavailable')
      expect(rpcCalls).toEqual([])
    })
    it('a suspended customer: 403; too many unpaid invoices: 429; neither reaches CryptoBot', async () => {
      rpcAnswer = () => ({ data: null, error: { message: 'banned: the account is suspended' } })
      expect((await call({ amountUsd: 5 })).status).toBe(403)
      rpcAnswer = () => ({ data: null, error: { message: 'too_many_pending: 5 unpaid invoices are open' } })
      expect((await call({ amountUsd: 5 })).status).toBe(429)
      expect(api).toEqual([])
    })
    it('CryptoBot refusing or not answering: 502, and the row is marked failed so it does not count as open', async () => {
      madeRow()
      for (const reply of [() => answer({ ok: false, error: { name: 'AMOUNT_TOO_SMALL' } }, 400), () => new Response('down', { status: 503 })]) {
        updates.length = 0
        cryptoBot = reply
        expect((await call({ amountUsd: 5 })).status).toBe(502)
        expect(updates).toEqual([{ table: 'crypto_pay_invoices', values: { status: 'failed' }, where: ['id', ROW_ID] }])
      }
    })

    describe('asking after a payment', () => {
      const ask = (invoiceId: unknown) => call({ action: 'status', invoiceId })
      it('another customer\'s invoice, or one that does not exist, is "not found"; something that is not an id is a bad request', async () => {
        tables.crypto_pay_invoices = [{ id: ROW_ID, user_id: '00000000-0000-4000-8000-0000000000aa', status: 'pending', amount_usd: 25, invoice_id: 555 }]
        expect((await ask(ROW_ID)).status).toBe(404)
        expect((await ask('9c1b1f7e-2d3a-4c5b-8e6f-000000000000')).status).toBe(404)
        for (const bad of ['x', 5, null, "'; drop table crypto_pay_invoices;--"]) expect((await ask(bad)).status, String(bad)).toBe(400)
        expect(api).toEqual([])
        expect(rpcCalls).toEqual([])
      })
      it('an unpaid invoice that CryptoBot now calls paid is credited here (the webhook may be late), once', async () => {
        tables.crypto_pay_invoices = [{ id: ROW_ID, user_id: USER_ID, status: 'pending', amount_usd: 25, invoice_id: 555 }]
        cryptoBot = () => answer({ ok: true, result: { items: [{ invoice_id: 555, status: 'paid', fiat: 'USD', amount: '25', paid_asset: 'TON', paid_amount: '4.9' }] } })
        rpcAnswer = () => ({ data: { result: 'credited', amount_usd: 25, balance: 40 }, error: null })
        expect(await (await ask(ROW_ID)).json()).toEqual({ success: true, status: 'paid', amountUsd: 25, balance: 40 })
        expect(rpcCalls).toEqual([{ name: 'complete_crypto_pay_invoice', args: { p_invoice_id: 555, p_paid_asset: 'TON', p_paid_amount: 4.9, p_fiat: 'USD', p_fiat_amount: 25 } }])
      })
      it('still unpaid: pending, nothing credited; CryptoBot not answering: still pending, not an error', async () => {
        tables.crypto_pay_invoices = [{ id: ROW_ID, user_id: USER_ID, status: 'pending', amount_usd: 25, invoice_id: 555 }]
        cryptoBot = () => answer({ ok: true, result: { items: [{ invoice_id: 555, status: 'active' }] } })
        expect(await (await ask(ROW_ID)).json()).toEqual({ success: true, status: 'pending', amountUsd: 25 })
        cryptoBot = () => new Response('down', { status: 502 })
        expect(await (await ask(ROW_ID)).json()).toEqual({ success: true, status: 'pending', amountUsd: 25 })
        expect(rpcCalls).toEqual([])
      })
      it('an invoice already settled is reported as it is, without asking CryptoBot', async () => {
        tables.crypto_pay_invoices = [{ id: ROW_ID, user_id: USER_ID, status: 'paid', amount_usd: 25, invoice_id: 555 }]
        expect(await (await ask(ROW_ID)).json()).toEqual({ success: true, status: 'paid', amountUsd: 25 })
        expect(api).toEqual([])
      })
    })
  })
})
