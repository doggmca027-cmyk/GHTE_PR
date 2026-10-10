import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TelegramAuthError,
  buildDataCheckString,
  computeInitDataHash,
  timingSafeEqual,
  verifyInitData,
} from '../supabase/functions/_shared/telegram.ts'
import { signJwt } from '../supabase/functions/_shared/jwt.ts'
import { calculateCustomerRate, selectPriceRule } from '../supabase/functions/_shared/price-engine.ts'
import { SMMProviderError, SMMv2Adapter, createSMMv2Adapter, mapProviderStatus } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { PriceRule } from '../supabase/functions/_shared/types.ts'

// ---------------------------------------------------------------------------
// 1. Telegram initData verification
// ---------------------------------------------------------------------------

// Known vector, computed independently with node:crypto (scratch script) following
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' // secret-scan:allow (sample token from Telegram docs)
const VECTOR_HASH = '561b89b7b53f01b0b09530181c80879a2bfcf378fade26b56f4d02c2c6da6593'
const VECTOR_INIT_DATA =
  'auth_date=1700000000&query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22en%22%2C%22is_premium%22%3Atrue%7D' +
  `&hash=${VECTOR_HASH}`
const AUTH_DATE = 1_700_000_000
const NOW = AUTH_DATE + 60

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'no-error'
  } catch (e) {
    return e instanceof TelegramAuthError ? e.code : `other:${String(e)}`
  }
}

describe('Telegram initData verification', () => {
  it('computes the known HMAC-SHA256 test vector', async () => {
    const dcs = buildDataCheckString(new URLSearchParams(VECTOR_INIT_DATA))
    expect(dcs.split('\n').map((l) => l.split('=')[0])).toEqual(['auth_date', 'query_id', 'user'])
    expect(await computeInitDataHash(dcs, BOT_TOKEN)).toBe(VECTOR_HASH)

    // Cross-check against node's own HMAC implementation.
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    expect(createHmac('sha256', secret).update(dcs).digest('hex')).toBe(VECTOR_HASH)
  })

  it('accepts valid initData and extracts the user', async () => {
    const result = await verifyInitData(VECTOR_INIT_DATA, BOT_TOKEN, { now: NOW })
    expect(result.user).toMatchObject({ id: 279058397, username: 'vdkfrost', first_name: 'Vladislav', language_code: 'en' })
    expect(result.authDate).toBe(AUTH_DATE)
  })

  it('rejects a tampered payload', async () => {
    const tampered = VECTOR_INIT_DATA.replace('279058397', '279058398')
    expect(await codeOf(verifyInitData(tampered, BOT_TOKEN, { now: NOW }))).toBe('invalid_signature')
  })

  it('rejects a different bot token', async () => {
    expect(await codeOf(verifyInitData(VECTOR_INIT_DATA, '1:other-token', { now: NOW }))).toBe('invalid_signature')
  })

  it('rejects missing, malformed and duplicated hashes', async () => {
    const withoutHash = VECTOR_INIT_DATA.replace(`&hash=${VECTOR_HASH}`, '')
    expect(await codeOf(verifyInitData(withoutHash, BOT_TOKEN, { now: NOW }))).toBe('missing_hash')
    expect(await codeOf(verifyInitData(withoutHash + '&hash=zz', BOT_TOKEN, { now: NOW }))).toBe('invalid_hash')
    expect(await codeOf(verifyInitData(VECTOR_INIT_DATA + '&auth_date=1', BOT_TOKEN, { now: NOW }))).toBe('malformed_init_data')
    expect(await codeOf(verifyInitData('', BOT_TOKEN, { now: NOW }))).toBe('missing_init_data')
  })

  it('rejects data older than 24h but accepts exactly 24h', async () => {
    expect(await codeOf(verifyInitData(VECTOR_INIT_DATA, BOT_TOKEN, { now: AUTH_DATE + 86_400 + 1 }))).toBe('expired')
    expect(await codeOf(verifyInitData(VECTOR_INIT_DATA, BOT_TOKEN, { now: AUTH_DATE + 86_400 }))).toBe('no-error')
  })

  it('rejects auth_date in the future beyond clock skew', async () => {
    expect(await codeOf(verifyInitData(VECTOR_INIT_DATA, BOT_TOKEN, { now: AUTH_DATE - 3600 }))).toBe('invalid_auth_date')
    expect(await codeOf(verifyInitData(VECTOR_INIT_DATA, BOT_TOKEN, { now: AUTH_DATE - 30 }))).toBe('no-error')
  })

  it('rejects a correctly signed payload with an invalid user', async () => {
    const dcs = 'auth_date=1700000000\nuser={"id":-5}'
    const hash = await computeInitDataHash(dcs, BOT_TOKEN)
    const bad = new URLSearchParams({ auth_date: '1700000000', user: '{"id":-5}', hash }).toString()
    expect(await codeOf(verifyInitData(bad, BOT_TOKEN, { now: NOW }))).toBe('invalid_user')
  })

  it('timingSafeEqual compares content and length', () => {
    const a = new Uint8Array([1, 2, 3])
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false)
    expect(timingSafeEqual(a, new Uint8Array([1, 2]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true)
  })
})

describe('signJwt', () => {
  it('produces a verifiable HS256 token with sub / role / exp', async () => {
    const { token, expiresAt } = await signJwt({ sub: 'user-1', role: 'authenticated', aud: 'authenticated' }, 'secret', 3600, 1_000)
    const [h, p, s] = token.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ sub: 'user-1', role: 'authenticated', iat: 1000, exp: 4600 })
    expect(expiresAt).toBe(4600)
    expect(s).toBe(createHmac('sha256', 'secret').update(`${h}.${p}`).digest('base64url'))
  })
})

// ---------------------------------------------------------------------------
// 2. Price engine
// ---------------------------------------------------------------------------

let seq = 0
const rule = (r: Partial<PriceRule> & Pick<PriceRule, 'type' | 'value'>): PriceRule => ({
  id: `rule-${String(++seq).padStart(3, '0')}`,
  priority: 0,
  is_active: true,
  ...r,
})

describe('calculateCustomerRate', () => {
  const cases: [string, number, PriceRule[], Parameters<typeof calculateCustomerRate>[2], number][] = [
    ['percentage +300% on 0.35', 0.35, [rule({ type: 'percentage', value: 300 })], {}, 1.4],
    ['percentage +200% on 0.1 (no 0.30000000000000004)', 0.1, [rule({ type: 'percentage', value: 200 })], {}, 0.3],
    ['fixed +$0.50 on 0.8', 0.8, [rule({ type: 'fixed', value: 0.5 })], {}, 1.3],
    ['percentage +33.33% on 1.2345 rounds UP to 4dp', 1.2345, [rule({ type: 'percentage', value: 33.33 })], {}, 1.646],
    ['no rules -> provider rate + default margin', 2, [], {}, 2.02],
    ['zero provider rate -> margin only', 0, [rule({ type: 'percentage', value: 300 })], {}, 0.02],
    ['markup below margin is lifted to the floor', 1, [rule({ type: 'percentage', value: 0 })], {}, 1.02],
  ]
  it.each(cases.map((c) => [`${c[0]} => ${c[4]}`, ...c.slice(1)] as typeof c))('%s', (_name, providerRate, rules, ctx, expected) => {
    expect(calculateCustomerRate(providerRate, rules, ctx)).toBe(expected)
  })

  it('honours a custom minimum margin', () => {
    expect(calculateCustomerRate(1, [rule({ type: 'percentage', value: 10 })], {}, { minMargin: 0.5 })).toBe(1.5)
  })

  it('prefers service > category > platform > global, regardless of priority', () => {
    const global = rule({ type: 'percentage', value: 100, priority: 99 })
    const platform = rule({ type: 'percentage', value: 200, platform: 'telegram', priority: 50 })
    const category = rule({ type: 'percentage', value: 300, category_id: 'cat-1', priority: 10 })
    const service = rule({ type: 'fixed', value: 0.5, service_id: 'svc-1', priority: 0 })
    const rules = [global, platform, category, service]
    const ctx = { serviceId: 'svc-1', categoryId: 'cat-1', platform: 'telegram' }

    expect(calculateCustomerRate(1, rules, ctx)).toBe(1.5) // service: 1 + 0.50
    expect(calculateCustomerRate(1, rules, { ...ctx, serviceId: 'other' })).toBe(4) // category +300%
    expect(calculateCustomerRate(1, rules, { platform: 'telegram' })).toBe(3) // platform +200%
    expect(calculateCustomerRate(1, rules, { platform: 'tiktok' })).toBe(2) // global +100%
  })

  it('breaks ties within a scope by priority, then id', () => {
    const low = rule({ id: 'a', type: 'percentage', value: 100, priority: 1 })
    const high = rule({ id: 'b', type: 'percentage', value: 400, priority: 5 })
    expect(selectPriceRule(1, [low, high])?.id).toBe('b')
    const twin = rule({ id: '0', type: 'percentage', value: 50, priority: 5 })
    expect(selectPriceRule(1, [high, twin])?.id).toBe('0')
  })

  it('ignores inactive rules', () => {
    const off = rule({ type: 'percentage', value: 900, is_active: false })
    const on = rule({ type: 'percentage', value: 100 })
    expect(calculateCustomerRate(1, [off, on])).toBe(2)
  })

  it('applies tier rules only inside [min_rate, max_rate] and falls through otherwise', () => {
    const cheap = rule({ type: 'tier', value: 400, min_rate: 0, max_rate: 1 })
    const mid = rule({ type: 'tier', value: 150, min_rate: 1.0001, max_rate: 5 })
    expect(calculateCustomerRate(0.5, [cheap, mid])).toBe(2.5)
    expect(calculateCustomerRate(2, [cheap, mid])).toBe(5)

    const fallback = rule({ type: 'percentage', value: 100 })
    expect(calculateCustomerRate(9, [cheap, mid, fallback])).toBe(18) // above all tiers
  })

  it('supports open-ended tiers (max_rate = null)', () => {
    const bulk = rule({ type: 'tier', value: 50, min_rate: 10, max_rate: null })
    expect(calculateCustomerRate(20, [bulk])).toBe(30)
  })

  it('rejects invalid input', () => {
    expect(() => calculateCustomerRate(-1, [])).toThrow(RangeError)
    expect(() => calculateCustomerRate(Number.NaN, [])).toThrow(RangeError)
    expect(() => calculateCustomerRate(1, [], {}, { minMargin: -1 })).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// 3. SMM v2 adapter
// ---------------------------------------------------------------------------

interface Captured { url: string; body: URLSearchParams }
function fakeFetch(respond: (call: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url, body: new URLSearchParams(init.body as URLSearchParams) }
    calls.push(call)
    expect(init.method).toBe('POST')
    return respond(call)
  }) as unknown as typeof fetch
  return { impl, calls }
}
const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const adapterWith = (impl: typeof fetch, extra: Partial<ConstructorParameters<typeof SMMv2Adapter>[0]> = {}) =>
  new SMMv2Adapter({ id: 'p1', name: 'Panel', apiUrl: 'https://panel.test/api/v2', apiKey: 'SECRET-KEY', fetchImpl: impl, ...extra })

async function errorOf(p: Promise<unknown>): Promise<SMMProviderError> {
  try {
    await p
  } catch (e) {
    if (e instanceof SMMProviderError) return e
    throw e
  }
  throw new Error('expected SMMProviderError')
}

describe('SMMv2Adapter response mapping', () => {
  it('maps balance and sends key + action as a form body', async () => {
    const f = fakeFetch(() => jsonRes({ balance: '100.84292', currency: 'USD' }))
    await expect(adapterWith(f.impl).getBalance()).resolves.toEqual({ balance: 100.84292, currency: 'USD' })
    expect(f.calls[0].url).toBe('https://panel.test/api/v2')
    expect(f.calls[0].body.get('key')).toBe('SECRET-KEY')
    expect(f.calls[0].body.get('action')).toBe('balance')
  })

  it('maps services (string numbers, boolean flags)', async () => {
    const f = fakeFetch(() =>
      jsonRes([{ service: '1', name: 'Followers', type: 'Default', category: 'First Category', rate: '0.90', min: '50', max: '10000', refill: true, cancel: false }]),
    )
    await expect(adapterWith(f.impl).getServices()).resolves.toEqual([
      { externalServiceId: '1', name: 'Followers', type: 'Default', categoryRaw: 'First Category', ratePer1000: 0.9, minQuantity: 50, maxQuantity: 10000, refillSupported: true, cancelSupported: false },
    ])
  })

  it('creates an order with extra params and returns the order id as string', async () => {
    const f = fakeFetch(() => jsonRes({ order: 23501 }))
    const res = await adapterWith(f.impl, { capabilities: { supportsDripFeed: true } }).createOrder({ serviceId: '7', link: 'https://t.me/x', quantity: 1000, extra: { runs: 3 } })
    expect(res).toEqual({ orderId: '23501' })
    const b = f.calls[0].body
    expect([b.get('action'), b.get('service'), b.get('link'), b.get('quantity'), b.get('runs')]).toEqual(['add', '7', 'https://t.me/x', '1000', '3'])
  })

  it('refuses drip-feed parameters for a provider that does not support them, without sending anything', async () => {
    const f = fakeFetch(() => jsonRes({ order: 1 }))
    await expect(adapterWith(f.impl).createOrder({ serviceId: '7', link: 'https://t.me/x', quantity: 1000, extra: { runs: 3, interval: 10 } })).rejects.toMatchObject({ name: 'NotSupportedError', capability: 'dripFeed' })
    expect(f.calls).toHaveLength(0)
  })

  it('maps order status and normalises the status string', async () => {
    const f = fakeFetch(() => jsonRes({ charge: '0.27819', start_count: '3572', status: 'Partial', remains: '157', currency: 'USD' }))
    await expect(adapterWith(f.impl).getOrderStatus('42')).resolves.toEqual({
      orderId: '42', rawStatus: 'Partial', status: 'partial', charge: 0.27819, currency: 'USD', startCount: 3572, remains: 157,
    })
    expect(f.calls[0].body.get('order')).toBe('42')
    expect(mapProviderStatus('In progress')).toBe('in_progress')
    expect(mapProviderStatus('Pending')).toBe('submitted')
    expect(mapProviderStatus('Canceled')).toBe('canceled')
    expect(() => mapProviderStatus('weird')).toThrow(SMMProviderError)
  })
})

describe('SMMv2Adapter error handling', () => {
  it.each([
    ['Not enough funds on balance', 'insufficient_provider_balance'],
    ['Incorrect API key', 'invalid_api_key'],
    ['Incorrect service ID', 'invalid_service'],
    ['Incorrect link', 'invalid_link'],
    ['Quantity less than minimal', 'invalid_quantity'],
    ['Incorrect order ID', 'order_not_found'],
    ['Something odd', 'unknown'],
  ])('normalises API error "%s" -> %s', async (message, code) => {
    const f = fakeFetch(() => jsonRes({ error: message }))
    const err = await errorOf(adapterWith(f.impl).createOrder({ serviceId: '1', link: 'l', quantity: 1 }))
    expect(err).toMatchObject({ kind: 'api', code, retryable: false, ambiguous: false })
  })

  it('never leaks the API key from an echoed error message', async () => {
    const f = fakeFetch(() => jsonRes({ error: 'Bad key SECRET-KEY given' }))
    const err = await errorOf(adapterWith(f.impl).getBalance())
    expect(err.message).not.toContain('SECRET-KEY')
  })

  it('times out and marks a state-changing call as ambiguous', async () => {
    const aborting = ((_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })) as unknown as typeof fetch
    const a = adapterWith(aborting, { timeoutMs: 20 })
    expect(await errorOf(a.getBalance())).toMatchObject({ kind: 'timeout', retryable: true, ambiguous: false })
    expect(await errorOf(a.createOrder({ serviceId: '1', link: 'l', quantity: 1 }))).toMatchObject({ kind: 'timeout', retryable: false, ambiguous: true })
  })

  it('classifies network failures', async () => {
    const failing = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const a = adapterWith(failing)
    expect(await errorOf(a.getServices())).toMatchObject({ kind: 'network', retryable: true })
    expect(await errorOf(a.createOrder({ serviceId: '1', link: 'l', quantity: 1 }))).toMatchObject({ kind: 'network', ambiguous: true })
  })

  it('classifies HTTP errors and invalid bodies', async () => {
    expect(await errorOf(adapterWith(fakeFetch(() => new Response('Bad gateway', { status: 502 })).impl).getBalance())).toMatchObject({ kind: 'http', retryable: true, httpStatus: 502 })
    expect(await errorOf(adapterWith(fakeFetch(() => new Response('', { status: 429 })).impl).getBalance())).toMatchObject({ kind: 'http', code: 'rate_limited', retryable: true })
    expect(await errorOf(adapterWith(fakeFetch(() => new Response('<html>', { status: 200 })).impl).getBalance())).toMatchObject({ kind: 'invalid_response' })
    expect(await errorOf(adapterWith(fakeFetch(() => jsonRes({ balance: 'abc' })).impl).getBalance())).toMatchObject({ kind: 'invalid_response' })
    expect(await errorOf(adapterWith(fakeFetch(() => jsonRes({ nope: 1 })).impl).createOrder({ serviceId: '1', link: 'l', quantity: 1 }))).toMatchObject({ kind: 'invalid_response', ambiguous: true })
  })
})

describe('SMMv2Adapter mock mode', () => {
  const boom = (async () => { throw new Error('mock mode must not hit the network') }) as unknown as typeof fetch

  it('is enabled when no API key is configured', async () => {
    const a = new SMMv2Adapter({ id: 'm', name: 'Mock', apiUrl: 'https://x', fetchImpl: boom })
    expect(a.isMock).toBe(true)
    expect((await a.getServices()).length).toBeGreaterThan(0)
    expect((await a.getBalance()).currency).toBe('USD')
  })

  it('is enabled by MOCK_MODE=true even with a key, and not otherwise', () => {
    const cfg = { id: 'm', name: 'Mock', apiUrl: 'https://x', apiKey: 'k', fetchImpl: boom }
    expect(createSMMv2Adapter(cfg, { MOCK_MODE: 'true' }).isMock).toBe(true)
    expect(createSMMv2Adapter(cfg, { MOCK_MODE: 'false' }).isMock).toBe(false)
    expect(createSMMv2Adapter(cfg, {}).isMock).toBe(false)
  })

  it('simulates an order lifecycle', async () => {
    let t = 0
    const a = new SMMv2Adapter({ id: 'm', name: 'Mock', apiUrl: 'https://x', now: () => t })
    const { orderId } = await a.createOrder({ serviceId: '1001', link: 'l', quantity: 100 })
    expect((await a.getOrderStatus(orderId)).status).toBe('submitted')
    t = 6_000
    expect((await a.getOrderStatus(orderId)).status).toBe('in_progress')
    t = 20_000
    expect((await a.getOrderStatus(orderId)).status).toBe('completed')
    expect(await errorOf(a.getOrderStatus('nope'))).toMatchObject({ code: 'order_not_found' })
  })
})
