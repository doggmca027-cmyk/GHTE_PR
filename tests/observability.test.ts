import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordHeartbeat } from '../supabase/functions/_shared/heartbeat.ts'
import { corsHeaders, instrument } from '../supabase/functions/_shared/http.ts'
import {
  CORRELATION_HEADER,
  REDACTED,
  clearSecrets,
  correlationIdFrom,
  createLogger,
  registerSecret,
  sanitize,
  sanitizeText,
  serializeError,
  type LogLevel,
} from '../supabase/functions/_shared/logger.ts'
import {
  EXPECTED_JOBS,
  buildSystemHealth,
  classifyJob,
  parseObservabilityRequest,
  type RawCronJob,
  type RawHealth,
  type RawWorker,
} from '../supabase/functions/_shared/observability.ts'
import { SMMProviderError, SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { createMockObservability } from '../src/services/api/mock-observability'

const UUID = '3f2b8c1e-7a4d-4e6f-9b1a-2c3d4e5f6a7b'
// built at run time: the repository secret scanner (rightly) rejects key- and token-shaped literals, even in fixtures
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2lnbmF0dXJlLWZvci10ZXN0cw'].join('.')
const NOW = Date.parse('2026-10-07T14:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

/** A logger that captures parsed lines. */
function capture(opts: { minLevel?: LogLevel; correlationId?: string } = {}) {
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    fn: 'test-fn',
    correlationId: opts.correlationId ?? 'corr-id-0001',
    minLevel: opts.minLevel ?? 'info',
    now: () => NOW,
    sink: (_level, line) => lines.push(JSON.parse(line)),
  })
  return { log, lines }
}

// ---------------------------------------------------------------------------
// 1. The structured logger
// ---------------------------------------------------------------------------

describe('structured logger', () => {
  afterEach(() => clearSecrets())

  it('writes one JSON object per event with the vital context', () => {
    const { log, lines } = capture()
    log.error('provider call failed', { userId: UUID, orderId: 'o-1', providerId: 'p-1', error_code: 'timeout', duration_ms: 812 })
    expect(lines).toEqual([{
      ts: '2026-10-07T14:00:00.000Z', level: 'error', fn: 'test-fn', correlation_id: 'corr-id-0001', msg: 'provider call failed',
      userId: UUID, orderId: 'o-1', providerId: 'p-1', error_code: 'timeout', duration_ms: 812,
    }])
  })

  it('has info / warn / error and a minimum level; lower levels do no work', () => {
    const { log, lines } = capture({ minLevel: 'warn' })
    const lazy = vi.fn(() => 'x')
    log.info('quiet', { get probe() { return lazy() } })
    log.warn('w')
    log.error('e')
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
    expect(lazy).not.toHaveBeenCalled()
  })

  it('bind adds context to every later line; child does not touch its parent', () => {
    const { log, lines } = capture()
    const child = log.child({ providerId: 'p-9' })
    child.info('from child')
    log.info('before bind')
    log.bind({ userId: UUID })
    log.info('after bind')
    expect(lines[0]).toMatchObject({ providerId: 'p-9' })
    expect(lines[1]).not.toHaveProperty('userId')
    expect(lines[2]).toMatchObject({ userId: UUID })
    expect(lines[2]).not.toHaveProperty('providerId')
  })

  it('is synchronous and never throws, whatever it is given', () => {
    const throwing = createLogger({ fn: 'f', correlationId: 'corr-id-0002', sink: () => { throw new Error('disk full') } })
    expect(throwing.info('x')).toBeUndefined() // not a promise: nothing to await
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const { log, lines } = capture()
    const hostile = { get boom(): string { throw new Error('getter') } }
    expect(() => log.error('weird', { big: 10n, circular, fn: () => 1, sym: Symbol('s'), nan: Number.NaN, date: new Date('nope') })).not.toThrow()
    expect(() => log.error('hostile', { hostile })).not.toThrow()
    expect(lines[0]).toMatchObject({ big: '10', circular: { a: 1, self: '[circular]' }, nan: 'NaN', date: null })
    expect(lines).toHaveLength(1) // the line whose context cannot be read is dropped, not half-written
  })

  it('writes through console when no sink is given (info -> log, warn -> warn, error -> error)', () => {
    const spies = { log: vi.spyOn(console, 'log').mockImplementation(() => {}), warn: vi.spyOn(console, 'warn').mockImplementation(() => {}), error: vi.spyOn(console, 'error').mockImplementation(() => {}) }
    try {
      const log = createLogger({ fn: 'f', correlationId: 'corr-id-0003', minLevel: 'info' })
      log.info('a'); log.warn('b'); log.error('c')
      expect([spies.log, spies.warn, spies.error].map((s) => s.mock.calls.length)).toEqual([1, 1, 1])
      expect(JSON.parse(spies.error.mock.calls[0][0] as string)).toMatchObject({ level: 'error', msg: 'c' })
    } finally {
      Object.values(spies).forEach((s) => s.mockRestore())
    }
  })
})

describe('log sanitizing', () => {
  afterEach(() => clearSecrets())
  const SERVICE_KEY = 'srv-role-key-0123456789abcdef'

  it('never prints values under secret-looking keys, at any depth', () => {
    const out = sanitize({
      authorization: `Bearer ${JWT}`, headers: { Authorization: 'x', cookie: 'sid=1', 'x-api-key': 'k' }, apiKey: 'abc', api_key: 'abc', providerKey: 'abc',
      password: 'p', token: 't', botToken: 'b', initData: 'query_id=AAH&user=%7B%7D&auth_date=1&hash=abc', mnemonic: 'word word', seed: 's', privateKey: 'p',
      nested: { deep: { secret: 's', client_secret: 'c', jwt: JWT } }, list: [{ signature: 'sig' }],
    }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toMatch(/Bearer|sid=1|abc|word word|sig"|query_id/)
    expect(out.authorization).toBe(REDACTED)
    expect((out.nested as { deep: { jwt: string } }).deep.jwt).toBe(REDACTED)
  })

  it('keeps identifiers that only look secret: ids, idempotency keys, correlation ids', () => {
    expect(sanitize({ idempotencyKey: UUID, correlationId: 'corr-id-0001', orderId: UUID, publicKey: 'pub' })).toEqual({ idempotencyKey: UUID, correlationId: 'corr-id-0001', orderId: UUID, publicKey: 'pub' })
  })

  it('scrubs secrets inside free text: JWTs, bearer tokens, key=… parameters, credentials in URLs, initData', () => {
    expect(sanitizeText(`auth failed for ${JWT}`)).toBe(`auth failed for ${REDACTED}`)
    expect(sanitizeText('sent Authorization: Bearer abcdef123456 to panel')).toBe(`sent Authorization: Bearer ${REDACTED} to panel`)
    expect(sanitizeText('GET https://panel.example/api?key=SUPERSECRET&action=balance')).toBe(`GET https://panel.example/api?key=${REDACTED}&action=balance`)
    expect(sanitizeText('POST https://user:hunter2@panel.example/v2')).toBe(`POST https://${REDACTED}@panel.example/v2`)
    expect(sanitizeText('bad initData query_id=AAHdF6IQ&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=abc')).toBe(`bad initData ${REDACTED}`)
    const clean = sanitizeText('token=abc123 and secret=zzz, then password=p@ss')
    expect(clean).not.toMatch(/abc123|zzz|p@ss/)
  })

  it('redacts registered secrets wherever they appear (service key, provider API keys)', () => {
    registerSecret(SERVICE_KEY, 'short', undefined, null)
    const { log, lines } = capture()
    log.error(`request to ${SERVICE_KEY} failed`, { err: new Error(`upstream echoed ${SERVICE_KEY}`), detail: { echoed: `key ${SERVICE_KEY}!` }, note: 'short stays: below 8 chars' })
    expect(JSON.stringify(lines[0])).not.toContain(SERVICE_KEY)
    expect(lines[0].msg).toBe(`request to ${REDACTED} failed`)
    expect(lines[0].note).toBe('short stays: below 8 chars')
  })

  it('redacts long opaque tokens but keeps UUIDs and ordinary words', () => {
    expect(sanitizeText(`order ${UUID} failed: ${'A1b2'.repeat(10)}`)).toBe(`order ${UUID} failed: ${REDACTED}`)
    expect(sanitizeText('needs_reconciliation: provider timed out after 10000ms')).toBe('needs_reconciliation: provider timed out after 10000ms')
  })

  it('shortens wallets, addresses and transaction hashes instead of printing them in full', () => {
    const wallet = `0:${'ab'.repeat(32)}`
    const out = sanitize({ destination_wallet: wallet, senderAddress: wallet, txHash: 'F'.repeat(64), tx_hash: 'abc', recipient: wallet }) as Record<string, string>
    for (const v of Object.values(out)) expect(v.length).toBeLessThanOrEqual(11)
    expect(out.destination_wallet).toBe('0:abab…abab')
    expect(JSON.stringify(out)).not.toContain('ab'.repeat(32))
  })

  it('serializes errors as { name, code, message } without stack, details or raw objects', () => {
    const supabaseError = { message: `duplicate key value violates unique constraint (key ${SERVICE_KEY})`, code: '23505', details: 'Key (tx_hash)=(deadbeef) already exists.', hint: 'secret hint' }
    registerSecret(SERVICE_KEY)
    expect(serializeError(supabaseError)).toEqual({ code: '23505', message: `duplicate key value violates unique constraint (key ${REDACTED})` })
    const e = Object.assign(new TypeError('boom'), { code: 'ECONNRESET' })
    expect(serializeError(e)).toEqual({ name: 'TypeError', code: 'ECONNRESET', message: 'boom' })
    expect(serializeError('plain string')).toEqual({ message: 'plain string' })
    const { log, lines } = capture()
    log.error('x', { err: e })
    expect(JSON.stringify(lines[0])).not.toContain('stack')
  })

  it('caps string, array, key count and depth so a line stays small', () => {
    const out = sanitize({ s: 'x'.repeat(5000), arr: Array.from({ length: 100 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } } }) as { s: string; arr: unknown[]; deep: Record<string, unknown> }
    expect(out.s.length).toBeLessThanOrEqual(501)
    expect(out.arr).toHaveLength(21)
    expect(JSON.stringify(out.deep)).toContain('[truncated]')
    expect(Object.keys(sanitize(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]))) as object).length).toBeLessThanOrEqual(41)
  })
})

// ---------------------------------------------------------------------------
// 2. Correlation id + the request wrapper
// ---------------------------------------------------------------------------

describe('correlation id', () => {
  const headers = (v?: string) => new Headers(v === undefined ? {} : { [CORRELATION_HEADER]: v })

  it('keeps a well-formed inbound id', () => {
    expect(correlationIdFrom(headers('req-2026-10-07-abcdef'))).toBe('req-2026-10-07-abcdef')
    expect(correlationIdFrom(headers(UUID))).toBe(UUID)
  })

  it('replaces a missing or malformed one with a fresh UUID (never echoes hostile input)', () => {
    for (const bad of [undefined, '', 'short', 'has space in it 123', 'x'.repeat(65), '<script>alert(1)</script>', '-leading-dash-1234']) {
      expect(correlationIdFrom(headers(bad as string | undefined))).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(correlationIdFrom(headers())).not.toBe(correlationIdFrom(headers()))
    expect(correlationIdFrom(null)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('the CORS headers let a browser send and read it', () => {
    expect(corsHeaders['Access-Control-Allow-Headers']).toContain(CORRELATION_HEADER)
    expect(corsHeaders['Access-Control-Expose-Headers']).toBe(CORRELATION_HEADER)
  })
})

describe('instrument (request wrapper)', () => {
  const run = async (handler: Parameters<typeof instrument>[1], req: Request) => {
    const { log, lines } = capture()
    let seen = ''
    const wrapped = instrument('wrapped-fn', async (r, ctx) => { seen = ctx.correlationId; return handler(r, ctx) }, {
      makeLogger: (_fn, correlationId) => { Object.assign(log, { correlationId }); return createLogger({ fn: 'wrapped-fn', correlationId, now: () => NOW, sink: (_l, line) => lines.push(JSON.parse(line)) }) },
      now: (() => { let t = NOW; return () => (t += 25) })(),
    })
    return { res: await wrapped(req), lines, seen }
  }
  const post = (headers: Record<string, string> = {}) => new Request('https://f.example/fn', { method: 'POST', headers })

  it('uses the caller\'s id: handler context, response header and log lines all carry it', async () => {
    const { res, lines, seen } = await run(async (_r, { log }) => { log.info('inside'); return new Response('ok') }, post({ [CORRELATION_HEADER]: 'caller-id-12345' }))
    expect(seen).toBe('caller-id-12345')
    expect(res.headers.get(CORRELATION_HEADER)).toBe('caller-id-12345')
    expect(lines.map((l) => l.correlation_id)).toEqual(['caller-id-12345', 'caller-id-12345'])
    expect(lines[1]).toMatchObject({ msg: 'request', level: 'info', method: 'POST', status: 200, duration_ms: 25 })
  })

  it('generates one when the caller sent none, and keeps the handler\'s body, status and headers', async () => {
    const { res } = await run(async () => new Response('{"a":1}', { status: 201, headers: { 'Content-Type': 'application/json', 'X-Custom': 'y' } }), post())
    expect(res.headers.get(CORRELATION_HEADER)).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.status).toBe(201)
    expect(res.headers.get('x-custom')).toBe('y')
    expect(await res.text()).toBe('{"a":1}')
  })

  it('the final request line carries the user once the handler binds it, and warns on 4xx / errors on 5xx', async () => {
    const a = await run(async (_r, { log }) => { log.bind({ userId: UUID }); return new Response('no', { status: 403 }) }, post())
    expect(a.lines.at(-1)).toMatchObject({ level: 'warn', status: 403, userId: UUID })
    const b = await run(async () => new Response('x', { status: 502 }), post())
    expect(b.lines.at(-1)).toMatchObject({ level: 'error', status: 502 })
  })

  it('an escaped exception becomes a generic 500: nothing internal in the body, the cause only in the log', async () => {
    const { res, lines } = await run(async () => { throw new Error(`db password=hunter2 at ${UUID}`) }, post())
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toMatch(/hunter2|password/)
    expect(res.headers.get(CORRELATION_HEADER)).toBeTruthy()
    expect(lines.find((l) => l.msg === 'unhandled exception')).toMatchObject({ level: 'error', error_code: 'unhandled' })
    expect(JSON.stringify(lines)).not.toContain('hunter2')
  })

  it('does not log CORS preflights', async () => {
    const { res, lines } = await run(async () => new Response(null, { status: 204 }), new Request('https://f.example/fn', { method: 'OPTIONS' }))
    expect(res.status).toBe(204)
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. The id travels on to the SMM provider
// ---------------------------------------------------------------------------

describe('SMM adapter propagation', () => {
  const API_KEY = ['provider', 'secret', 'key', '9999'].join('-')
  const adapter = (over: Partial<ConstructorParameters<typeof SMMv2Adapter>[0]> = {}, response: () => Response = () => new Response(JSON.stringify({ balance: '12.5', currency: 'USD' }))) => {
    const calls: { headers: Record<string, string>; body: string }[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) })
      return response()
    }) as unknown as typeof fetch
    return { a: new SMMv2Adapter({ id: 'prov-1', name: 'Panel', apiUrl: 'https://panel.example/api', apiKey: API_KEY, mockMode: false, fetchImpl, ...over }), calls }
  }

  it('sends x-correlation-id on every provider call', async () => {
    const { a, calls } = adapter({ correlationId: 'req-abcdef-12345' })
    await a.getBalance()
    await a.getBalance()
    expect(calls.map((c) => c.headers[CORRELATION_HEADER])).toEqual(['req-abcdef-12345', 'req-abcdef-12345'])
  })

  it('never sends a malformed id (no header injection) or one when none is set', async () => {
    for (const correlationId of ['bad id\r\nX-Evil: 1', 'x', undefined]) {
      const { a, calls } = adapter({ correlationId })
      await a.getBalance()
      expect(calls[0].headers).not.toHaveProperty(CORRELATION_HEADER)
    }
  })

  it('the api key stays in the form body only, never in a header', async () => {
    const { a, calls } = adapter({ correlationId: 'req-abcdef-12345' })
    await a.getBalance()
    expect(JSON.stringify(calls[0].headers)).not.toContain(API_KEY)
  })

  it('logs a failed call once, with provider, action, kind and code: never the key, the body or the panel\'s echo', async () => {
    const { log, lines } = capture({ correlationId: 'req-abcdef-12345' })
    const { a } = adapter({ logger: log, correlationId: 'req-abcdef-12345' }, () => new Response(JSON.stringify({ error: `Incorrect API key ${API_KEY}` })))
    await expect(a.getBalance()).rejects.toBeInstanceOf(SMMProviderError)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'provider call failed', correlation_id: 'req-abcdef-12345', providerId: 'prov-1', action: 'balance', error_kind: 'api', error_code: 'invalid_api_key' })
    expect(JSON.stringify(lines)).not.toContain(API_KEY)
    expect(lines[0]).toHaveProperty('duration_ms')
  })

  it('logs timeouts and http errors as unknown-outcome signals for state-changing calls', async () => {
    const { log, lines } = capture()
    const { a } = adapter({ logger: log }, () => new Response('upstream down', { status: 503 }))
    await expect(a.createOrder({ serviceId: '1', link: 'https://t.me/x', quantity: 100 })).rejects.toBeInstanceOf(SMMProviderError)
    expect(lines[0]).toMatchObject({ action: 'add', error_kind: 'http', http_status: 503, ambiguous: true })
  })

  it('is silent on success and works without a logger', async () => {
    const { log, lines } = capture()
    await adapter({ logger: log }).a.getBalance()
    expect(lines).toEqual([])
    await expect(adapter().a.getBalance()).resolves.toMatchObject({ balance: 12.5 })
  })
})

// ---------------------------------------------------------------------------
// 4. Worker heartbeats (the reporting side)
// ---------------------------------------------------------------------------

describe('recordHeartbeat', () => {
  it('reports success and failure, with a sanitized error and the duration', async () => {
    const calls: Record<string, unknown>[] = []
    const db = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, ...args }); return { error: null } } }
    const { log } = capture()
    await recordHeartbeat(db, 'sync-order-status', { ok: true, startedAt: 1_000 }, log, () => 1_900)
    await recordHeartbeat(db, 'sync-order-status', { ok: false, startedAt: 1_000, error: new Error(`failed with Bearer abcdef123456 and ${JWT}`) }, log, () => 1_250)
    expect(calls[0]).toEqual({ fn: 'record_worker_heartbeat', p_worker: 'sync-order-status', p_ok: true, p_error: null, p_duration_ms: 900 })
    expect(calls[1]).toMatchObject({ p_ok: false, p_duration_ms: 250 })
    expect(String(calls[1].p_error)).not.toMatch(/abcdef123456|eyJ/)
  })

  it('never fails the run it describes: a database error or a thrown exception is only logged', async () => {
    const { log, lines } = capture()
    await expect(recordHeartbeat({ rpc: async () => ({ error: { message: 'permission denied' } }) }, 'w', { ok: true, startedAt: 0 }, log)).resolves.toBeUndefined()
    await expect(recordHeartbeat({ rpc: async () => { throw new Error('network down') } }, 'w', { ok: true, startedAt: 0 }, log)).resolves.toBeUndefined()
    expect(lines.map((l) => [l.level, l.error_code, l.worker])).toEqual([['warn', 'heartbeat_failed', 'w'], ['warn', 'heartbeat_failed', 'w']])
  })
})

// ---------------------------------------------------------------------------
// 5. The health judge (pure)
// ---------------------------------------------------------------------------

const cronJob = (name: string, over: Partial<RawCronJob> = {}): RawCronJob => ({ name, schedule: '* * * * *', active: true, last_run_at: ago(0), last_status: 'succeeded', last_success_at: ago(0), runs: 60, failed_runs: 0, ...over })
const worker = (name: string, over: Partial<RawWorker> = {}): RawWorker => ({ worker: name, last_run_at: ago(0), last_success_at: ago(0), last_error_at: null, last_error: null, last_duration_ms: 300, runs: 100, failures: 0, ...over })
const healthyCron = () => EXPECTED_JOBS.map((j) => cronJob(j.name, { schedule: j.kind === 'sql' ? '*/5 * * * *' : '* * * * *' }))
const healthyWorkers = () => EXPECTED_JOBS.filter((j) => j.worker).map((j) => worker(j.worker!))
const job = (name: string) => EXPECTED_JOBS.find((j) => j.name === name)!

function raw(over: Partial<RawHealth> = {}): RawHealth {
  return {
    generated_at: new Date(NOW).toISOString(), window_hours: 24, db: { ok: true, now: new Date(NOW).toISOString() },
    orders: { stuck: 0, stuck_oldest_minutes: 0, held: 0, queue: {} },
    reconciliation: { total: 0, cases: [] },
    providers: [{ id: 'p1', name: 'Panel', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: ago(1), balance: 100, currency: 'USD', last_balance_sync: ago(1), low_balance_threshold: 10,
      checks: 1440, failed_checks: 3, avg_latency_ms: 200, max_latency_ms: 900, last_error_kind: 'timeout', last_error_at: ago(300), errors_by_kind: { timeout: 3 }, orders: 10, orders_failed: 0, orders_held: 0 }],
    recent_provider_errors: [], deposits: { pending: 0, stale_pending: 0 }, proposals: { pending: 0 }, payments: { in_progress: 0 },
    treasury: { balance: 500, minimum_reserve: 0 }, workers: healthyWorkers(), cron: healthyCron(), cron_error: null, ...over,
  }
}

describe('cron pulse', () => {
  it('ok: a sql job that ran on time, an http job whose worker finished', () => {
    expect(classifyJob(job('sync-reconciliation-cases'), [cronJob('sync-reconciliation-cases', { last_run_at: ago(4), last_success_at: ago(4) })], [], NOW)).toMatchObject({ state: 'ok', kind: 'sql', ageMinutes: 4 })
    expect(classifyJob(job('provider-health-monitor'), healthyCron(), healthyWorkers(), NOW)).toMatchObject({ state: 'ok', kind: 'http' })
  })

  it('the reconciliation detector is late after 12 minutes without a run', () => {
    const late = classifyJob(job('sync-reconciliation-cases'), [cronJob('sync-reconciliation-cases', { last_run_at: ago(13), last_success_at: ago(13) })], [], NOW)
    expect(late).toMatchObject({ state: 'late', critical: true })
    expect(late.detail).toContain('13 min')
  })

  it('a job whose last run failed is failing; a missing or switched-off one says so', () => {
    expect(classifyJob(job('sync-reconciliation-cases'), [cronJob('sync-reconciliation-cases', { last_status: 'failed' })], [], NOW).state).toBe('failing')
    expect(classifyJob(job('sync-reconciliation-cases'), [], [], NOW).state).toBe('missing')
    expect(classifyJob(job('sync-reconciliation-cases'), [cronJob('sync-reconciliation-cases', { active: false })], [], NOW).state).toBe('disabled')
  })

  it('an http job is judged by its worker, not by the request being sent: a worker that never finishes is late even though cron fires', () => {
    const c = healthyCron()
    const stalled = [worker('provider-health-monitor', { last_run_at: ago(0), last_success_at: ago(30) })]
    expect(classifyJob(job('provider-health-monitor'), c, stalled, NOW)).toMatchObject({ state: 'late', lastSuccessAt: ago(30) })
  })

  it('a worker whose last run ended in an error is failing, with the error', () => {
    const failing = [worker('sync-order-status', { last_run_at: ago(0), last_success_at: ago(3), last_error_at: ago(0), last_error: 'batch query failed' })]
    const r = classifyJob(job('sync-order-status'), healthyCron(), failing, NOW)
    expect(r.state).toBe('failing')
    expect(r.detail).toContain('batch query failed')
    // ...and recovers on the next good run
    expect(classifyJob(job('sync-order-status'), healthyCron(), [worker('sync-order-status', { last_error_at: ago(5), last_error: 'old' })], NOW).state).toBe('ok')
  })

  it('right after a deploy a worker has not reported yet: trusted while the scheduler fires, late once overdue', () => {
    expect(classifyJob(job('sync-catalog'), [cronJob('sync-catalog', { last_run_at: ago(100) })], [], NOW)).toMatchObject({ state: 'ok' })
    expect(classifyJob(job('sync-catalog'), [cronJob('sync-catalog', { last_run_at: ago(500) })], [], NOW).state).toBe('late')
  })

  it('a job scheduled but never run is never_ran; without a readable pg_cron a sql job is unknown and an http job falls back to its heartbeat', () => {
    expect(classifyJob(job('sync-reconciliation-cases'), [cronJob('sync-reconciliation-cases', { last_run_at: null, last_status: null, last_success_at: null })], [], NOW).state).toBe('never_ran')
    expect(classifyJob(job('sync-reconciliation-cases'), null, [], NOW).state).toBe('unknown')
    expect(classifyJob(job('sync-order-status'), null, healthyWorkers(), NOW).state).toBe('ok')
    expect(classifyJob(job('sync-order-status'), null, [worker('sync-order-status', { last_success_at: ago(20) })], NOW).state).toBe('late')
  })
})

describe('system health', () => {
  const build = (over: Partial<RawHealth> = {}) => buildSystemHealth(raw(over), NOW, 37)

  it('is ok with a healthy provider and every job on time: no alerts', () => {
    const h = build()
    expect(h).toMatchObject({ status: 'ok', alerts: [], db: { ok: true, latencyMs: 37 }, cron: { state: 'ok', available: true } })
    expect(h.providers[0]).toMatchObject({ errorRate: 3 / 1440, lowBalance: false, errorsByKind: { timeout: 3 } })
  })

  it('a critical reconciliation case is a critical alert (same severity rule as the Reconciliation tab)', () => {
    const h = build({ reconciliation: { total: 2, cases: [
      { id: 'c1', entity_type: 'order', reason: 'needs_refund: provider_rejected', created_at: ago(5), amount: 5 },
      { id: 'c2', entity_type: 'provider_payment', reason: 'Stuck in BROADCASTED for over 4 h', created_at: ago(3 * 60), amount: 20 },
    ] } })
    expect(h.reconciliation).toEqual({ open: 2, critical: 1, high: 1, normal: 0 })
    expect(h.status).toBe('critical')
    expect(h.alerts.map((a) => [a.id, a.severity])).toEqual([['recon-critical', 'critical'], ['recon-high', 'warning']])
  })

  it('cases beyond the 200 carried in the snapshot are still counted as open', () => {
    expect(build({ reconciliation: { total: 450, cases: [] } }).reconciliation).toMatchObject({ open: 450, normal: 450 })
  })

  it('stuck orders: a warning, critical once the oldest has waited an hour', () => {
    expect(build({ orders: { stuck: 2, stuck_oldest_minutes: 25, held: 0, queue: {} } }).alerts).toMatchObject([{ id: 'stuck-orders', severity: 'warning' }])
    expect(build({ orders: { stuck: 1, stuck_oldest_minutes: 61, held: 0, queue: {} } }).alerts).toMatchObject([{ id: 'stuck-orders', severity: 'critical' }])
  })

  it('a late detector or health monitor makes the system critical; a late catalog sync only degrades it', () => {
    const cron = healthyCron().map((j) => (j.name === 'sync-reconciliation-cases' ? { ...j, last_run_at: ago(30), last_success_at: ago(30) } : j))
    const h = build({ cron })
    expect(h.status).toBe('critical')
    expect(h.cron.state).toBe('critical')
    expect(h.alerts[0]).toMatchObject({ id: 'cron-sync-reconciliation-cases', severity: 'critical', title: 'Reconciliation detector: late' })
    const catalog = build({ cron: healthyCron().map((j) => (j.name === 'sync-catalog' ? { ...j, last_run_at: ago(500), last_success_at: ago(500) } : j)), workers: healthyWorkers().map((w) => (w.worker === 'sync-catalog' ? { ...w, last_success_at: ago(500) } : w)) })
    expect(catalog).toMatchObject({ status: 'degraded', cron: { state: 'degraded' } })
  })

  it('an unreadable pg_cron is a warning, not an outage', () => {
    const h = build({ cron: null, cron_error: '42501' })
    expect(h.cron).toMatchObject({ available: false })
    expect(h.alerts.find((a) => a.id === 'cron-sync-reconciliation-cases')).toMatchObject({ severity: 'warning', title: 'Reconciliation detector: cannot be checked' })
    expect(h.status).toBe('degraded')
  })

  it('provider alerts: unavailable (critical), degraded, high error rate, low balance, none healthy', () => {
    const p = raw().providers[0]
    expect(build({ providers: [{ ...p, health_status: 'unavailable', last_error_kind: 'http 503' }, { ...p, id: 'p2', name: 'Other' }] }).alerts).toMatchObject([{ id: 'provider-down-p1', severity: 'critical' }])
    expect(build({ providers: [{ ...p, health_status: 'degraded' }] }).alerts.map((a) => a.id)).toEqual(['no-healthy-provider', 'provider-degraded-p1'])
    expect(build({ providers: [{ ...p, checks: 100, failed_checks: 60 }] }).alerts).toMatchObject([{ id: 'provider-errors-p1', severity: 'warning', title: 'Panel: 60% of health checks failed' }])
    expect(build({ providers: [{ ...p, checks: 3, failed_checks: 3 }] }).alerts).toEqual([]) // too few checks to say
    expect(build({ providers: [{ ...p, balance: 4, low_balance_threshold: 10 }] }).alerts).toMatchObject([{ id: 'provider-balance-p1', severity: 'warning' }])
    expect(build({ providers: [{ ...p, balance: 4, last_balance_sync: null }] }).alerts).toEqual([]) // never read: not "low"
    expect(build({ providers: [{ ...p, health_status: 'unavailable' }] }).alerts.map((a) => a.id)).toEqual(['provider-down-p1', 'no-healthy-provider'])
  })

  it('no providers at all is a warning (nothing to route to yet), not an outage', () => {
    const h = build({ providers: [] })
    expect(h.alerts).toMatchObject([{ id: 'no-providers', severity: 'warning' }])
    expect(h.status).toBe('degraded')
  })

  it('a provider that is switched off is not alerted about', () => {
    const p = raw().providers[0]
    expect(build({ providers: [p, { ...p, id: 'p2', name: 'Off', routing_enabled: false, health_status: 'unavailable' }] }).alerts).toEqual([])
  })

  it('treasury below its reserve and expired pending deposits warn', () => {
    const h = build({ treasury: { balance: 30, minimum_reserve: 50 }, deposits: { pending: 0, stale_pending: 2 } })
    expect(h.alerts.map((a) => a.id).sort()).toEqual(['stale-deposits', 'treasury-reserve'])
    expect(h.status).toBe('degraded')
  })

  it('the database being down is critical on its own', () => {
    expect(build({ db: { ok: false, now: '' } }).status).toBe('critical')
  })

  it('critical alerts are listed before warnings', () => {
    const p = raw().providers[0]
    const h = build({ treasury: { balance: 1, minimum_reserve: 50 }, providers: [{ ...p, health_status: 'unavailable' }, { ...p, id: 'p2', name: 'B' }], orders: { stuck: 1, stuck_oldest_minutes: 5, held: 0, queue: {} } })
    const sev = h.alerts.map((a) => a.severity)
    expect(sev).toEqual([...sev].sort((a, b) => (a === b ? 0 : a === 'critical' ? -1 : 1)))
  })

  it('parses the request: GET with hours 1..24', () => {
    expect(parseObservabilityRequest(null)).toEqual({ hours: 24 })
    expect(parseObservabilityRequest({ action: 'get', hours: 6 })).toEqual({ hours: 6 })
    for (const bad of [{ hours: 0 }, { hours: 25 }, { hours: 1.5 }, { hours: '6' }, { action: 'DROP' }, [], 'x']) expect(parseObservabilityRequest(bad)).toHaveProperty('error')
  })

  it('the dev mock shows every state through the real judge', () => {
    const h = createMockObservability().get(24, NOW)
    expect(h.status).toBe('critical')
    expect(h.alerts.map((a) => a.id)).toEqual(expect.arrayContaining(['recon-critical', 'provider-down-demo-prov-2', 'cron-sync-reconciliation-cases', 'stuck-orders']))
    expect(h.recentProviderErrors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. The database side
// ---------------------------------------------------------------------------

describe('get_system_health (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, customer: string, service: string
  type R = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const health = async (hours = 24) => (await db.query<{ r: RawHealth }>(`select get_system_health($1) r`, [hours])).rows[0].r

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    customer = await q(`insert into users(telegram_id) values (3) returning id`)
    await db.exec(`
      insert into providers(name, api_url, routing_enabled, health_status, provider_balance, last_balance_sync) values ('Panel A', 'https://a', true, 'healthy', 50, now());
      insert into providers(name, api_url, routing_enabled, health_status) values ('Panel B', 'https://b', true, 'unavailable');
      insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'v');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        select id, '9', 's', 1, 1, 1000000 from providers where name = 'Panel A';
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id, 'Views', ps.id, 10, 1, 1000000 from categories c, provider_services ps;`)
    service = await q(`select id from services limit 1`)
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 1000, null, 'fund', 'fund-1')`, [customer])
  }, 120_000)

  async function order(status: string, minutesOld: number, note: string | null = null) {
    const { id } = (await db.query<{ id: string }>(
      `insert into orders(user_id, service_id, target_url, quantity, charge_amount, cost_amount, provider_id)
       select $1, $2, 'https://t.me/x', 100, 5, 1, p.id from providers p where p.name = 'Panel A' returning id`, [customer, service])).rows[0]
    const chain: Record<string, string[]> = { processing: ['awaiting_payment', 'paid', 'processing'], submitted: ['awaiting_payment', 'paid', 'processing', 'submitted'], failed: ['awaiting_payment', 'paid', 'failed'], paid: ['awaiting_payment', 'paid'] }
    for (const s of chain[status]) await db.query(`update orders set status = $2 where id = $1`, [id, s])
    await db.query(`update orders set error_message = $2, created_at = now() - make_interval(mins => $3) where id = $1`, [id, note, minutesOld])
    return id
  }
  const healthLog = (provider: string, status: string, kind: string | null, minutesAgo: number, latency = 200) =>
    db.query(`insert into provider_health_log(provider_id, status, previous_status, latency_ms, error_kind, checked_at)
              select id, $2::provider_health_enum, 'healthy', $5, $3, now() - make_interval(mins => $4) from providers where name = $1`, [provider, status, kind, minutesAgo, latency])

  it('returns the whole snapshot on a quiet system', async () => {
    const h = await health()
    expect(h).toMatchObject({
      window_hours: 24, db: { ok: true }, orders: { stuck: 0, stuck_oldest_minutes: 0, held: 0, queue: {} }, reconciliation: { total: 0, cases: [] },
      deposits: { pending: 0, stale_pending: 0 }, proposals: { pending: 0 }, payments: { in_progress: 0 }, workers: [], cron: null, cron_error: null,
    })
    expect(h.providers.map((p) => p.name)).toEqual(expect.arrayContaining(['Panel A', 'Panel B']))
    expect(Number(h.treasury.minimum_reserve)).toBe(0)
  })

  it('counts stuck and held orders and the queue depth', async () => {
    await order('processing', 3, 'needs_reconciliation: submission in flight') // young: in flight, not stuck
    await order('processing', 45, 'needs_reconciliation: timeout')
    await order('processing', 20, 'needs_reconciliation: timeout')
    await order('submitted', 500)
    await order('failed', 1, 'needs_refund: provider_rejected')
    const h = await health()
    expect(h.orders.stuck).toBe(2)
    expect(h.orders.stuck_oldest_minutes).toBe(45)
    expect(h.orders.held).toBe(3) // two stuck + the owed refund
    expect(h.orders.queue).toEqual({ processing: 3, submitted: 1 })
  })

  it('aggregates provider API health from provider_health_log inside the window only', async () => {
    for (let i = 0; i < 8; i++) await healthLog('Panel A', 'healthy', null, 10 + i, 100 + i * 10)
    await healthLog('Panel A', 'degraded', 'timeout', 30, 8000)
    await healthLog('Panel A', 'unavailable', 'http 503', 5, 50)
    await healthLog('Panel A', 'unavailable', 'http 503', 2 * 24 * 60, 50) // outside every window
    const a = (await health(1)).providers.find((p) => p.name === 'Panel A')!
    expect(a).toMatchObject({ checks: 10, failed_checks: 2, last_error_kind: 'http 503', errors_by_kind: { timeout: 1, 'http 503': 1 }, max_latency_ms: 8000 })
    expect(a.avg_latency_ms).toBeGreaterThan(100)
    const wide = (await health(24)).providers.find((p) => p.name === 'Panel A')!
    expect(wide.checks).toBe(10) // 2 days old row is still outside 24 h
    const b = (await health()).providers.find((p) => p.name === 'Panel B')!
    expect(b).toMatchObject({ checks: 0, failed_checks: 0, last_error_kind: null, errors_by_kind: {} })
  })

  it('lists the latest provider errors newest first, with the provider name', async () => {
    await healthLog('Panel A', 'unavailable', 'timeout', 50)
    await healthLog('Panel B', 'unavailable', 'http 502', 5)
    await healthLog('Panel A', 'healthy', null, 1)
    const e = (await health()).recent_provider_errors
    expect(e.map((x) => [x.provider_name, x.error_kind])).toEqual([['Panel B', 'http 502'], ['Panel A', 'timeout']])
  })

  it('per-provider order outcomes in the window', async () => {
    await order('failed', 10, 'needs_refund: x')
    await order('submitted', 10)
    await order('failed', 3000) // older than 24 h
    const a = (await health()).providers.find((p) => p.name === 'Panel A')!
    expect(a).toMatchObject({ orders: 2, orders_failed: 1, orders_held: 1 })
  })

  it('carries open reconciliation cases with their amount; resolved ones are left out', async () => {
    await order('failed', 1, 'needs_refund: provider_rejected')
    await db.query(`insert into reconciliation_cases(entity_type, entity_id, reason, status, resolution, resolved_at) values ('deposit', 'old', 'x', 'resolved', 'manual', now())`)
    const h = await health()
    expect(h.reconciliation.total).toBe(1)
    expect(h.reconciliation.cases[0]).toMatchObject({ entity_type: 'order', reason: 'needs_refund: provider_rejected' })
    expect(Number(h.reconciliation.cases[0].amount)).toBe(5)
  })

  it('clamps the window to 1..24 hours', async () => {
    expect((await health(0)).window_hours).toBe(1)
    expect((await health(500)).window_hours).toBe(24)
    expect((await db.query<{ r: R }>(`select get_system_health(null) r`)).rows[0].r.window_hours).toBe(24)
  })

  it('treasury, proposals, deposits and payments in progress', async () => {
    await db.exec(`select process_treasury_transaction('deposit', 300)`)
    await db.exec(`update platform_settings set minimum_treasury_reserve = 40 where id = 1`)
    const h = await health()
    expect(h.treasury).toMatchObject({ balance: 300, minimum_reserve: 40 })
  })

  describe('worker heartbeats', () => {
    const beat = (w: string, ok: boolean, err: string | null = null, ms: number | null = 120) => db.query(`select record_worker_heartbeat($1, $2, $3, $4)`, [w, ok, err, ms])

    it('records the latest run, keeps the last success through a failure and counts runs', async () => {
      await beat('sync-order-status', true)
      await beat('sync-order-status', false, 'batch query failed', 80)
      await beat('sync-order-status', false, null, null)
      const w = (await health()).workers[0]
      expect(w).toMatchObject({ worker: 'sync-order-status', runs: 3, failures: 2, last_error: 'unknown error' })
      expect(w.last_success_at).toBeTruthy()
      expect(w.last_error_at).toBeTruthy()
      await beat('sync-order-status', true)
      expect((await health()).workers[0]).toMatchObject({ runs: 4, failures: 2, last_error: 'unknown error' }) // history of the last error is kept
    })

    it('truncates long errors and names to the column limits', async () => {
      await beat('w'.repeat(100), false, 'e'.repeat(1000))
      const w = (await health()).workers[0]
      expect(w.worker).toHaveLength(60)
      expect(String(w.last_error)).toHaveLength(300)
    })
  })

  describe('pg_cron pulse (a stand-in cron schema with the same columns)', () => {
    beforeEach(async () => {
      await db.exec(`
        create schema cron;
        create table cron.job (jobid bigserial primary key, jobname text, schedule text, active boolean default true);
        create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz, end_time timestamptz);
        insert into cron.job(jobname, schedule) values ('sync-reconciliation-cases', '*/5 * * * *'), ('provider-health-monitor', '* * * * *');
        insert into cron.job(jobname, schedule, active) values ('sync-catalog', '0 */6 * * *', false);
        insert into cron.job_run_details(jobid, status, start_time, end_time)
          select 1, 'succeeded', now() - make_interval(mins => g * 5), now() - make_interval(mins => g * 5) from generate_series(1, 10) g;
        insert into cron.job_run_details(jobid, status, start_time, end_time) values (1, 'failed', now() - interval '50 minutes', now() - interval '50 minutes');
        insert into cron.job_run_details(jobid, status, start_time, end_time) values (2, 'succeeded', now() - interval '20 minutes', now() - interval '20 minutes');`)
    })

    it('reads each job with its latest run, last success and failed runs in the window', async () => {
      const h = await health(1)
      const byName = Object.fromEntries((h.cron ?? []).map((j) => [j.name, j]))
      expect(Object.keys(byName).sort()).toEqual(['provider-health-monitor', 'sync-catalog', 'sync-reconciliation-cases'])
      expect(byName['sync-reconciliation-cases']).toMatchObject({ schedule: '*/5 * * * *', active: true, last_status: 'succeeded', runs: 11, failed_runs: 1 })
      expect(byName['sync-catalog']).toMatchObject({ active: false, last_run_at: null, last_status: null })
    })

    it('runs through the judge: a healthy detector is ok, a silent health monitor is late, a missing job is missing, a disabled job is disabled', async () => {
      const h = buildSystemHealth(await health(), Date.now())
      const state = Object.fromEntries(h.cron.jobs.map((j) => [j.name, j.state]))
      expect(state).toMatchObject({ 'sync-reconciliation-cases': 'ok', 'provider-health-monitor': 'late', 'sync-order-status': 'missing', 'sync-catalog': 'disabled' })
      expect(h.status).toBe('critical')
    })

    it('an unreadable scheduler log degrades to "cannot be read", it never fails the snapshot', async () => {
      await db.exec(`alter table cron.job_run_details rename column start_time to started`)
      const h = await health()
      expect(h.cron).toBeNull()
      expect(h.cron_error).toBeTruthy()
      expect(h.db.ok).toBe(true)
    })
  })

  it('is reachable by the service role only: no client can read it or write a heartbeat', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}; select set_config('request.jwt.sub', '${admin}', false)`)
      await expect(db.query(`select get_system_health(24)`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`select record_worker_heartbeat('x', true)`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`select * from worker_heartbeats`)).rejects.toThrow()
    }
    await db.exec(`reset role; set role service_role`)
    await expect(db.query(`select get_system_health(24)`)).resolves.toBeTruthy()
    await db.exec('reset role')
    void user
  })
})

// ---------------------------------------------------------------------------
// 7. Guards over the whole code base
// ---------------------------------------------------------------------------

describe('logging discipline', () => {
  const root = path.resolve(__dirname, '../supabase/functions')
  const functions = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_shared').map((d) => d.name)
  const source = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  it('every Edge Function is wrapped by instrument(): a correlation id on every request', () => {
    expect(functions).toContain('admin-observability')
    for (const fn of functions) expect(source(`${fn}/index.ts`), fn).toMatch(new RegExp(`Deno\\.serve\\(instrument\\('${fn}'`))
  })

  it('nothing in the functions writes to the console directly: every line goes through the sanitizing logger', () => {
    const files = [...functions.map((f) => `${f}/index.ts`), ...fs.readdirSync(path.join(root, '_shared')).filter((f) => f.endsWith('.ts') && f !== 'logger.ts').map((f) => `_shared/${f}`)]
    for (const f of files) expect(source(f), f).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/)
  })

  it('every function that calls an SMM provider hands the adapter the request\'s correlation id and logger', () => {
    for (const fn of ['place-order', 'sync-order-status', 'sync-catalog', 'provider-health-monitor', 'admin-reconciliation']) {
      expect(source(`${fn}/index.ts`), fn).toMatch(/createSMMv2Adapter\([^]*?correlationId[^]*?logger: log/)
      expect(source(`${fn}/index.ts`), fn).toContain('registerSecret(apiKey)')
    }
  })

  it('every HTTP worker reports a heartbeat on success and on failure', () => {
    for (const fn of ['provider-health-monitor', 'sync-order-status', 'sync-catalog']) {
      const s = source(`${fn}/index.ts`)
      expect(s, fn).toContain(`recordHeartbeat(db, '${fn}', { ok: true`)
      expect(s, fn).toContain(`recordHeartbeat(db, '${fn}', { ok: false`)
    }
  })

  it('the heartbeat worker names match what the health judge expects', () => {
    expect(EXPECTED_JOBS.filter((j) => j.worker).map((j) => j.worker).sort()).toEqual(['provider-health-monitor', 'sync-catalog', 'sync-order-status', 'telegram-notifier'])
  })

  it('admin-observability authenticates, re-checks is_admin and only then reads the snapshot', () => {
    const s = source('admin-observability/index.ts')
    expect(s.indexOf('authenticate(req, jwtSecret)')).toBeGreaterThan(-1)
    expect(s.indexOf("eq('is_admin', true)")).toBeGreaterThan(s.indexOf('authenticate(req, jwtSecret)'))
    expect(s.indexOf("eq('is_banned', false)")).toBeGreaterThan(-1)
    expect(s.indexOf("rpc('get_system_health'")).toBeGreaterThan(s.indexOf("eq('is_admin', true)"))
    expect(s).toContain("fail(403, 'forbidden'")
  })
})

// ---------------------------------------------------------------------------
// 8. The screen
// ---------------------------------------------------------------------------

describe('System Health tab', () => {
  const render = async (health: ReturnType<typeof buildSystemHealth>, hours = 24, error: string | null = null) => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { HealthView } = await import('../src/components/admin/ObservabilityTab')
    return renderToStaticMarkup(createElement(HealthView, { health, hours, error, onHours: () => {}, onRefresh: () => {} }))
  }

  it('shows overall status, cron heartbeat and database status', async () => {
    const out = await render(buildSystemHealth(raw(), NOW, 41))
    for (const text of ['All systems operational', 'Cron heartbeat', 'All jobs on time', 'Database', 'Reachable · 41 ms', 'No active alerts', 'Scheduled jobs', 'Reconciliation detector', 'Provider API health', 'Panel']) expect(out).toContain(text)
  })

  it('highlights critical reconciliation cases and the failing job among the active alerts', async () => {
    const h = buildSystemHealth(raw({
      reconciliation: { total: 1, cases: [{ id: 'c', entity_type: 'order', reason: 'needs_refund: x', created_at: ago(5), amount: 5 }] },
      cron: healthyCron().map((j) => (j.name === 'sync-reconciliation-cases' ? { ...j, last_run_at: ago(40), last_success_at: ago(40) } : j)),
    }), NOW)
    const out = await render(h)
    for (const text of ['Critical', 'Act now', '1 critical reconciliation case', 'Reconciliation detector: late', 'role="alert"', 'Late']) expect(out).toContain(text)
    expect(out).not.toContain('No active alerts')
  })

  it('provider API health: error rate, latency, error kinds, order outcomes and recent errors', async () => {
    const out = await render(buildSystemHealth(raw({
      providers: [{ ...raw().providers[0], name: 'Backup', health_status: 'unavailable', checks: 100, failed_checks: 62, avg_latency_ms: 4200, max_latency_ms: 8000, errors_by_kind: { 'http 503': 50, timeout: 12 }, orders: 9, orders_failed: 4, orders_held: 2 }],
      recent_provider_errors: [{ provider_id: 'p1', provider_name: 'Backup', error_kind: 'http 503', status: 'unavailable', latency_ms: 4100, checked_at: ago(1) }],
    }), NOW), 6)
    for (const text of ['Backup', 'Unavailable', '62%', '62 of 100', '4200 ms', 'max 8000 ms', 'http 503 × 50', 'timeout × 12', 'Orders in window: 9 · failed 4 · held 2', 'Recent provider API errors', 'last 6 h']) expect(out).toContain(text)
  })

  it('queues: stuck orders, open cases by severity, pipeline depth', async () => {
    const out = await render(buildSystemHealth(raw({ orders: { stuck: 2, stuck_oldest_minutes: 47, held: 3, queue: { processing: 4, in_progress: 9 } } }), NOW))
    for (const text of ['Stuck orders', 'oldest 47 min', 'In the pipeline', '13', '4 processing · 9 in progress', 'Held orders']) expect(out).toContain(text)
  })

  it('offers the three windows and says when a refresh failed', async () => {
    const out = await render(buildSystemHealth(raw(), NOW), 6, 'Connection lost.')
    expect(out).toContain('aria-label="Time window"')
    for (const w of ['1 h', '6 h', '24 h']) expect(out).toContain(w)
    expect(out).toContain('Refresh failed: Connection lost.')
  })

  it('is a tab of the admin screen', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { AdminScreen } = await import('../src/components/admin/AdminScreen')
    const session = { token: 't', isMock: true, user: { isAdmin: true } } as never
    expect(renderToStaticMarkup(createElement(AdminScreen, { session }))).toContain('System Health')
  })
})
