import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { deliver, eventFor, isReady, runOutbox, type Completion, type OutboxRow, type RunDeps } from '../supabase/functions/_shared/notification-outbox'
import { buildMessage, sendTelegramMessage, type SendResult } from '../supabase/functions/_shared/telegram-notify'
import { createNotifier } from '../supabase/functions/_shared/notify-db'

const TOKEN = '123456789:AAH-secret-bot-token-value'

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 'r1', kind: 'completed', dedupe_key: 'order:o1:completed', attempts: 1, order_id: 'o1abcdef-0000', order_status: 'completed', quantity: 1000, remains: null,
  charge_amount: '4.0000', partial_refund_amount: '0.0000', service_name: 'Telegram Views', user_id: 'u1', telegram_id: 777, language_code: 'en',
  notifications_enabled: true, bot_blocked_recently: false, ...over,
})

describe('messages', () => {
  it('completed, partial and canceled carry the order id, the service and the refund amount', () => {
    expect(buildMessage(eventFor(row()), 'en')).toMatch(/Order completed[\s\S]*#o1abcdef[\s\S]*Telegram Views[\s\S]*1,000 delivered/)
    const partial = buildMessage(eventFor(row({ kind: 'partial', order_status: 'partial', remains: 400, partial_refund_amount: '1.6000' })), 'en')
    expect(partial).toMatch(/partially completed[\s\S]*600 of 1,000 delivered, 400 not delivered[\s\S]*\$1\.60<\/b> was refunded/)
    const canceled = buildMessage(eventFor(row({ kind: 'canceled', order_status: 'refunded' })), 'en')
    expect(canceled).toMatch(/Order canceled[\s\S]*\$4\.00<\/b> was refunded to your balance/)
    expect(buildMessage(eventFor(row({ kind: 'canceled', order_status: 'refunded' })), 'uk')).toContain('повернено')
  })

  it('a cancellation is announced only once its refund is booked', () => {
    expect(isReady(row({ kind: 'canceled', order_status: 'canceled' }))).toBe(false)
    expect(isReady(row({ kind: 'canceled', order_status: 'failed' }))).toBe(false)
    expect(isReady(row({ kind: 'canceled', order_status: 'refunded' }))).toBe(true)
    expect(isReady(row({ kind: 'completed', order_status: 'completed' }))).toBe(true)
    expect(isReady(row({ kind: 'partial', order_status: 'partial' }))).toBe(true)
    expect(isReady(row({ kind: 'completed', order_status: 'in_progress' }))).toBe(false)
  })

  it('names are escaped', () => {
    expect(buildMessage(eventFor(row({ service_name: '<b>x</b>' })), 'en')).not.toContain('<b>x</b>')
  })
})

// ---------------------------------------------------------------------------
// Telegram answers, through the REAL sender with a faked fetch
// ---------------------------------------------------------------------------
describe('Telegram API answers', () => {
  const logs: string[] = []
  const log = { info: (...a: unknown[]) => void logs.push(a.map(String).join(' ')), warn: (...a: unknown[]) => void logs.push(a.map(String).join(' ')) }
  const dedupe = () => {
    const claimed = new Set<string>()
    return {
      claimed,
      claim: vi.fn(async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true))),
      release: vi.fn(async (k: string) => void claimed.delete(k)),
    }
  }
  const withFetch = (impl: () => Promise<Response>) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return impl()
    }) as unknown as typeof fetch
    const d = dedupe()
    const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
      claimBatch: async () => [], complete: async () => {}, dedupe: d, botToken: TOKEN, log,
      send: (o) => sendTelegramMessage({ ...o, fetchImpl }), sleep: async () => {}, ...over,
    })
    return { calls, d, deps }
  }
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

  it('200: delivered, once, to the right chat', async () => {
    const t = withFetch(async () => json(200, { ok: true }))
    expect(await deliver(row(), t.deps())).toEqual({ completion: { outcome: 'sent' }, rateLimited: false })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(t.calls[0].body).toMatchObject({ chat_id: 777, parse_mode: 'HTML' })
  })

  it('403 Forbidden (the user blocked the bot): closed as blocked, not retried, the claim is kept so nothing re-sends', async () => {
    const t = withFetch(async () => json(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }))
    expect(await deliver(row(), t.deps())).toEqual({ completion: { outcome: 'blocked' }, rateLimited: false })
    expect(t.d.release).not.toHaveBeenCalled()
    expect(t.d.claimed.has('order:o1:completed')).toBe(true)
  })

  it('429 with retry_after: a retry after exactly that many seconds, and the run is told to stop', async () => {
    const t = withFetch(async () => json(429, { ok: false, error_code: 429, parameters: { retry_after: 17 } }))
    expect(await deliver(row(), t.deps())).toEqual({ completion: { outcome: 'retry', error: 'rate_limited', retryAfterSeconds: 17 }, rateLimited: true })
    expect(t.d.release).toHaveBeenCalled() // the claim is given back so the retry can send
  })

  it('429 without a usable retry_after still backs off (30 s) and stops the run; absurd values are capped', async () => {
    const a = withFetch(async () => new Response('', { status: 429 }))
    expect(await deliver(row(), a.deps())).toEqual({ completion: { outcome: 'retry', error: 'rate_limited', retryAfterSeconds: 30 }, rateLimited: true })
    const b = withFetch(async () => json(429, { parameters: { retry_after: 999999 } }))
    expect((await deliver(row(), b.deps())).completion).toMatchObject({ retryAfterSeconds: 3600 })
    const c = withFetch(async () => json(429, { parameters: { retry_after: 'soon' } }))
    expect((await deliver(row(), c.deps())).completion).toMatchObject({ retryAfterSeconds: 30 })
  })

  it('5xx, a network failure and a timeout are retried (claim released); a permanent refusal (400) is closed', async () => {
    const e500 = withFetch(async () => json(502, {}))
    expect((await deliver(row(), e500.deps())).completion).toEqual({ outcome: 'retry', error: 'api 502' })
    const net = withFetch(async () => { throw new TypeError('fetch failed') })
    expect((await deliver(row(), net.deps())).completion).toEqual({ outcome: 'retry', error: 'network' })
    const timeout = withFetch(async () => { throw new DOMException('timed out', 'TimeoutError') })
    expect((await deliver(row(), timeout.deps())).completion).toEqual({ outcome: 'retry', error: 'timeout' })
    const gone = withFetch(async () => json(400, { description: 'Bad Request: chat not found' }))
    expect((await deliver(row(), gone.deps())).completion).toEqual({ outcome: 'skipped', error: 'telegram_400' })
    expect(e500.d.release).toHaveBeenCalled()
  })

  it('already told (the worker\'s fast path got there first): done, nothing is sent', async () => {
    const t = withFetch(async () => json(200, { ok: true }))
    t.d.claimed.add('order:o1:completed')
    expect((await deliver(row(), t.deps())).completion).toEqual({ outcome: 'sent' })
    expect(t.calls).toHaveLength(0)
  })

  it('skips without calling Telegram: notifications turned off, bot recently blocked; waits when the refund is not booked or the bot is not configured', async () => {
    const t = withFetch(async () => json(200, { ok: true }))
    expect((await deliver(row({ notifications_enabled: false }), t.deps())).completion).toEqual({ outcome: 'skipped', error: 'notifications_off' })
    expect((await deliver(row({ bot_blocked_recently: true }), t.deps())).completion).toEqual({ outcome: 'skipped', error: 'bot_blocked' })
    expect((await deliver(row({ kind: 'canceled', order_status: 'canceled' }), t.deps())).completion).toEqual({ outcome: 'wait', error: 'refund_not_booked' })
    expect((await deliver(row(), t.deps({ botToken: undefined }))).completion).toEqual({ outcome: 'wait', error: 'bot_not_configured' })
    expect(t.calls).toHaveLength(0)
  })

  it('never throws, whatever the dependencies do, and the bot token never reaches a log line or a completion', async () => {
    logs.length = 0
    const boom = withFetch(async () => { throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`) })
    const r = await deliver(row(), boom.deps())
    const explosive = await deliver(row(), boom.deps({ send: () => { throw new Error('sync boom') }, dedupe: { claim: async () => { throw new Error('db down') }, release: async () => { throw new Error('x') } } }))
    expect(explosive.completion.outcome).toBe('retry')
    expect(JSON.stringify([r, explosive, logs])).not.toContain('secret-bot-token')
  })
})

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
describe('runOutbox', () => {
  const mk = (rows: OutboxRow[], sendFor: (r: OutboxRow) => SendResult = () => ({ ok: true })) => {
    const done = new Map<string, Completion>()
    const sent: string[] = []
    const claimed = new Set<string>()
    const deps: RunDeps = {
      claimBatch: async () => rows,
      complete: async (id, c) => void done.set(id, c),
      dedupe: { claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)), release: async (k) => void claimed.delete(k) },
      botToken: TOKEN,
      send: async (o) => {
        const r = rows.find((x) => Number(x.telegram_id) === Number(o.chatId) && o.text.length > 0)!
        sent.push(r.id)
        return sendFor(r)
      },
      sleep: async () => {},
      log: { info: () => {}, warn: () => {} },
    }
    return { deps, done, sent }
  }
  const rows = (n: number) => Array.from({ length: n }, (_, i) => row({ id: `r${i}`, dedupe_key: `order:o${i}:completed`, order_id: `o${i}-aaaa`, telegram_id: 1000 + i }))

  it('delivers a batch and records every outcome', async () => {
    const t = mk(rows(3))
    const stats = await runOutbox(t.deps)
    expect(stats).toMatchObject({ claimed: 3, sent: 3, retried: 0, rateLimited: false })
    expect([...t.done.values()]).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }, { outcome: 'sent' }])
  })

  it('a rate limit stops the run: the rest is not sent and is handed back as "wait" so no attempt is burned', async () => {
    const batch = rows(5)
    const t = mk(batch, (r) => (r.id === 'r1' ? { ok: false, reason: 'rate_limited', retryable: true, status: 429, retryAfter: 9 } : { ok: true }))
    const stats = await runOutbox(t.deps)
    expect(t.sent).toEqual(['r0', 'r1']) // nothing after the 429
    expect(stats).toMatchObject({ sent: 1, retried: 1, deferred: 3, rateLimited: true })
    expect(t.done.get('r1')).toEqual({ outcome: 'retry', error: 'rate_limited', retryAfterSeconds: 9 })
    for (const id of ['r2', 'r3', 'r4']) expect(t.done.get(id)).toEqual({ outcome: 'wait', error: 'deferred' })
  })

  it('a blocked customer does not stop the others', async () => {
    const t = mk(rows(3), (r) => (r.id === 'r0' ? { ok: false, reason: 'blocked', retryable: false, status: 403 } : { ok: true }))
    const stats = await runOutbox(t.deps)
    expect(stats).toMatchObject({ sent: 2, blocked: 1, rateLimited: false })
    expect(t.done.get('r0')).toEqual({ outcome: 'blocked' })
  })

  it('the time budget hands back what it did not reach', async () => {
    let t0 = 0
    const t = mk(rows(4))
    const stats = await runOutbox({ ...t.deps, budgetMs: 100, now: () => (t0 += 60) })
    expect(stats.sent + stats.deferred).toBe(4)
    expect(stats.deferred).toBeGreaterThan(0)
  })

  it('never throws: a failing claim ends the run quietly; a failing "complete" is counted and the run goes on', async () => {
    const down = mk(rows(2))
    expect(await runOutbox({ ...down.deps, claimBatch: async () => { throw new Error('db down') } })).toMatchObject({ claimed: 0, errors: 1 })
    const flaky = mk(rows(2))
    const stats = await runOutbox({ ...flaky.deps, complete: async () => { throw new Error('db down') } })
    expect(stats).toMatchObject({ claimed: 2, sent: 2, errors: 2 })
  })
})

// ---------------------------------------------------------------------------
// The blocked flag on the worker's fast path
// ---------------------------------------------------------------------------
describe('createNotifier remembers a blocked bot', () => {
  const setup = (bot_blocked_at: string | null) => {
    const updates: Array<Record<string, unknown>> = []
    const user = { telegram_id: 5, language_code: 'en', notifications_enabled: true, bot_blocked_at }
    const db = {
      from(table: string) {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.maybeSingle = async () => ({ data: table === 'users' ? user : null })
        q.insert = async () => ({ error: null })
        q.delete = () => ({ eq: async () => ({}) })
        q.update = (patch: Record<string, unknown>) => { updates.push(patch); return { eq: async () => ({}) } }
        return q
      },
    }
    return { db, updates }
  }
  const env = { get: (n: string) => (n === 'TELEGRAM_BOT_TOKEN' ? TOKEN : undefined) }
  const quiet = { info: () => {}, warn: () => {} }

  it('403 stores bot_blocked_at; a recently blocked user is not messaged again; an old flag expires', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const a = setup(null)
      expect(await createNotifier(a.db, env, quiet)('u1', { type: 'order_completed', orderId: 'x', serviceName: 'S', quantity: 1 }, 'k1')).toBe('failed')
      expect(a.updates).toHaveLength(1)
      expect(a.updates[0]).toHaveProperty('bot_blocked_at')

      fetchMock.mockClear()
      const b = setup(new Date().toISOString())
      expect(await createNotifier(b.db, env, quiet)('u1', { type: 'order_completed', orderId: 'x', serviceName: 'S', quantity: 1 }, 'k2')).toBe('disabled')
      expect(fetchMock).not.toHaveBeenCalled()

      const c = setup(new Date(Date.now() - 31 * 86_400_000).toISOString())
      await createNotifier(c.db, env, quiet)('u1', { type: 'order_completed', orderId: 'x', serviceName: 'S', quantity: 1 }, 'k3')
      expect(fetchMock).toHaveBeenCalledTimes(1) // 31 days later we ask again
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---------------------------------------------------------------------------
// The outbox in the database
// ---------------------------------------------------------------------------
describe('notification_outbox (SQL)', () => {
  let db: PGlite
  let svc: string
  let n = 0
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const call = async (sql: string, p: unknown[] = []) => (await db.query<{ r: any }>(`select ${sql} r`, p)).rows[0].r
  const newUser = async () => {
    const id = await one<string>(`insert into users(telegram_id) values ($1) returning id v`, [7000 + ++n])
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100::numeric, null, 'fund', $2)`, [id, `fund-${id}`])
    return id
  }
  const placed = async (user: string) => {
    const offer = (await rows(`select id, provider_id, provider_service_id, cost_per_1000 from provider_service_offers where service_id = $1`, [svc]))[0]
    const id = await one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/private', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, $6)`,
      [user, svc, offer.id, offer.provider_id, offer.provider_service_id, `k-${++n}`])
    await db.query(`update orders set status = 'processing' where id = $1`, [id])
    await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [id, `P${++n}`])
    return id
  }
  const outbox = (order: string) => rows(`select kind, status::text s, attempts, dedupe_key, (next_attempt_at > now()) as held from notification_outbox where order_id = $1 order by created_at`, [order])
  /** Makes everything due now (the 30 s hold is for the fast path). */
  const due = () => db.query(`update notification_outbox set next_attempt_at = now() - interval '1 second' where status = 'pending'`)

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const provider = await one<string>(`insert into providers(name, api_url) values ('P', 'https://p.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'Views', 2, 1, 1000000) returning id v`, [provider])
    svc = await one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'Views', $2, 4, 1, 1000000) returning id v`, [cat, ps])
  }, 180_000)

  it('service role only; the table is closed to clients', async () => {
    for (const fn of ['claim_notification_batch(integer)', 'complete_notification(uuid, text, integer, text)', 'notification_outbox_stats()']) {
      const g = (await rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, has_function_privilege('service_role', '${fn}', 'execute') s`))[0]
      expect([g.a, g.u, g.s]).toEqual([false, false, true])
    }
    const t = (await rows(`select has_table_privilege('authenticated', 'notification_outbox', 'select') s, has_table_privilege('authenticated', 'notification_outbox', 'insert') i`))[0]
    expect([t.s, t.i]).toEqual([false, false])
  })

  it('a trigger queues one row when an order completes, in the same transaction, held back 30 s for the fast path', async () => {
    const u = await newUser()
    const o = await placed(u)
    expect(await outbox(o)).toEqual([])
    await db.query(`update orders set status = 'completed' where id = $1`, [o])
    expect(await outbox(o)).toEqual([{ kind: 'completed', s: 'pending', attempts: 0, dedupe_key: `order:${o}:completed`, held: true }])
  })

  it('partial and canceled/failed are queued too (failed is told as canceled); other transitions are not', async () => {
    const u = await newUser()
    const p = await placed(u)
    await db.query(`select apply_partial_refund($1::uuid, 400, 1)`, [p])
    expect((await outbox(p)).map((r) => r.kind)).toEqual(['partial'])

    const c = await placed(u)
    await db.query(`update orders set status = 'canceled' where id = $1`, [c])
    expect((await outbox(c)).map((r) => r.kind)).toEqual(['canceled'])
    await db.query(`select refund_order($1::uuid, null, 'x')`, [c]) // canceled -> refunded: nothing new
    expect(await outbox(c)).toHaveLength(1)

    const f = await placed(u)
    await db.query(`update orders set status = 'failed' where id = $1`, [f])
    expect((await outbox(f)).map((r) => [r.kind, r.dedupe_key])).toEqual([['canceled', `order:${f}:canceled`]])

    const i = await placed(u)
    await db.query(`update orders set status = 'in_progress' where id = $1`, [i])
    expect(await outbox(i)).toEqual([])
  })

  it('an outbox failure never fails the order', async () => {
    const u = await newUser()
    const o = await placed(u)
    await db.exec(`alter table notification_outbox add constraint force_fail check (false) not valid`)
    await db.query(`update orders set status = 'completed' where id = $1`, [o]) // must not throw
    await db.exec(`alter table notification_outbox drop constraint force_fail`)
    expect(await one(`select status::text v from orders where id = $1`, [o])).toBe('completed')
    expect(await outbox(o)).toEqual([])
  })

  it('claim: only due rows, with the facts for the message; a lease keeps a second claim from taking them; attempts count', async () => {
    const u = await newUser()
    const o = await placed(u)
    await db.query(`select apply_partial_refund($1::uuid, 400, 1)`, [o])
    expect(await call(`claim_notification_batch(10)`)).toEqual([]) // still inside the 30 s hold
    await due()
    const batch = await call(`claim_notification_batch(10)`)
    const mine = batch.find((b: any) => b.order_id === o)
    expect(mine).toMatchObject({ kind: 'partial', order_status: 'partial', quantity: 1000, remains: 400, partial_refund_amount: 1.6, service_name: 'Views', notifications_enabled: true, bot_blocked_recently: false, attempts: 1 })
    expect(Number(mine.telegram_id)).toBeGreaterThan(7000)
    expect((await call(`claim_notification_batch(10)`)).find((b: any) => b.order_id === o)).toBeUndefined() // leased for 2 minutes
    expect((await outbox(o))[0]).toMatchObject({ attempts: 1, held: true })
  })

  it('complete: sent / skipped finish a row; repeating a report changes nothing', async () => {
    const u = await newUser()
    const a = await placed(u), b = await placed(u)
    await db.query(`update orders set status = 'completed' where id in ($1, $2)`, [a, b])
    const ida = await one<string>(`select id v from notification_outbox where order_id = $1`, [a])
    const idb = await one<string>(`select id v from notification_outbox where order_id = $1`, [b])
    expect(await call(`complete_notification($1::uuid, 'sent')`, [ida])).toBe('sent')
    expect(await call(`complete_notification($1::uuid, 'retry', null, 'late')`, [ida])).toBe('sent') // already finished
    expect(await call(`complete_notification($1::uuid, 'skipped', null, 'notifications_off')`, [idb])).toBe('skipped')
    expect(await rows(`select status::text s from notification_outbox where id = $1`, [ida])).toEqual([{ s: 'sent' }])
    await expect(db.query(`select complete_notification($1::uuid, 'bogus')`, [await one(`select id v from notification_outbox where status = 'pending' limit 1`).catch(() => ida)])).rejects.toThrow()
  })

  it('blocked: the row is closed and the USER is flagged; retry: back-off 1, 2, 5, 15, 30, 60 min; retry_after wins; dead after 8 tries', async () => {
    const u = await newUser()
    const o = await placed(u)
    await db.query(`update orders set status = 'completed' where id = $1`, [o])
    const id = await one<string>(`select id v from notification_outbox where order_id = $1`, [o])

    const waits: number[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      await db.query(`update notification_outbox set attempts = $2 where id = $1`, [id, attempt])
      expect(await call(`complete_notification($1::uuid, 'retry', null, 'network')`, [id])).toBe('pending')
      waits.push(Math.round(Number(await one(`select extract(epoch from next_attempt_at - now()) v from notification_outbox where id = $1`, [id])) / 60))
    }
    expect(waits).toEqual([1, 2, 5, 15, 30, 60])

    await call(`complete_notification($1::uuid, 'retry', 17, 'rate_limited')`, [id])
    expect(Math.round(Number(await one(`select extract(epoch from next_attempt_at - now()) v from notification_outbox where id = $1`, [id])))).toBe(17)

    await db.query(`update notification_outbox set attempts = 8 where id = $1`, [id])
    expect(await call(`complete_notification($1::uuid, 'retry', null, 'network')`, [id])).toBe('dead')

    const o2 = await placed(u)
    await db.query(`update orders set status = 'completed' where id = $1`, [o2])
    const id2 = await one<string>(`select id v from notification_outbox where order_id = $1`, [o2])
    expect(await call(`complete_notification($1::uuid, 'blocked')`, [id2])).toBe('blocked')
    expect(await one(`select bot_blocked_at is not null v from users where id = $1`, [u])).toBe(true)
  })

  it('wait does not count as a failure; a row that has waited 24 hours is dead', async () => {
    const u = await newUser()
    const o = await placed(u)
    await db.query(`update orders set status = 'canceled' where id = $1`, [o])
    const id = await one<string>(`select id v from notification_outbox where order_id = $1`, [o])
    await db.query(`update notification_outbox set attempts = 3 where id = $1`, [id])
    expect(await call(`complete_notification($1::uuid, 'wait', null, 'refund_not_booked')`, [id])).toBe('pending')
    expect(Number(await one(`select attempts v from notification_outbox where id = $1`, [id]))).toBe(2)
    await db.query(`update notification_outbox set created_at = now() - interval '25 hours' where id = $1`, [id])
    expect(await call(`complete_notification($1::uuid, 'wait', null, 'refund_not_booked')`, [id])).toBe('dead')
  })

  it('end to end: a canceled order is announced only after its refund, exactly once, even if the fast path told them first', async () => {
    const u = await newUser()
    const o = await placed(u)
    await db.query(`update orders set status = 'canceled', error_message = 'needs_refund: x' where id = $1`, [o])
    await due()

    const told = new Set<string>()
    const sent: string[] = []
    const ports = (): RunDeps => ({
      claimBatch: async () => (await call(`claim_notification_batch(50)`)).filter((b: any) => b.order_id === o),
      complete: async (id, c) => void (await db.query(`select complete_notification($1::uuid, $2, $3::int, $4)`, [id, c.outcome, 'retryAfterSeconds' in c ? c.retryAfterSeconds ?? null : null, 'error' in c ? c.error : null])),
      dedupe: { claim: async (k) => (told.has(k) ? false : (told.add(k), true)), release: async (k) => void told.delete(k) },
      botToken: TOKEN,
      send: async (opts) => { sent.push(opts.text); return { ok: true } },
      sleep: async () => {},
      log: { info: () => {}, warn: () => {} },
    })

    // refund not booked yet -> waits, nothing sent
    expect(await runOutbox(ports())).toMatchObject({ claimed: 1, waiting: 1, sent: 0 })
    expect(sent).toHaveLength(0)
    expect((await outbox(o))[0]).toMatchObject({ s: 'pending', attempts: 0 })

    // the refund is booked
    await db.query(`select refund_order($1::uuid, null, 'x')`, [o])
    await due()
    expect(await runOutbox(ports())).toMatchObject({ claimed: 1, sent: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('$4.00')
    expect((await outbox(o))[0]).toMatchObject({ s: 'sent' })

    // an order the fast path already announced: the outbox closes it without sending
    const o2 = await placed(u)
    await db.query(`update orders set status = 'completed' where id = $1`, [o2])
    told.add(`order:${o2}:completed`)
    await due()
    const before = sent.length
    const p2 = ports()
    expect(await runOutbox({ ...p2, claimBatch: async () => (await call(`claim_notification_batch(50)`)).filter((b: any) => b.order_id === o2) })).toMatchObject({ sent: 1 })
    expect(sent.length).toBe(before)
  })

  it('stats for the health board', async () => {
    const s = await call(`notification_outbox_stats()`)
    expect(s).toEqual({ pending: expect.any(Number), oldest_pending_seconds: expect.any(Number), sent: expect.any(Number), blocked: expect.any(Number), dead: expect.any(Number) })
  })
})
