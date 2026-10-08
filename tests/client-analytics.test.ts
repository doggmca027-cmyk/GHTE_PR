import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEDUPE_MS, FLUSH_INTERVAL_MS, MAX_BATCH, MAX_QUEUE, createTracker } from '../src/lib/analytics-client'
import type { CleanEvent } from '../supabase/functions/_shared/analytics'

const UUID = '3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12'
const UUID2 = '9a1d7c20-3b8e-4f55-8a42-6c0e1b9d7f33'

describe('client tracker', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setup = (send?: (events: CleanEvent[], o: { keepalive: boolean }) => Promise<unknown>) => {
    const sent: Array<{ events: CleanEvent[]; keepalive: boolean }> = []
    const sender = vi.fn(send ?? (async (events, o) => { sent.push({ events, keepalive: o.keepalive }) }))
    // "idle" = right away in tests; the real default is requestIdleCallback
    const t = createTracker({ send: sender, whenIdle: (fn) => fn(), now: () => Date.now() })
    t.setEnabled(true)
    return { t, sender, sent }
  }
  const tick = async (ms = FLUSH_INTERVAL_MS) => { await vi.advanceTimersByTimeAsync(ms) }

  it('track() only queues: nothing is sent until the batch window ends, then ONE request carries them all', async () => {
    const { t, sender, sent } = setup()
    t.track('catalog_view', { platform: 'telegram' })
    t.track('service_view', { service_id: UUID })
    t.track('checkout_started', { service_id: UUID, quantity: 500, has_promo: false })
    expect(sender).not.toHaveBeenCalled()
    expect(t.pending).toBe(3)
    await tick(FLUSH_INTERVAL_MS - 1)
    expect(sender).not.toHaveBeenCalled()
    await tick(1)
    expect(sender).toHaveBeenCalledTimes(1)
    expect(sent[0].events.map((e) => e.name)).toEqual(['catalog_view', 'service_view', 'checkout_started'])
    expect(sent[0].keepalive).toBe(false)
    expect(t.pending).toBe(0)
  })

  it('track() is synchronous and does not wait for anything (it returns undefined at once, even with a hanging sender)', async () => {
    const { t } = setup(() => new Promise(() => {}))
    const started = performance.now()
    for (let i = 0; i < 1000; i++) t.track('orders_view')
    expect(performance.now() - started).toBeLessThan(200)
    expect(t.track('wallet_view')).toBeUndefined()
  })

  it('only one request is ever in flight; events that arrive meanwhile go in the next batch', async () => {
    let release: () => void = () => {}
    const { t, sender } = setup(() => new Promise<void>((resolve) => { release = resolve }))
    t.track('catalog_view', { platform: 'telegram' })
    await tick()
    expect(sender).toHaveBeenCalledTimes(1)
    t.track('wallet_view')
    await tick(FLUSH_INTERVAL_MS * 3)
    expect(sender).toHaveBeenCalledTimes(1) // the first is still in flight
    release()
    await tick(FLUSH_INTERVAL_MS)
    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender.mock.calls[1][0].map((e) => e.name)).toEqual(['wallet_view'])
  })

  it('a batch is at most MAX_BATCH events; the rest follow', async () => {
    const { t, sender } = setup()
    for (let i = 0; i < MAX_BATCH + 5; i++) t.track('service_view', { service_id: `${i.toString(16).padStart(8, '0')}-5d4a-4b7e-9c11-2a6d8e0f4b12` })
    await tick(FLUSH_INTERVAL_MS * 3)
    expect(sender.mock.calls.map((c) => c[0].length)).toEqual([MAX_BATCH, 5])
  })

  it('the queue is capped: a long offline stretch keeps the newest events and never grows without bound', () => {
    const { t } = setup()
    for (let i = 0; i < MAX_QUEUE + 30; i++) t.track('service_view', { service_id: `${i.toString(16).padStart(8, '0')}-5d4a-4b7e-9c11-2a6d8e0f4b12` })
    expect(t.pending).toBe(MAX_QUEUE)
  })

  it('the same event repeated inside the dedupe window (re-render, double tap) is reported once; later it counts again', async () => {
    const { t, sender } = setup()
    t.track('orders_view'); t.track('orders_view'); t.track('orders_view')
    await vi.advanceTimersByTimeAsync(DEDUPE_MS + 1)
    t.track('orders_view')
    t.track('wallet_view')
    await tick(FLUSH_INTERVAL_MS)
    expect(sender.mock.calls.flatMap((c) => c[0].map((e) => e.name))).toEqual(['orders_view', 'orders_view', 'wallet_view'])
    // different properties are different events
    const b = setup()
    b.t.track('service_view', { service_id: UUID }); b.t.track('service_view', { service_id: UUID2 })
    expect(b.t.pending).toBe(2)
  })

  it('privacy: only allow-listed events with well-shaped properties are ever queued or sent', async () => {
    const { t, sent } = setup()
    t.track('checkout_started', { service_id: UUID, quantity: 100, link: 'https://t.me/private_channel', username: '@me', promo_code: 'SUMMER10', ip: '203.0.113.9' })
    t.track('catalog_view', { platform: 'https://evil.example/x' })
    t.track('order_placed', { order_id: UUID })           // money events are the server's
    t.track('user_registered')
    t.track('made_up_event', { a: 1 })
    t.track('', {})
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].events).toEqual([
      { name: 'checkout_started', properties: { service_id: UUID, quantity: 100 } },
      { name: 'catalog_view', properties: {} },
    ])
    const wire = JSON.stringify(sent)
    for (const leak of ['t.me', 'private_channel', '@me', 'SUMMER10', '203.0.113', 'evil.example', 'order_placed', 'user_registered']) expect(wire).not.toContain(leak)
  })

  it('failures are swallowed: a rejecting or throwing sender drops the batch without an error, and the tracker keeps working', async () => {
    let mode: 'reject' | 'throw' | 'ok' = 'reject'
    const { t, sender } = setup(async () => {
      if (mode === 'reject') throw new Error('network down')
      if (mode === 'throw') throw new TypeError('boom')
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    t.track('wallet_view')
    await tick()
    mode = 'throw'
    t.track('orders_view')
    await tick()
    mode = 'ok'
    t.track('settings_view')
    await tick()
    process.off('unhandledRejection', unhandled)
    expect(sender).toHaveBeenCalledTimes(3)
    expect(t.pending).toBe(0)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('nothing is sent before sign-in or in dev mock mode (disabled), and disabling forgets what was queued', async () => {
    const sender = vi.fn(async () => {})
    const t = createTracker({ send: sender, whenIdle: (fn) => fn() })
    t.track('wallet_view')
    await tick(FLUSH_INTERVAL_MS * 2)
    expect(sender).not.toHaveBeenCalled()
    t.setEnabled(true)
    await tick()
    expect(sender).toHaveBeenCalledTimes(1) // what was recorded before sign-in is reported once it is on
    t.track('orders_view')
    t.setEnabled(false) // sign-out
    await tick(FLUSH_INTERVAL_MS * 2)
    expect(sender).toHaveBeenCalledTimes(1)
    expect(t.pending).toBe(0)
  })

  it('flushNow() (the app goes to the background) sends immediately with keepalive, and cancels the pending timer', async () => {
    const { t, sender, sent } = setup()
    t.track('orders_view')
    t.flushNow()
    expect(sender).toHaveBeenCalledTimes(1)
    expect(sent[0].keepalive).toBe(true)
    await tick(FLUSH_INTERVAL_MS * 2)
    expect(sender).toHaveBeenCalledTimes(1)
    t.flushNow() // nothing queued: nothing sent
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('uses an idle moment to send, not the moment the timer fires', async () => {
    const idleJobs: Array<() => void> = []
    const sender = vi.fn(async () => {})
    const t = createTracker({ send: sender, whenIdle: (fn) => idleJobs.push(fn) })
    t.setEnabled(true)
    t.track('orders_view')
    await tick()
    expect(sender).not.toHaveBeenCalled()
    idleJobs.forEach((j) => j())
    expect(sender).toHaveBeenCalledTimes(1)
  })
})

describe('the app wiring', () => {
  const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

  it('the wire format is exactly what track-event reads, with the user JWT, and never an address', () => {
    const code = src('src/lib/analytics-client.ts')
    expect(code).toContain('/functions/v1/track-event')
    expect(code).toContain('Authorization: `Bearer ${token}`')
    expect(code).toContain('keepalive')
    expect(code).not.toMatch(/ipify|x-forwarded|navigator\.userAgent|geolocation/i)
  })

  it('every event the screens send is one the server accepts (no drift between the app and the allow-list)', async () => {
    const { CLIENT_EVENTS } = await import('../supabase/functions/_shared/analytics')
    const sent = new Set<string>()
    for (const file of ['src/App.tsx', 'src/components/services/ServicesScreen.tsx', 'src/components/services/OrderModal.tsx', 'src/components/wallet/DepositModal.tsx']) {
      for (const m of src(file).matchAll(/track\('([a-z_]+)'/g)) sent.add(m[1])
    }
    expect([...sent].sort()).toEqual(['app_opened', 'catalog_view', 'checkout_started', 'deposit_started', 'orders_view', 'promo_entered', 'service_view', 'settings_view', 'wallet_view'])
    for (const name of sent) expect(Object.keys(CLIENT_EVENTS)).toContain(name)
  })

  it('the funnel steps the BI query counts are all sent: catalog_view and checkout_started by the app, order_placed by the database', () => {
    expect(src('src/components/services/ServicesScreen.tsx')).toContain("track('catalog_view'")
    expect(src('src/components/services/OrderModal.tsx')).toContain("track('checkout_started'")
    expect(src('supabase/migrations/20261108000000_analytics.sql')).toContain("'order_placed'")
  })

  it('no code, link or promo text is passed to track() by any screen', () => {
    const modal = src('src/components/services/OrderModal.tsx')
    const calls = [...modal.matchAll(/track\([^)]*\)/g)].map((m) => m[0]).join('\n')
    expect(calls).not.toMatch(/\blink\b|url\.value|(?<![A-Za-z_])promo(?![A-Za-z_])|targetUrl/)
  })
})

describe('the app tracker over HTTP: fire-and-forget, whatever the network does', () => {
  const fetchMock = vi.fn()
  const session = (isMock = false) => ({ token: 'jwt-token', expiresAt: 0, isMock, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: false } })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const load = () => import('../src/lib/analytics-client')
  const flush = async () => { await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS + 50) }

  it('posts the batch to track-event with the user JWT, and nothing but allow-listed fields', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const { bindAnalytics, track } = await load()
    bindAnalytics(session())
    track('checkout_started', { service_id: UUID, quantity: 100, has_promo: false, link: 'https://t.me/private' })
    track('catalog_view', { platform: 'telegram' })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/track-event')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
    expect(JSON.parse(init.body)).toEqual({ events: [
      { name: 'checkout_started', properties: { service_id: UUID, quantity: 100, has_promo: false } },
      { name: 'catalog_view', properties: { platform: 'telegram' } },
    ] })
    expect(init.body).not.toContain('private')
  })

  it.each([
    ['a 500', () => fetchMock.mockResolvedValue(new Response('{"error":"server_error"}', { status: 500 }))],
    ['a 429', () => fetchMock.mockResolvedValue(new Response('{"error":"rate_limited"}', { status: 429 }))],
    ['a 401', () => fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))],
    ['a 400', () => fetchMock.mockResolvedValue(new Response('not json', { status: 400 }))],
    ['a network failure', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
    ['a timeout', () => fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))],
    ['an abort', () => fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))],
    ['a fetch that throws synchronously', () => fetchMock.mockImplementation(() => { throw new Error('no fetch') })],
  ])('%s is swallowed: no exception, no unhandled rejection, and the next batch still goes out', async (_name, arrange) => {
    arrange()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const { bindAnalytics, track } = await load()
    bindAnalytics(session())
    expect(() => track('orders_view')).not.toThrow()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    track('wallet_view')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('a hanging request is given a timeout signal and does not stop the interface from tracking', async () => {
    // the real signal is AbortSignal.timeout(8 s); fake timers cannot drive that native timer, so the stub gives up at 8 s itself
    fetchMock.mockImplementation(() => new Promise((_res, rej) => setTimeout(() => rej(new DOMException('timed out', 'TimeoutError')), 8_000)))
    const { bindAnalytics, track } = await load()
    bindAnalytics(session())
    track('orders_view')
    await flush()
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(() => { for (let i = 0; i < 100; i++) track('wallet_view') }).not.toThrow()
    await vi.advanceTimersByTimeAsync(9_000) // the 8 s timeout fires: the request is abandoned
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    track('settings_view')
    await flush()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('sends nothing in the dev mock mode, before sign-in, or after sign-out', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { bindAnalytics, track } = await load()
    track('orders_view') // not signed in
    bindAnalytics(session(true)) // mock user
    track('wallet_view')
    await flush()
    bindAnalytics(session())
    bindAnalytics(null) // signed out
    track('settings_view')
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checkout_started carries exactly service_id, quantity and has_promo (the server whitelist), nothing about the customer', async () => {
    const { cleanEvent } = await import('../supabase/functions/_shared/analytics')
    const opened = cleanEvent({ name: 'checkout_started', properties: { service_id: UUID, quantity: 100, has_promo: false, category_id: UUID2, category: 'Telegram Views', link: 'https://t.me/x', user_id: UUID } })
    expect(opened).toEqual({ name: 'checkout_started', properties: { service_id: UUID, quantity: 100, has_promo: false } })
  })
})
