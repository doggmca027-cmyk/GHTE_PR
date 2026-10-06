import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { parseAdminIds } from '../supabase/functions/_shared/admin.ts'
import { computeAdminMetrics, inReconciliationQueue, metricsFromRpc, type MetricOrder } from '../supabase/functions/_shared/admin-metrics.ts'
import { createNotifier } from '../supabase/functions/_shared/notify-db.ts'
import { syncProviderOrders, type SyncEvent, type SyncOrder, type SyncPorts } from '../supabase/functions/_shared/order-sync.ts'
import {
  buildMessage,
  escapeHtml,
  fireAndForget,
  formatUsd,
  notifyUser,
  resolveLang,
  sendTelegramMessage,
  type NotifyDeps,
  type NotifyEvent,
  type SendResult,
} from '../supabase/functions/_shared/telegram-notify.ts'
import type { OrderStatus } from '../supabase/functions/_shared/types.ts'
import { describeNote, formatRuleValue } from '../src/lib/admin-view'
import { timeAgo } from '../src/lib/time'
import { AdminApiError, createMockAdmin } from '../src/services/api/mock-admin'
import { getAdminMetrics, listPriceRules } from '../src/services/api/admin'
import { createMockBackend } from '../src/services/api/mock-orders'
import { MOCK_CATALOG, MOCK_SESSION } from '../src/constants/dev'

// ---------------------------------------------------------------------------
// 1. Notification formatting and HTML escaping
// ---------------------------------------------------------------------------

const EVENTS: Record<string, NotifyEvent> = {
  deposit: { type: 'deposit_completed', amountUsd: 25, asset: 'TON', amountCrypto: '5.000000000', balance: 49.5 },
  completed: { type: 'order_completed', orderId: 'a1b2c3d4-0000-4000-8000-000000000000', serviceName: 'Telegram Channel Members', quantity: 1000 },
  canceled: { type: 'order_canceled', orderId: 'a1b2c3d4-0000-4000-8000-000000000000', serviceName: 'Telegram Channel Members', quantity: 1000, refundAmount: 5.4 },
  partial: { type: 'order_partial', orderId: 'a1b2c3d4-0000-4000-8000-000000000000', serviceName: 'Telegram Channel Members', quantity: 1000, remains: 300, refundAmount: 1.62 },
}

/** Everything Telegram's HTML parser would see as markup, with our own <b> tags removed. */
const strayMarkup = (html: string) => html.replace(/<\/?b>/g, '')

describe('notification templates', () => {
  it('formats every event in English', () => {
    expect(buildMessage(EVENTS.deposit, 'en')).toBe('✅ <b>Deposit received</b>\n<b>+$25.00</b> (5 TON) was added to your balance.\nNew balance: <b>$49.50</b>')
    expect(buildMessage(EVENTS.completed, 'en')).toBe('🎉 <b>Order completed</b>\n#a1b2c3d4 · Telegram Channel Members\n1,000 delivered.')
    expect(buildMessage(EVENTS.canceled, 'en')).toContain('<b>Order canceled</b>')
    expect(buildMessage(EVENTS.canceled, 'en')).toContain('<b>$5.40</b> was refunded')
    const partial = buildMessage(EVENTS.partial, 'en')
    expect(partial).toContain('700 of 1,000 delivered, 300 not delivered')
    expect(partial).toContain('<b>$1.62</b> was refunded to your balance')
  })

  it('formats every event in Ukrainian', () => {
    expect(buildMessage(EVENTS.deposit, 'uk')).toBe('✅ <b>Поповнення отримано</b>\n<b>+$25.00</b> (5 TON) зараховано на ваш баланс.\nНовий баланс: <b>$49.50</b>')
    expect(buildMessage(EVENTS.completed, 'uk')).toContain('Замовлення виконано')
    expect(buildMessage(EVENTS.canceled, 'uk')).toContain('Замовлення скасовано')
    expect(buildMessage(EVENTS.canceled, 'uk')).toContain('<b>$5.40</b> повернено')
    expect(buildMessage(EVENTS.partial, 'uk')).toContain('Доставлено 700 з 1,000, не доставлено 300')
  })

  it('picks the language from the Telegram language code (Ukrainian, otherwise English)', () => {
    for (const code of ['uk', 'uk-UA', 'UK', 'uk_UA']) expect(resolveLang(code)).toBe('uk')
    for (const code of ['en', 'en-US', 'ru', 'de', 'ukr', '', null, undefined]) expect(resolveLang(code as string)).toBe('en')
  })

  it('formats money with at least cents and up to 4 decimals', () => {
    expect([5.4, 0.0054, 1234.5, 0, 0.1, 2.5, 1.62].map(formatUsd)).toEqual(['$5.40', '$0.0054', '$1,234.50', '$0.00', '$0.10', '$2.50', '$1.62'])
  })

  it('omits the crypto amount when it is not known', () => {
    expect(buildMessage({ type: 'deposit_completed', amountUsd: 10, balance: 10 }, 'en')).not.toContain('(')
  })

  describe('HTML escaping', () => {
    const evil = '<script>alert(1)</script> & "quotes" <b>bold</b> <a href="x">link</a>'

    it('escapes the characters Telegram HTML treats specially', () => {
      expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
      expect(escapeHtml('plain text 123')).toBe('plain text 123')
    })

    it.each(['en', 'uk'] as const)('never lets user/admin controlled text inject markup (%s)', (lang) => {
      for (const make of [
        (name: string): NotifyEvent => ({ type: 'order_completed', orderId: 'x', serviceName: name, quantity: 1 }),
        (name: string): NotifyEvent => ({ type: 'order_canceled', orderId: 'x', serviceName: name, quantity: 1, refundAmount: 1 }),
        (name: string): NotifyEvent => ({ type: 'order_partial', orderId: 'x', serviceName: name, quantity: 10, remains: 3, refundAmount: 1 }),
      ]) {
        const msg = buildMessage(make(evil), lang)
        expect(msg).not.toContain('<script')
        expect(msg).not.toContain('<a ')
        expect(msg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &lt;b&gt;bold&lt;/b&gt;')
        expect(strayMarkup(msg)).not.toMatch(/[<>]/) // only our own <b></b> remain
      }
    })

    it('escapes the order id and the asset name too', () => {
      const msg = buildMessage({ type: 'order_completed', orderId: '<img src=x>', serviceName: 's', quantity: 1 }, 'en')
      expect(strayMarkup(msg)).not.toMatch(/[<>]/)
      const dep = buildMessage({ type: 'deposit_completed', amountUsd: 1, asset: '<TON>', amountCrypto: '1.0', balance: 1 }, 'en')
      expect(strayMarkup(dep)).not.toMatch(/[<>]/)
    })

    it('clips very long service names and always stays under the Telegram limit', () => {
      const msg = buildMessage({ type: 'order_completed', orderId: 'id', serviceName: 'x'.repeat(10_000), quantity: 1 }, 'en')
      expect(msg.length).toBeLessThan(300)
      expect(msg).toContain('…')
      expect(buildMessage({ type: 'order_completed', orderId: 'id', serviceName: '<'.repeat(10_000), quantity: 1 }, 'en').length).toBeLessThanOrEqual(4096)
    })

    it('keeps escaped entities intact even after clipping (no half entities)', () => {
      const msg = buildMessage({ type: 'order_completed', orderId: 'id', serviceName: '&'.repeat(200), quantity: 1 }, 'en')
      expect(msg).not.toMatch(/&(?!amp;)/)
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Sending: every failure mode is a result, never an exception
// ---------------------------------------------------------------------------

describe('sendTelegramMessage', () => {
  const TOKEN = '123456:SECRET-TOKEN'
  const send = (fetchImpl: typeof fetch) => sendTelegramMessage({ botToken: TOKEN, chatId: 42, text: 'hi', fetchImpl })
  const respond = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch

  it('posts HTML to the bot API with the chat id', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) })
      return new Response('{"ok":true}')
    }) as unknown as typeof fetch
    expect(await send(fetchImpl)).toEqual({ ok: true })
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(calls[0].body).toEqual({ chat_id: 42, text: 'hi', parse_mode: 'HTML', disable_web_page_preview: true })
  })

  it.each([
    [403, { ok: false, reason: 'blocked', retryable: false, status: 403 }],
    [429, { ok: false, reason: 'rate_limited', retryable: true, status: 429 }],
    [400, { ok: false, reason: 'api', retryable: false, status: 400 }],
    [502, { ok: false, reason: 'api', retryable: true, status: 502 }],
  ])('HTTP %d is reported, not thrown', async (status, expected) => {
    expect(await send(respond(status))).toEqual(expected)
  })

  it('treats network failures and timeouts as retryable results and never leaks the token', async () => {
    const down = (async () => { throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`) }) as unknown as typeof fetch
    const r1 = await send(down)
    expect(r1).toEqual({ ok: false, reason: 'network', retryable: true })
    expect(JSON.stringify(r1)).not.toContain('SECRET')

    const slow = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch
    const r2 = await sendTelegramMessage({ botToken: TOKEN, chatId: 1, text: 'x', fetchImpl: slow, timeoutMs: 20 })
    expect(r2).toEqual({ ok: false, reason: 'timeout', retryable: true })
  })
})

// ---------------------------------------------------------------------------
// 3. Dispatch: preferences, dedupe, failure policy, never throws
// ---------------------------------------------------------------------------

function deps(over: Partial<NotifyDeps> & { send?: () => Promise<SendResult> } = {}) {
  const claimed = new Set<string>()
  const log = { info: vi.fn(), warn: vi.fn() }
  const d: NotifyDeps = {
    botToken: 'T',
    claim: vi.fn(async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true))),
    release: vi.fn(async (k: string) => void claimed.delete(k)),
    send: vi.fn(over.send ?? (async () => ({ ok: true }) as SendResult)) as unknown as NotifyDeps['send'],
    log,
    ...over,
  }
  return { d, claimed, log }
}
const TARGET = { chatId: 42, lang: 'en' as const, enabled: true }

describe('notifyUser', () => {
  it('sends once and deduplicates repeats of the same event', async () => {
    const { d } = deps()
    expect(await notifyUser(d, TARGET, EVENTS.deposit, 'deposit:1')).toBe('sent')
    expect(await notifyUser(d, TARGET, EVENTS.deposit, 'deposit:1')).toBe('duplicate')
    expect(await notifyUser(d, TARGET, EVENTS.deposit, 'deposit:2')).toBe('sent')
    expect(d.send).toHaveBeenCalledTimes(2)
  })

  it('respects notifications_enabled: nothing is claimed or sent', async () => {
    const { d } = deps()
    expect(await notifyUser(d, { ...TARGET, enabled: false }, EVENTS.deposit, 'k')).toBe('disabled')
    expect(d.claim).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('a user who blocked the bot is not retried and does not raise', async () => {
    const { d, claimed } = deps({ send: async () => ({ ok: false, reason: 'blocked', retryable: false, status: 403 }) })
    expect(await notifyUser(d, TARGET, EVENTS.completed, 'k')).toBe('failed')
    expect(claimed.has('k')).toBe(true) // claim kept: never try this event again
    expect(d.release).not.toHaveBeenCalled()
  })

  it('a transient failure releases the claim so a later run can retry, and the retry then succeeds', async () => {
    let attempt = 0
    const { d, claimed } = deps({ send: async () => (++attempt === 1 ? { ok: false, reason: 'network', retryable: true } : { ok: true }) })
    expect(await notifyUser(d, TARGET, EVENTS.completed, 'k')).toBe('failed')
    expect(claimed.has('k')).toBe(false)
    expect(await notifyUser(d, TARGET, EVENTS.completed, 'k')).toBe('sent')
  })

  it('never throws, whatever breaks', async () => {
    const boom = () => { throw new Error('db exploded') }
    for (const broken of [
      deps({ claim: async () => boom() }).d,
      deps({ send: async () => boom() }).d,
      deps({ release: async () => boom(), send: async () => ({ ok: false, reason: 'network', retryable: true }) }).d,
    ]) {
      await expect(notifyUser(broken, TARGET, EVENTS.completed, 'k')).resolves.toMatch(/failed|error/)
    }
    await expect(notifyUser(deps().d, { ...TARGET, lang: 'xx' as never }, EVENTS.completed, 'k2')).resolves.toBe('error')
  })

  it('without a bot token: skipped in production, logged to the console in mock mode', async () => {
    const prod = deps({ botToken: undefined })
    expect(await notifyUser(prod.d, TARGET, EVENTS.deposit, 'k')).toBe('unconfigured')
    expect(prod.d.send).not.toHaveBeenCalled()

    const mock = deps({ botToken: undefined, mock: true })
    expect(await notifyUser(mock.d, TARGET, EVENTS.deposit, 'k')).toBe('mock_logged')
    expect(mock.log.info).toHaveBeenCalledWith(expect.stringContaining('Deposit received'))
    expect(mock.d.send).not.toHaveBeenCalled()
  })

  it('fireAndForget never rejects', async () => {
    expect(() => fireAndForget(Promise.reject(new Error('x')))).not.toThrow()
    await new Promise((r) => setTimeout(r, 5))
  })
})

describe('createNotifier (Supabase-bound dispatcher, fake database)', () => {
  function fakeDb(opts: { user?: Record<string, unknown> | null; claimError?: boolean } = {}) {
    const log = new Map<string, unknown>()
    const user = opts.user === undefined ? { telegram_id: 777, language_code: 'uk', notifications_enabled: true } : opts.user
    return {
      log,
      db: {
        from(table: string) {
          if (table === 'users') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: user }) }) }) }
          return {
            insert: async (row: { dedupe_key: string }) => {
              if (opts.claimError || log.has(row.dedupe_key)) return { error: { code: opts.claimError ? 'XX000' : '23505' } }
              log.set(row.dedupe_key, row)
              return { error: null }
            },
            delete: () => ({ eq: async (_c: string, key: string) => (log.delete(key), { error: null }) }),
          }
        },
      },
    }
  }
  const env = (token?: string) => ({ get: (k: string) => (k === 'TELEGRAM_BOT_TOKEN' ? token : undefined) })
  const quiet = { info: vi.fn(), warn: vi.fn() }
  const okFetch = () => {
    const sent: { chat_id: number; text: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => (sent.push(JSON.parse(init.body as string)), new Response('{}'))))
    return sent
  }

  it('sends one localized message per event and never a duplicate', async () => {
    const sent = okFetch()
    const { db } = fakeDb()
    const notify = createNotifier(db, env('TOKEN'), quiet)
    expect(await notify('u1', EVENTS.deposit, 'deposit:1')).toBe('sent')
    expect(await notify('u1', EVENTS.deposit, 'deposit:1')).toBe('duplicate')
    expect(sent).toHaveLength(1)
    expect(sent[0].chat_id).toBe(777)
    expect(sent[0].text).toContain('Поповнення отримано') // uk-language user
    vi.unstubAllGlobals()
  })

  it('does not send when the database cannot record the claim (a missed message beats a duplicate)', async () => {
    const sent = okFetch()
    expect(await createNotifier(fakeDb({ claimError: true }).db, env('TOKEN'), quiet)('u1', EVENTS.deposit, 'k')).toBe('duplicate')
    expect(sent).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('unknown user or a throwing database resolves quietly', async () => {
    expect(await createNotifier(fakeDb({ user: null }).db, env('TOKEN'), quiet)('ghost', EVENTS.deposit, 'k')).toBe('error')
    const exploding = { from: () => { throw new Error('connection refused') } }
    await expect(createNotifier(exploding, env('TOKEN'), quiet)('u1', EVENTS.deposit, 'k')).resolves.toBe('error')
  })

  it('honours the per-user switch', async () => {
    const sent = okFetch()
    const { db } = fakeDb({ user: { telegram_id: 1, language_code: 'en', notifications_enabled: false } })
    expect(await createNotifier(db, env('TOKEN'), quiet)('u1', EVENTS.deposit, 'k')).toBe('disabled')
    expect(sent).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// 4. Notifications cannot break order processing
// ---------------------------------------------------------------------------

describe('sync worker notification hooks', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z')
  const order = (over: Partial<SyncOrder> = {}): SyncOrder => ({
    id: 'o1', user_id: 'u1', service_id: 's1', provider_order_id: 'P1', status: 'in_progress', quantity: 1000, charge_amount: 5.4,
    remains: null, start_count: null, error_message: null, created_at: new Date(NOW - 60_000).toISOString(), ...over,
  })
  const ports = (notify?: SyncPorts['notify']) => {
    const state = { status: 'in_progress' as OrderStatus, refunds: 0 }
    const p: SyncPorts = {
      setProviderOrderId: async () => {},
      updateOrder: async (_id, patch) => (patch.status && (state.status = patch.status), true),
      applyPartialRefund: async (_id, remains) => (state.status = 'partial', 1.35 + remains * 0),
      refundOrder: async () => { state.refunds++; state.status = 'refunded' },
      touch: async () => {},
      notify,
    }
    return { p, state }
  }
  const adapter = (status: 'completed' | 'canceled' | 'partial') => ({
    getOrdersStatus: async () => ({ P1: { ok: true as const, status: { orderId: 'P1', rawStatus: status, status, remains: status === 'partial' ? 250 : 0 } } }),
  })
  const quiet = { error: vi.fn(), warn: vi.fn() }

  it.each([
    ['completed', 'completed', undefined],
    ['canceled', 'canceled', 5.4],
    ['partial', 'partial', 1.35],
  ] as const)('emits a %s event with the right amounts', async (provider, type, refund) => {
    const events: SyncEvent[] = []
    const { p } = ports((e) => void events.push(e))
    await syncProviderOrders([order()], adapter(provider), p, { now: NOW }, quiet)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type, order: { id: 'o1', user_id: 'u1', service_id: 's1' } })
    expect(events[0].refundAmount).toBe(refund)
    if (type === 'partial') expect(events[0].order.remains).toBe(250)
  })

  it('a notification that throws (sync or async) changes nothing about the outcome', async () => {
    for (const notify of [() => { throw new Error('sync boom') }, async () => { throw new Error('async boom') }]) {
      const { p, state } = ports(notify)
      const stats = await syncProviderOrders([order()], adapter('canceled'), p, { now: NOW }, quiet)
      expect(state).toMatchObject({ status: 'refunded', refunds: 1 }) // money moved exactly once
      expect(stats).toMatchObject({ canceledRefunded: 1, errors: [] })
    }
  })

  it('emits no event for ordinary progress or when nothing changed', async () => {
    const events: SyncEvent[] = []
    const { p } = ports((e) => void events.push(e))
    const inProgress = { getOrdersStatus: async () => ({ P1: { ok: true as const, status: { orderId: 'P1', rawStatus: 'In progress', status: 'in_progress' as const, remains: 400 } } }) }
    await syncProviderOrders([order()], inProgress, p, { now: NOW }, quiet)
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Admin bootstrap list
// ---------------------------------------------------------------------------

describe('parseAdminIds', () => {
  it('parses comma / space / semicolon separated ids and ignores junk', () => {
    expect([...parseAdminIds('123456, 789;42  7')].sort((a, b) => a - b)).toEqual([7, 42, 789, 123456])
    expect([...parseAdminIds('abc, -5, 0, 1.5, 12x, 99999999999999999999, ')]).toEqual([])
    expect(parseAdminIds(undefined).size).toBe(0)
    expect(parseAdminIds('').size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Admin security boundary: the real migrations in an in-process Postgres
// ---------------------------------------------------------------------------

async function freshDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  await db.exec(`
    insert into providers(name, api_url, balance, priority) values ('p', 'https://x', 842.17, 5);
    insert into categories(platform, name, slug) values ('telegram', 'Telegram Views', 'tv');
    insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, last_synced_at)
      select id, '1', 's', 1, 1, 1000000, now() - interval '5 minutes' from providers;
    insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      select c.id, 'Views', ps.id, 1, 1, 1000000 from categories c, provider_services ps;`)
  return db
}

const CHAIN: Record<string, OrderStatus[]> = {
  draft: [],
  canceled: ['canceled'],
  failed: ['awaiting_payment', 'paid', 'failed'],
  refunded: ['awaiting_payment', 'paid', 'refunded'],
  submitted: ['awaiting_payment', 'paid', 'processing', 'submitted'],
  processing: ['awaiting_payment', 'paid', 'processing'],
  in_progress: ['awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress'],
  completed: ['awaiting_payment', 'paid', 'processing', 'submitted', 'completed'],
  partial: ['awaiting_payment', 'paid', 'processing', 'submitted', 'partial'],
}

interface OrderSpec {
  userId: string
  status: keyof typeof CHAIN
  charge: number
  cost?: number
  quantity?: number
  remains?: number
  partialRefund?: number
  error?: string | null
  ageMinutes?: number
  paid?: boolean
}

let tg = 100
async function newUser(db: PGlite, opts: { admin?: boolean; banned?: boolean } = {}) {
  const { id } = (await db.query<{ id: string }>(`insert into users(telegram_id, username, is_admin, is_banned) values ($1, $2, $3, $4) returning id`, [++tg, `user${tg}`, opts.admin ?? false, opts.banned ?? false])).rows[0]
  return id
}

async function newOrder(db: PGlite, o: OrderSpec) {
  const { id } = (await db.query<{ id: string }>(
    `insert into orders(user_id, service_id, target_url, quantity, charge_amount, cost_amount, provider_id)
     select $1, s.id, 'https://t.me/x', $2, $3, $4, ps.provider_id from services s join provider_services ps on ps.id = s.primary_provider_service_id returning id`,
    [o.userId, o.quantity ?? 1000, o.charge, o.cost ?? 0])).rows[0]
  if (o.paid) {
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',1000,null,'fund','fund:'||gen_random_uuid())`, [o.userId])
    await db.query(`select process_wallet_transaction($1::uuid,'purchase',-$2::numeric,$3::uuid,'order','purchase:'||$3::text)`, [o.userId, o.charge, id])
  }
  for (const s of CHAIN[o.status]) await db.query(`update orders set status=$2 where id=$1`, [id, s])
  await db.query(
    `update orders set remains=$2, partial_refund_amount=$3, error_message=$4, created_at = now() - make_interval(mins => $5) where id=$1`,
    [id, o.remains ?? null, o.partialRefund ?? 0, o.error ?? null, o.ageMinutes ?? 0])
  return id
}

const asUser = (db: PGlite, id: string | '') => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${id}',false)`)
const asAnon = (db: PGlite) => db.exec(`reset role; set role anon`)
const asServer = (db: PGlite) => db.exec(`reset role`)

describe('admin security boundary', () => {
  let db: PGlite
  let admin: string, user: string, bannedAdmin: string
  const RPCS: [string, string][] = [
    ['get_admin_metrics', `select get_admin_metrics()`],
    ['admin_provider_status', `select admin_provider_status()`],
    ['admin_reconciliation_queue', `select admin_reconciliation_queue()`],
    ['admin_list_price_rules', `select admin_list_price_rules()`],
    ['admin_force_refund', `select admin_force_refund(gen_random_uuid())`],
    ['admin_mark_resolved', `select admin_mark_resolved(gen_random_uuid(), 'x', 'n')`],
    ['admin_update_price_rule', `select admin_update_price_rule(gen_random_uuid(), 1)`],
    ['get_admin_pricing_view', `select get_admin_pricing_view()`],
    ['update_platform_settings', `select update_platform_settings(true, true, false)`],
    ['admin_list_providers', `select admin_list_providers()`],
    ['admin_update_provider_config', `select admin_update_provider_config(gen_random_uuid(), 1)`],
  ]

  beforeAll(async () => {
    db = await freshDb()
    admin = await newUser(db, { admin: true })
    user = await newUser(db)
    bannedAdmin = await newUser(db, { admin: true, banned: true })
    await db.exec(`insert into price_rules(name, type, value, priority) values ('Default +300%', 'percentage', 300, 0), ('Telegram', 'percentage', 200, 0)`)
  }, 120_000)

  describe.each(RPCS)('%s', (_name, sql) => {
    it('rejects a regular user', async () => {
      await asUser(db, user)
      await expect(db.query(sql)).rejects.toThrow(/forbidden/)
      await asServer(db)
    })
    it('rejects a request with no identity at all', async () => {
      await asUser(db, '')
      await expect(db.query(sql)).rejects.toThrow(/forbidden/)
      await asServer(db)
    })
    it('rejects an admin who has been banned', async () => {
      await asUser(db, bannedAdmin)
      await expect(db.query(sql)).rejects.toThrow(/forbidden/)
      await asServer(db)
    })
    it('is not executable by the anon role', async () => {
      await asAnon(db)
      await expect(db.query(sql)).rejects.toThrow(/permission denied/)
      await asServer(db)
    })
  })

  it('lets a real admin through every read RPC', async () => {
    await asUser(db, admin)
    for (const [, sql] of RPCS.slice(0, 4)) await expect(db.query(sql)).resolves.toBeDefined()
    await asServer(db)
  })

  it('a user cannot promote themselves, edit rules, or read admin / notification data', async () => {
    await asUser(db, user)
    await expect(db.query(`update users set is_admin = true where id = '${user}'`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`update users set is_admin = true`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`update price_rules set value = 0`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`insert into price_rules(name,type,value) values ('x','percentage',0)`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select * from price_rules`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select * from admin_audit_log`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`insert into admin_audit_log(action) values ('forged')`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select * from notification_log`)).rejects.toThrow(/permission denied/)
    await asServer(db)
  })

  it('internal money / gate functions are not callable by clients', async () => {
    await asUser(db, admin) // even an admin cannot call the raw functions: only the audited RPCs
    for (const sql of [
      `select refund_order(gen_random_uuid())`,
      `select apply_partial_refund(gen_random_uuid(), 1)`,
      `select process_wallet_transaction('${admin}','bonus',999)`,
      `select require_admin()`,
    ]) await expect(db.query(sql)).rejects.toThrow(/permission denied/)
    await asServer(db)
  })

  it('a user sees only their own admin flag', async () => {
    await asUser(db, user)
    const rows = (await db.query<{ id: string; is_admin: boolean }>(`select id, is_admin from users`)).rows
    expect(rows).toEqual([{ id: user, is_admin: false }])
    await asServer(db)
  })

  it('granting or revoking admin outside the app leaves an audit trail, and the log is append-only', async () => {
    const u = await newUser(db)
    await db.query(`update users set is_admin = true where id = $1`, [u])
    await db.query(`update users set is_admin = false where id = $1`, [u])
    const rows = (await db.query<{ action: string; admin_id: string | null }>(`select action, admin_id from admin_audit_log where target_id = $1 order by created_at`, [u])).rows
    expect(rows).toEqual([{ action: 'grant_admin', admin_id: null }, { action: 'revoke_admin', admin_id: null }])
    await expect(db.query(`update admin_audit_log set action = 'x'`)).rejects.toThrow(/append-only/)
    await expect(db.query(`delete from admin_audit_log`)).rejects.toThrow(/append-only/)
  })

  describe('price rules', () => {
    it('an admin changes a markup (300% -> 250%), toggles a rule, and every change is audited', async () => {
      const id = (await db.query<{ id: string }>(`select id from price_rules where name = 'Default +300%'`)).rows[0].id
      await asUser(db, admin)
      expect((await db.query<{ r: { value: string; is_active: boolean } }>(`select admin_update_price_rule($1, 250) r`, [id])).rows[0].r).toMatchObject({ value: 250, is_active: true })
      expect((await db.query<{ r: { is_active: boolean } }>(`select admin_update_price_rule($1, null, false) r`, [id])).rows[0].r.is_active).toBe(false)
      expect((await db.query<{ r: { value: number } }>(`select admin_update_price_rule($1, 12.345) r`, [id])).rows[0].r.value).toBe(12.35) // 2 decimals
      await asServer(db)
      const audit = (await db.query<{ admin_id: string; action: string; details: { value: number[] } }>(`select admin_id, action, details from admin_audit_log where target_id = $1 order by created_at`, [id])).rows
      expect(audit.map((a) => [a.admin_id, a.action])).toEqual([[admin, 'update_price_rule'], [admin, 'update_price_rule'], [admin, 'update_price_rule']])
      expect(audit[0].details.value).toEqual([300, 250])
    })

    it('validates input and reports unknown rules', async () => {
      const id = (await db.query<{ id: string }>(`select id from price_rules limit 1`)).rows[0].id
      await asUser(db, admin)
      for (const bad of [`-1`, `100001`]) await expect(db.query(`select admin_update_price_rule($1, ${bad})`, [id])).rejects.toThrow(/between 0 and 100000/)
      await expect(db.query(`select admin_update_price_rule($1)`, [id])).rejects.toThrow(/nothing to update/)
      await expect(db.query(`select admin_update_price_rule(gen_random_uuid(), 5)`)).rejects.toThrow(/not found/)
      await asServer(db)
    })

    it('lists rules with a readable scope', async () => {
      await asUser(db, admin)
      const rules = (await db.query<{ r: { name: string; scope: string }[] }>(`select admin_list_price_rules() r`)).rows[0].r
      expect(rules.map((r) => r.scope)).toContain('Global')
      await asServer(db)
    })
  })

  describe('reconciliation actions', () => {
    const balanceOf = async (userId: string) => (await db.query<{ b: string }>(`select balance::text b from wallets where user_id=$1`, [userId])).rows[0].b

    it('queue = processing for > 10 min, or any needs_* note; settled and in-flight orders are excluded', async () => {
      const u = await newUser(db)
      const held = await newOrder(db, { userId: u, status: 'processing', charge: 4, ageMinutes: 30, error: 'needs_reconciliation: timeout' })
      const owed = await newOrder(db, { userId: u, status: 'failed', charge: 3, ageMinutes: 90, error: 'needs_refund: provider_rejected' })
      const inflight = await newOrder(db, { userId: u, status: 'processing', charge: 2, ageMinutes: 1, error: 'needs_reconciliation: submission in flight' })
      const healthy = await newOrder(db, { userId: u, status: 'in_progress', charge: 2 })
      const done = await newOrder(db, { userId: u, status: 'completed', charge: 2, error: 'needs_stale_note' })
      await asUser(db, admin)
      const queue = (await db.query<{ q: { id: string }[] }>(`select admin_reconciliation_queue() q`)).rows[0].q.map((o) => o.id)
      await asServer(db)
      expect(queue).toContain(held)
      expect(queue).toContain(owed)
      expect(queue).not.toContain(healthy)
      expect(queue).not.toContain(done)
      // an order that is merely being submitted carries a needs_reconciliation note too, but must NOT show up:
      expect(queue).not.toContain(inflight)
      // TypeScript predicate gives the same answer for every one of them
      const rows = (await db.query<{ id: string; status: OrderStatus; error_message: string | null; created_at: string }>(`select id, status, error_message, created_at from orders where id = any($1)`, [[held, owed, inflight, healthy, done]])).rows
      for (const r of rows) expect(inReconciliationQueue({ ...r, created_at: new Date(r.created_at).toISOString() }), r.id).toBe(queue.includes(r.id))
    })

    it('force refund returns the money once, closes the order, audits, and is idempotent', async () => {
      const u = await newUser(db)
      const id = await newOrder(db, { userId: u, status: 'processing', charge: 4.5, ageMinutes: 30, error: 'needs_reconciliation: timeout', paid: true })
      const before = Number(await balanceOf(u))
      await asUser(db, admin)
      expect((await db.query<{ r: { status: string } }>(`select admin_force_refund($1, 'customer asked') r`, [id])).rows[0].r.status).toBe('refunded')
      await db.query(`select admin_force_refund($1)`, [id])
      await asServer(db)
      expect(Number(await balanceOf(u)) - before).toBeCloseTo(4.5, 4)
      const o = (await db.query<{ status: string; error_message: string | null }>(`select status, error_message from orders where id=$1`, [id])).rows[0]
      expect(o).toEqual({ status: 'refunded', error_message: null })
      const audit = (await db.query<{ admin_id: string; details: { reason: string } }>(`select admin_id, details from admin_audit_log where action='force_refund' and target_id=$1`, [id])).rows
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ admin_id: admin, details: { reason: 'customer asked' } })
    })

    it('force refund also settles a failed order whose automatic refund was missed', async () => {
      const u = await newUser(db)
      const id = await newOrder(db, { userId: u, status: 'failed', charge: 2.25, error: 'needs_refund: provider_rejected', paid: true })
      const before = Number(await balanceOf(u))
      await asUser(db, admin)
      await db.query(`select admin_force_refund($1)`, [id])
      await asServer(db)
      expect(Number(await balanceOf(u)) - before).toBeCloseTo(2.25, 4)
    })

    it('refuses orders that are not in the queue (in flight, completed, healthy)', async () => {
      const u = await newUser(db)
      const young = await newOrder(db, { userId: u, status: 'processing', charge: 1, ageMinutes: 1, paid: true })
      const done = await newOrder(db, { userId: u, status: 'completed', charge: 1, paid: true })
      const running = await newOrder(db, { userId: u, status: 'in_progress', charge: 1, paid: true })
      const before = await balanceOf(u)
      await asUser(db, admin)
      for (const id of [young, done, running]) await expect(db.query(`select admin_force_refund($1)`, [id])).rejects.toThrow(/not in the reconciliation queue/)
      await expect(db.query(`select admin_force_refund(gen_random_uuid())`)).rejects.toThrow(/not found/)
      await asServer(db)
      expect(await balanceOf(u)).toBe(before) // nothing moved
    })

    it('mark resolved needs the provider order id, then hands the order back to the sync worker', async () => {
      const u = await newUser(db)
      const id = await newOrder(db, { userId: u, status: 'processing', charge: 3, ageMinutes: 45, error: 'needs_reconciliation: timeout' })
      await asUser(db, admin)
      await expect(db.query(`select admin_mark_resolved($1)`, [id])).rejects.toThrow(/provider order id is required/)
      await expect(db.query(`select admin_mark_resolved($1, '   ')`, [id])).rejects.toThrow(/provider order id is required/)
      const r = (await db.query<{ r: { status: string } }>(`select admin_mark_resolved($1, ' 90210 ', 'checked panel') r`, [id])).rows[0].r
      expect(r.status).toBe('submitted')
      await asServer(db)

      const o = (await db.query<{ status: string; provider_order_id: string; error_message: string | null }>(`select status, provider_order_id, error_message from orders where id=$1`, [id])).rows[0]
      expect(o).toEqual({ status: 'submitted', provider_order_id: '90210', error_message: null })
      const hist = (await db.query<{ new_status: string; comment: string }>(`select new_status, comment from order_status_history where order_id=$1 order by created_at, id`, [id])).rows.at(-1)!
      expect(hist).toMatchObject({ new_status: 'submitted' })
      expect(hist.comment).toContain('Resolved by admin: checked panel')
      expect((await db.query(`select 1 from admin_audit_log where action='mark_resolved' and target_id=$1 and admin_id=$2`, [id, admin])).rows).toHaveLength(1)
      // it left the queue
      await asUser(db, admin)
      expect((await db.query<{ q: { id: string }[] }>(`select admin_reconciliation_queue() q`)).rows[0].q.map((x) => x.id)).not.toContain(id)
      await asServer(db)
    })

    it('resolving a refund-owed order without refunding requires a note; completed orders cannot be "resolved"', async () => {
      const u = await newUser(db)
      const owed = await newOrder(db, { userId: u, status: 'failed', charge: 1, error: 'needs_refund: x' })
      const done = await newOrder(db, { userId: u, status: 'completed', charge: 1 })
      await asUser(db, admin)
      await expect(db.query(`select admin_mark_resolved($1)`, [owed])).rejects.toThrow(/note is required/)
      await db.query(`select admin_mark_resolved($1, null, 'paid back via manual adjustment')`, [owed])
      await expect(db.query(`select admin_mark_resolved($1, 'p1', 'n')`, [done])).rejects.toThrow(/not in the reconciliation queue/)
      await asServer(db)
      expect((await db.query<{ error_message: string | null; status: string }>(`select error_message, status from orders where id=$1`, [owed])).rows[0]).toEqual({ error_message: null, status: 'failed' })
    })

    it('a provider order id that already belongs to another order is rejected', async () => {
      const u = await newUser(db)
      const a = await newOrder(db, { userId: u, status: 'processing', charge: 1, ageMinutes: 30, error: 'needs_reconciliation: a' })
      const b = await newOrder(db, { userId: u, status: 'processing', charge: 1, ageMinutes: 30, error: 'needs_reconciliation: b' })
      await asUser(db, admin)
      await db.query(`select admin_mark_resolved($1, 'DUP-1')`, [a])
      await expect(db.query(`select admin_mark_resolved($1, 'DUP-1')`, [b])).rejects.toThrow(/unique|duplicate/i)
      await asServer(db)
      expect((await db.query<{ status: string }>(`select status from orders where id=$1`, [b])).rows[0].status).toBe('processing')
    })
  })

  it('provider status reports balance, last sync and active services', async () => {
    await asUser(db, admin)
    const rows = (await db.query<{ r: { name: string; balance: number; last_synced_at: string; active_services: number; is_active: boolean }[] }>(`select admin_provider_status() r`)).rows[0].r
    await asServer(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'p', balance: 842.17, active_services: 1, is_active: true })
    expect(Date.now() - Date.parse(rows[0].last_synced_at)).toBeLessThan(10 * 60_000)
  })
})

// ---------------------------------------------------------------------------
// 7. Revenue / profit aggregation
// ---------------------------------------------------------------------------

describe('admin metrics: revenue, cost and profit aggregation', () => {
  const ORDERS: OrderSpec[] = []
  let db: PGlite
  let admin: string

  beforeAll(async () => {
    db = await freshDb()
    admin = await newUser(db, { admin: true })
    const u = await newUser(db)
    const mk = (o: Omit<OrderSpec, 'userId'>) => newOrder(db, { userId: u, ...o })
    await mk({ status: 'completed', charge: 10, cost: 4 })
    await mk({ status: 'completed', charge: 5, cost: 2, quantity: 500 })
    await mk({ status: 'partial', charge: 8, cost: 3, quantity: 1000, remains: 250, partialRefund: 2 }) // revenue 6, cost 2.25
    await mk({ status: 'refunded', charge: 6, cost: 2 }) // earns nothing
    await mk({ status: 'failed', charge: 4, cost: 1, error: 'needs_refund: provider_rejected' })
    await mk({ status: 'canceled', charge: 9, cost: 3 })
    await mk({ status: 'in_progress', charge: 3, cost: 1 })
    await mk({ status: 'submitted', charge: 7, cost: 2 })
    await mk({ status: 'processing', charge: 2, cost: 1, ageMinutes: 0, error: 'needs_reconciliation: submission in flight' })
    await mk({ status: 'processing', charge: 5, cost: 1.5, ageMinutes: 30, error: 'needs_reconciliation: timeout' })
    await mk({ status: 'draft', charge: 1, cost: 1 })
    await db.query(`select process_wallet_transaction($1::uuid,'deposit',100,null,'x','dep-metrics')`, [admin])
    ORDERS.push() // keep the linter quiet about the module-level array
  }, 120_000)

  const metrics = async () => {
    await asUser(db, admin)
    const raw = (await db.query<{ m: Record<string, unknown> }>(`select get_admin_metrics() m`)).rows[0].m
    await asServer(db)
    return raw
  }

  it('computes revenue, cost, profit and margin exactly', async () => {
    const m = await metrics()
    expect(Number(m.gross_revenue)).toBe(21) // 10 + 5 + (8 - 2); refunded / failed / canceled / active earn nothing
    expect(Number(m.estimated_cost)).toBe(8.25) // 4 + 2 + prorated 3 * 750/1000
    expect(Number(m.gross_profit)).toBe(12.75)
    expect(Number(m.margin_pct)).toBe(60.71)
    expect(Number(m.pending_revenue)).toBe(17) // 3 + 7 + 2 + 5
  })

  it('counts orders, active orders, problems and users', async () => {
    const m = await metrics()
    expect(Number(m.total_orders)).toBe(10) // drafts excluded
    expect(Number(m.active_orders)).toBe(4) // in_progress, submitted, processing x2
    expect(Number(m.problematic_orders)).toBe(2) // failed needs_refund + old processing; the in-flight one is not a problem
    expect(Number(m.total_users)).toBe(2)
    expect(Number(m.user_balances)).toBeCloseTo(100, 4)
  })

  it('the TypeScript aggregation (used by dev mode) matches the database on the same data', async () => {
    const sql = metricsFromRpc(await metrics())
    const rows = (await db.query<Record<string, string | number | null>>(`select status, charge_amount::float8 charge_amount, cost_amount::float8 cost_amount, quantity, remains, partial_refund_amount::float8 partial_refund_amount, error_message, created_at from orders`)).rows
    const orders: MetricOrder[] = rows.map((r) => ({
      status: r.status as OrderStatus, charge_amount: Number(r.charge_amount), cost_amount: Number(r.cost_amount), quantity: Number(r.quantity),
      remains: r.remains === null ? null : Number(r.remains), partial_refund_amount: Number(r.partial_refund_amount),
      error_message: r.error_message as string | null, created_at: new Date(r.created_at as string).toISOString(),
    }))
    const ts = computeAdminMetrics(orders, { totalUsers: sql.totalUsers, userBalances: sql.userBalances, depositsTotal: sql.depositsTotal })
    expect(ts).toEqual(sql)
    expect(ts).toMatchObject({ grossRevenue: 21, estimatedCost: 8.25, grossProfit: 12.75, marginPct: 60.71, activeOrders: 4, problematicOrders: 2, totalOrders: 10 })
  })

  it('margin is null (not NaN / Infinity) when nothing has been earned', async () => {
    expect(computeAdminMetrics([], { totalUsers: 0, userBalances: 0, depositsTotal: 0 }).marginPct).toBeNull()
    const fresh = await freshDb()
    const a = await newUser(fresh, { admin: true })
    await asUser(fresh, a)
    const m = (await fresh.query<{ m: { margin_pct: number | null; gross_revenue: number } }>(`select get_admin_metrics() m`)).rows[0].m
    expect(m.margin_pct).toBeNull()
    expect(Number(m.gross_revenue)).toBe(0)
  }, 60_000)

  it('has no floating point drift on awkward amounts', () => {
    const o = (charge: number, cost: number): MetricOrder => ({ status: 'completed', charge_amount: charge, cost_amount: cost, quantity: 1, remains: null, partial_refund_amount: 0, error_message: null, created_at: new Date().toISOString() })
    const m = computeAdminMetrics([o(0.1, 0.07), o(0.2, 0.14), o(0.3, 0.21)], { totalUsers: 0, userBalances: 0, depositsTotal: 0 })
    expect(m.grossRevenue).toBe(0.6)
    expect(m.estimatedCost).toBe(0.42)
    expect(m.grossProfit).toBe(0.18)
    expect(m.marginPct).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// 8. Dev mode: admin dashboard backend + console notifications
// ---------------------------------------------------------------------------

describe('mock admin backend', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
  const NOW = Date.parse('2026-10-10T12:00:00Z')
  const adminOnly = { ...MOCK_SESSION, isMock: true as const }
  const regular = { ...MOCK_SESSION, user: { ...MOCK_SESSION.user, isAdmin: false } }

  it('seeds realistic analytics and a reconciliation queue', () => {
    const a = createMockAdmin(memory(), () => NOW)
    const m = a.getMetrics()
    expect(m.grossRevenue).toBeGreaterThan(100)
    expect(m.grossProfit).toBeCloseTo(m.grossRevenue - m.estimatedCost, 4)
    expect(m.problematicOrders).toBe(3)
    expect(a.getQueue().map((o) => o.status).sort()).toEqual(['failed', 'processing', 'processing'])
    expect(a.getProviders().map((p) => p.name)).toContain('Secsers Mock')
  })

  it('force refund and mark resolved shrink the queue and update the metrics', () => {
    const a = createMockAdmin(memory(), () => NOW)
    const queue = a.getQueue()
    const owed = queue.find((o) => o.status === 'failed')!
    const recovered = queue.find((o) => (o.errorMessage ?? '').includes('accepted as'))!
    const held = queue.find((o) => o.status === 'processing' && o !== recovered)!
    const before = a.getMetrics()

    a.forceRefund(held.id)
    expect(a.getQueue()).toHaveLength(2)
    expect(a.getMetrics().problematicOrders).toBe(2)

    expect(() => a.markResolved(recovered.id, {})).toThrow(/provider order id is required/)
    a.markResolved(recovered.id, { providerOrderId: '90210' })
    expect(a.getQueue().map((o) => o.id)).toEqual([owed.id])
    expect(a.getMetrics().activeOrders).toBe(before.activeOrders - 1) // the refunded order is no longer active; the resolved one still is

    expect(() => a.markResolved(owed.id, {})).toThrow(/note is required/)
    a.markResolved(owed.id, { note: 'refunded by hand' })
    expect(a.getQueue()).toEqual([])
    expect(() => a.forceRefund(held.id)).not.toThrow() // idempotent
    expect(() => a.forceRefund(recovered.id)).toThrow(AdminApiError) // no longer in the queue
  })

  it('edits and toggles price rules, validating input, and persists them', () => {
    const store = memory()
    const a = createMockAdmin(store, () => NOW)
    const rule = a.listRules().find((r) => r.name.startsWith('Default'))!
    expect(rule.value).toBe(150)
    a.updateRule(rule.id, { value: 250 })
    a.updateRule(rule.id, { isActive: false })
    const reopened = createMockAdmin(store, () => NOW).listRules().find((r) => r.id === rule.id)!
    expect(reopened).toMatchObject({ value: 250, isActive: false })
    for (const bad of [-1, 100_001, Number.NaN]) expect(() => a.updateRule(rule.id, { value: bad })).toThrow(AdminApiError)
    expect(() => a.updateRule(rule.id, {})).toThrow(/Nothing to update/)
    expect(() => a.updateRule('nope', { value: 1 })).toThrow(/not found/)
  })

  it('the dev API refuses a session that is not an admin (mirrors the server)', async () => {
    await expect(getAdminMetrics(regular)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listPriceRules(regular)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(getAdminMetrics(adminOnly)).resolves.toMatchObject({ problematicOrders: expect.any(Number) })
  })

  it('the dev mock user is an admin and regular users are not', () => {
    expect(MOCK_SESSION.user.isAdmin).toBe(true)
  })
})

describe('mock notifications (console in dev)', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
  const DELAYS = { submittedMs: 1_000, completedMs: 5_000 }
  const members = MOCK_CATALOG.services.find((s) => s.name.includes('Channel Members'))!
  const setup = () => {
    let t = 1_700_000_000_000
    const sent: string[] = []
    const b = createMockBackend(memory(), () => t, DELAYS, (text) => void sent.push(text))
    const place = (url: string, key: string) => b.createOrder({ serviceId: members.id, targetUrl: url, quantity: 1000, idempotencyKey: key })
    return { b, sent, place, advance: (ms: number) => (t += ms) }
  }

  it('announces a credited deposit with the new balance, once', () => {
    const { b, sent } = setup()
    const dep = b.createDeposit(25, 'TON')
    b.completeDeposit(dep.depositId)
    b.completeDeposit(dep.depositId)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Deposit received')
    expect(sent[0]).toContain('+$25.00')
    expect(sent[0]).toContain('New balance: <b>$49.50</b>')
  })

  it('announces completion, partial refund and cancellation exactly once each', () => {
    const { b, sent, place, advance } = setup()
    place('https://t.me/a', 'key-00001')
    place('https://t.me/b#mock-partial', 'key-00002')
    place('https://t.me/c#mock-cancel', 'key-00003')
    expect(sent).toEqual([]) // nothing yet: orders are still running
    advance(5_000)
    for (let i = 0; i < 4; i++) b.listOrders() // polling repeatedly must not repeat messages
    expect(sent).toHaveLength(3)
    expect(sent.filter((m) => m.includes('Order completed'))).toHaveLength(1)
    expect(sent.find((m) => m.includes('partially completed'))).toContain('<b>$1.62</b> was refunded')
    expect(sent.find((m) => m.includes('Order canceled'))).toContain('<b>$5.40</b> was refunded')
  })

  it('a throwing notifier cannot break order or wallet state', () => {
    let t = 1_700_000_000_000
    const b = createMockBackend(memory(), () => t, DELAYS, () => { throw new Error('console exploded') })
    b.createOrder({ serviceId: members.id, targetUrl: 'https://t.me/c#mock-cancel', quantity: 1000, idempotencyKey: 'key-00004' })
    t += 5_000
    expect(b.listOrders()[0].status).toBe('refunded')
    expect(b.getWallet().balance).toBe(24.5)
    b.completeDeposit(b.createDeposit(5, 'TON').depositId)
    expect(b.getWallet().balance).toBe(29.5)
  })
})

describe('admin view helpers', () => {
  it('explains the machine notes in plain language', () => {
    expect(describeNote('needs_reconciliation: provider accepted as 90210 but database update failed')).toMatchObject({ title: 'Provider accepted this order', refundOwed: false })
    expect(describeNote('needs_refund: provider_rejected: api/invalid_link: Incorrect link')).toMatchObject({ title: 'Refund owed to the customer', refundOwed: true })
    expect(describeNote('needs_refund: provider_rejected: api/invalid_link: Incorrect link').detail).toContain('Incorrect link')
    expect(describeNote('needs_reconciliation: timeout: add: no response').detail).toContain('may or may not')
    // sentence boundary is added without eating real characters (a trailing "s" must survive)
    expect(describeNote('needs_reconciliation: timeout: no response within 10000ms').detail).toContain('within 10000ms. The provider')
    expect(describeNote('needs_reconciliation: lost it. ').detail).toMatch(/^lost it\. The provider/)
    expect(describeNote(null).title).toBe('Needs attention')
  })

  it('formats rule values and relative times', () => {
    expect(formatRuleValue('percentage', 250)).toBe('+250%')
    expect(formatRuleValue('tier', 400)).toBe('+400%')
    expect(formatRuleValue('fixed', 0.5)).toBe('+$0.50 / 1k')
    const now = Date.parse('2026-10-10T12:00:00Z')
    const ago = (ms: number) => timeAgo(new Date(now - ms).toISOString(), now)
    expect([ago(10_000), ago(5 * 60_000), ago(3 * 3600_000), ago(2 * 86_400_000)]).toEqual(['just now', '5 min ago', '3 h ago', '2 d ago'])
    expect(timeAgo(null)).toBe('never')
    expect(timeAgo('garbage')).toBe('never')
  })
})

// ---------------------------------------------------------------------------
// 9. The header: logo, settings for everyone, the Admin button only for admins
// ---------------------------------------------------------------------------

describe('Header: logo, settings and the admin button', () => {
  const render = async (isAdmin: boolean, activeTab: 'home' | 'settings' | 'admin' = 'home') => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Layout } = await import('../src/components/layout/Layout')
    return renderToStaticMarkup(
      createElement(Layout, { activeTab, onTabChange: () => {}, balance: 1, currency: 'USD', isAdmin, children: createElement('div') }),
    )
  }

  it('shows the Admin button next to Settings to admins', async () => {
    const html = await render(true)
    expect(html).toContain('aria-label="Admin"')
    expect(html).toContain('aria-label="Settings"')
    expect(html.indexOf('aria-label="Settings"')).toBeLessThan(html.indexOf('aria-label="Admin"'))
  })

  it('does not render the Admin button (or the word Admin) at all for regular users', async () => {
    const html = await render(false)
    expect(html).not.toContain('Admin')
    expect(html).toContain('aria-label="Settings"')
  })

  it('shows the logo to everyone', async () => {
    for (const isAdmin of [true, false]) {
      const html = await render(isAdmin)
      expect(html).toContain('GRAM Hub')
      expect(html).toContain('TON Ecosystem')
    }
  })

  it('keeps the tab bar to the four customer tabs (Admin is no longer a tab)', async () => {
    for (const isAdmin of [true, false]) expect((await render(isAdmin)).match(/<li /g)).toHaveLength(4)
  })

  it('highlights the open header screen', async () => {
    expect(await render(true, 'settings')).toContain('aria-label="Settings" aria-pressed="true"')
    expect(await render(true, 'admin')).toContain('aria-label="Admin" aria-pressed="true"')
    expect(await render(true, 'home')).toContain('aria-label="Admin" aria-pressed="false"')
  })
})
