import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { CLIENT_EVENTS, MAX_EVENTS_PER_REQUEST, cleanBatch, cleanEvent, createRateLimiter } from '../supabase/functions/_shared/analytics.ts'

const UUID = '3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12'

describe('client event sanitising (privacy by construction)', () => {
  it('keeps a known event and its allow-listed, well-shaped properties', () => {
    expect(cleanEvent({ name: 'checkout_started', properties: { service_id: UUID.toUpperCase(), quantity: 1000, has_promo: true } }))
      .toEqual({ name: 'checkout_started', properties: { service_id: UUID, quantity: 1000, has_promo: true } })
    expect(cleanEvent({ event: 'catalog_view', properties: { platform: 'telegram' } })).toEqual({ name: 'catalog_view', properties: { platform: 'telegram' } })
    expect(cleanEvent({ name: 'deposit_started', properties: { asset: 'TON', amount_usd: 12.345678 } })).toEqual({ name: 'deposit_started', properties: { asset: 'TON', amount_usd: 12.3457 } })
    expect(cleanEvent({ name: 'orders_view' })).toEqual({ name: 'orders_view', properties: {} })
  })

  it('drops every property that is not on the list: links, handles, e-mails, IPs, tokens never get in', () => {
    const e = cleanEvent({
      name: 'checkout_started',
      properties: {
        service_id: UUID, quantity: 500,
        link: 'https://t.me/my_private_channel', target_url: 'https://instagram.com/someone', username: '@someone', email: 'a@b.co',
        ip: '203.0.113.7', ip_address: '2001:db8::1', token: 'eyJhbGciOi', promo_code: 'SUMMER10', initData: 'hash=abc', note: 'call me +380501234567',
      },
    })
    expect(e).toEqual({ name: 'checkout_started', properties: { service_id: UUID, quantity: 500 } })
    const text = JSON.stringify(e)
    for (const secret of ['t.me', 'instagram', '@', '203.0.113', '2001:db8', 'eyJ', 'SUMMER10', 'hash=', '+380']) expect(text).not.toContain(secret)
  })

  it('drops a listed property whose VALUE has the wrong shape: PII hidden in an allowed field is still refused', () => {
    const e = cleanEvent({
      name: 'catalog_view',
      properties: { platform: 'https://t.me/secret', category_id: 'not-a-uuid' },
    })
    expect(e).toEqual({ name: 'catalog_view', properties: {} })
    expect(cleanEvent({ name: 'catalog_view', properties: { platform: 'a@b.co' } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'catalog_view', properties: { platform: '203.0.113.7' } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'catalog_view', properties: { platform: 'x'.repeat(41) } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'checkout_started', properties: { quantity: -5, has_promo: 'yes', service_id: 7 } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'checkout_started', properties: { quantity: 1.5 } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'checkout_started', properties: { quantity: 2 ** 53 } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'deposit_started', properties: { asset: 'BTC', amount_usd: Number.NaN } })?.properties).toEqual({})
    expect(cleanEvent({ name: 'deposit_started', properties: { amount_usd: Infinity } })?.properties).toEqual({})
  })

  it('refuses unknown events and the money / account events a client could use to fake the numbers', () => {
    for (const name of ['user_registered', 'first_deposit', 'order_placed', 'order_refunded', 'promo_applied', 'made_up', '', 'toString', '__proto__', 'constructor']) {
      expect(cleanEvent({ name, properties: { order_id: UUID } })).toBeNull()
    }
    for (const server of ['user_registered', 'first_deposit', 'order_placed', 'order_refunded', 'promo_applied']) expect(Object.keys(CLIENT_EVENTS)).not.toContain(server)
  })

  it('malformed input never throws and stores nothing', () => {
    for (const bad of [null, undefined, 5, 'x', true, [], [1, 2], {}, { name: 5 }, { name: ['catalog_view'] }, { events: 'nope' }, { events: [null, 1, 'x', []] },
      { name: 'catalog_view', properties: 'x' }, { name: 'catalog_view', properties: [1] }, { name: 'catalog_view', properties: null }]) {
      expect(() => cleanBatch(bad)).not.toThrow()
    }
    expect(cleanBatch(null).events).toEqual([])
    expect(cleanBatch({ events: [null, 1, 'x', []] }).events).toEqual([])
    expect(cleanBatch({ name: 'catalog_view', properties: 'x' }).events).toEqual([{ name: 'catalog_view', properties: {} }])
  })

  it('prototype pollution attempts change nothing', () => {
    const body = JSON.parse('{"name":"catalog_view","properties":{"__proto__":{"polluted":true},"constructor":{"x":1},"platform":"telegram"}}')
    expect(cleanEvent(body)).toEqual({ name: 'catalog_view', properties: { platform: 'telegram' } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('a batch is capped; one event and a list both work; the dropped ones are counted', () => {
    const many = Array.from({ length: 500 }, () => ({ name: 'orders_view' }))
    expect(cleanBatch({ events: many }).events).toHaveLength(MAX_EVENTS_PER_REQUEST)
    const mixed = cleanBatch({ events: [{ name: 'orders_view' }, { name: 'order_placed' }, 7] })
    expect(mixed.events).toHaveLength(1)
    expect(mixed.dropped).toBe(2)
    expect(cleanBatch({ name: 'wallet_view' }).events).toEqual([{ name: 'wallet_view', properties: {} }])
  })

  it('the track-event function reads no address and no client clock (source check), and answers before the insert finishes', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/track-event/index.ts'), 'utf8')
    expect(src).not.toMatch(/x-forwarded-for|cf-connecting-ip|x-real-ip|remote_addr|user-agent/i)
    expect(src).toMatch(/EdgeRuntime\.waitUntil\(write\)/)
    // the insert is started but the response does not await it
    expect(src).not.toMatch(/await\s+write/)
  })
})

describe('rate limiter', () => {
  it('lets `limit` through per window per key, then refuses, then recovers', () => {
    let t = 0
    const allow = createRateLimiter(3, 1000, () => t)
    expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false])
    expect(allow('b')).toBe(true) // another user is unaffected
    t = 1001
    expect(allow('a')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('analytics in the database', () => {
  let db: PGlite
  let admin: string
  let svc: string, svc2: string
  let n = 0
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const num = (v: unknown) => Number(v)
  const newUser = async (opts: { funds?: number; admin?: boolean } = {}) => {
    const id = await one<string>(`insert into users(telegram_id, is_admin) values ($1, $2) returning id v`, [8000 + ++n, opts.admin ?? false])
    if (opts.funds) await db.query(`select process_wallet_transaction($1::uuid, 'deposit', $2::numeric, null, 'fund', $3)`, [id, opts.funds, `fund-${id}`])
    return id
  }
  const events = (user: string, name?: string) =>
    rows(`select event_name n, source s, properties p from analytics_events where user_id = $1 ${name ? 'and event_name = $2' : ''} order by created_at, id`, name ? [user, name] : [user])
  const call = async (sql: string, p: unknown[] = []) => (await db.query<{ r: any }>(`select ${sql} r`, p)).rows[0].r
  const order = async (user: string, o: { service?: string; qty?: number; promo?: string | null } = {}) => {
    const service = o.service ?? svc
    const offer = (await rows(`select id, provider_id, provider_service_id, cost_per_1000 from provider_service_offers where service_id = $1`, [service]))[0]
    const qty = o.qty ?? 1000
    return one<string>(
      `select id v from place_order($1::uuid, $2::uuid, 'https://t.me/very_private_channel', $3::int, $4::uuid, $5::uuid, $6::uuid, round($7::numeric * $3::int / 1000, 4), $8, $9)`,
      [user, service, qty, offer.id, offer.provider_id, offer.provider_service_id, offer.cost_per_1000, `k-${++n}`, o.promo ?? null])
  }
  const finish = async (id: string, to: 'completed' | 'partial' | 'refunded') => {
    await db.query(`update orders set status = 'processing' where id = $1`, [id])
    await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [id, `P${++n}`])
    if (to === 'completed') await db.query(`update orders set status = 'completed' where id = $1`, [id])
    if (to === 'partial') await db.query(`select apply_partial_refund($1::uuid, 400, 1)`, [id])
    if (to === 'refunded') {
      await db.query(`update orders set status = 'canceled' where id = $1`, [id])
      await db.query(`select refund_order($1::uuid, null, 'x')`, [id])
    }
  }
  const at = (id: string, ts: string) => db.query(`update orders set created_at = $2 where id = $1`, [id, ts])
  const ev = (user: string, name: string, ts: string, source = 'client') =>
    db.query(`insert into analytics_events(user_id, event_name, source, created_at) values ($1, $2, $3, $4)`, [user, name, source, ts])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin = await newUser({ admin: true })
    const provider = await one<string>(`insert into providers(name, api_url) values ('P', 'https://p.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const mk = async (name: string, ext: string, cost: number, price: number) => {
      const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000000) returning id v`, [provider, ext, name, cost])
      return one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, $2, $3, $4, 1, 1000000) returning id v`, [cat, name, ps, price])
    }
    svc = await mk('Views', '1', 2, 4)
    svc2 = await mk('Members', '2', 5, 10)
  }, 180_000)

  describe('access and shape', () => {
    it('closed to clients; every function service-role only; the log is append-only', async () => {
      const g = (await rows(`select has_table_privilege('anon', 'analytics_events', 'select') a, has_table_privilege('authenticated', 'analytics_events', 'select') u, has_table_privilege('authenticated', 'analytics_events', 'insert') w`))[0]
      expect([g.a, g.u, g.w]).toEqual([false, false, false])
      for (const fn of ['record_client_events(uuid, jsonb, integer)', 'bi_funnel(timestamptz, timestamptz)', 'bi_revenue_daily(timestamptz, timestamptz)', 'bi_retention(timestamptz, timestamptz, integer[])', 'bi_top_services(timestamptz, timestamptz, integer)']) {
        const x = (await rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, has_function_privilege('service_role', '${fn}', 'execute') s`))[0]
        expect([x.a, x.u, x.s]).toEqual([false, false, true])
      }
      await expect(db.query(`update analytics_events set event_name = 'x_y'`)).rejects.toThrow(/append-only/)
      await expect(db.query(`delete from analytics_events`)).rejects.toThrow(/append-only/)
      await expect(db.query(`truncate analytics_events`)).rejects.toThrow(/append-only/)
    })

    it('has no foreign key, so a write never locks a core row; names and size are checked', async () => {
      expect(num(await one(`select count(*) v from pg_constraint where conrelid = 'analytics_events'::regclass and contype = 'f'`))).toBe(0)
      await expect(db.query(`insert into analytics_events(event_name, source) values ('Bad Name', 'client')`)).rejects.toThrow()
      await expect(db.query(`insert into analytics_events(event_name, source) values ('ok_name', 'browser')`)).rejects.toThrow()
      await expect(db.query(`insert into analytics_events(event_name, source, properties) values ('ok_name', 'client', $1)`, [JSON.stringify({ x: 'y'.repeat(5000) })])).rejects.toThrow()
    })

    it('has the indexes the time-series queries need', async () => {
      const idx = (await rows(`select indexname from pg_indexes where tablename = 'analytics_events'`)).map((r) => r.indexname)
      expect(idx).toEqual(expect.arrayContaining(['idx_analytics_created_at', 'idx_analytics_name_time', 'idx_analytics_user_time']))
    })
  })

  describe('server-side events', () => {
    it('user_registered on sign-up, once', async () => {
      const u = await newUser()
      expect(await events(u)).toEqual([{ n: 'user_registered', s: 'server', p: {} }])
    })

    it('first_deposit on the first COMPLETED deposit only; a pending one counts when it settles', async () => {
      const u = await newUser()
      await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 5::numeric, null, 'pending', $2, 'pending')`, [u, `pend-${u}`])
      expect(await events(u, 'first_deposit')).toEqual([])
      const tx = await one<string>(`select t.id v from wallet_transactions t join wallets w on w.id = t.wallet_id where w.user_id = $1 and t.status = 'pending'`, [u])
      await db.query(`select settle_wallet_transaction($1::uuid, 'completed')`, [tx])
      expect(await events(u, 'first_deposit')).toEqual([{ n: 'first_deposit', s: 'server', p: { amount: 5 } }])
      await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 7::numeric, null, 'second', $2)`, [u, `second-${u}`])
      expect(await events(u, 'first_deposit')).toHaveLength(1)
    })

    it('order_placed once per order with money facts but never the link; order_refunded on a refund; promo_applied without the code', async () => {
      await db.query(`select admin_upsert_promo_code($1::uuid, 'TRACKME', 'fixed', 0.5)`, [admin])
      const u = await newUser({ funds: 100 })
      const o = await order(u, { promo: 'TRACKME' })
      const placed = await events(u, 'order_placed')
      expect(placed).toHaveLength(1)
      expect(placed[0].p).toMatchObject({ order_id: o, service_id: svc, quantity: 1000, amount: 3.5, promo_discount: 0.5 })
      expect(await events(u, 'promo_applied')).toHaveLength(1)
      await finish(o, 'refunded')
      expect(await events(u, 'order_refunded')).toHaveLength(1)
      const everything = JSON.stringify(await rows(`select properties from analytics_events where user_id = $1`, [u]))
      for (const leak of ['t.me', 'very_private_channel', 'TRACKME', 'https://']) expect(everything).not.toContain(leak)
      // a second status change to the same state, or a replay, adds nothing
      await db.query(`select place_order($1::uuid, $2::uuid, 'https://t.me/very_private_channel', 1000, (select id from provider_service_offers where service_id = $2), (select provider_id from provider_service_offers where service_id = $2), (select provider_service_id from provider_service_offers where service_id = $2), 2::numeric, $3, 'TRACKME')`,
        [u, svc, `k-${n}`]).catch(() => {})
      expect(await events(u, 'order_placed')).toHaveLength(1)
    })

    it('an analytics failure never fails the business transaction', async () => {
      await db.exec(`alter table analytics_events add constraint force_fail check (false) not valid`)
      const u = await newUser({ funds: 50 }) // user insert + first deposit both fire triggers
      const o = await order(u)
      await finish(o, 'completed')
      await db.exec(`alter table analytics_events drop constraint force_fail`)
      expect(await one(`select status::text v from orders where id = $1`, [o])).toBe('completed')
      expect(await one(`select balance::text v from wallets where user_id = $1`, [u])).toBe('46.0000')
      expect(await events(u)).toEqual([])
    })
  })

  describe('client events', () => {
    it('stores clean events as source client', async () => {
      const u = await newUser()
      const stored = await call(`record_client_events($1::uuid, $2::jsonb)`, [u, JSON.stringify([{ name: 'catalog_view', properties: { platform: 'telegram' } }, { name: 'orders_view', properties: {} }])])
      expect(stored).toBe(2)
      expect((await events(u)).filter((e) => e.s === 'client').map((e) => e.n).sort()).toEqual(['catalog_view', 'orders_view'])
    })

    it('the money and account events cannot be forged through it', async () => {
      const u = await newUser()
      const forged = ['user_registered', 'first_deposit', 'order_placed', 'order_refunded', 'promo_applied'].map((name) => ({ name, properties: { order_id: UUID } }))
      expect(await call(`record_client_events($1::uuid, $2::jsonb)`, [u, JSON.stringify(forged)])).toBe(0)
      expect((await events(u)).filter((e) => e.s === 'client')).toEqual([])
    })

    it('malformed batches store nothing and do not raise', async () => {
      const u = await newUser()
      for (const bad of ['{}', '"x"', '5', 'null', '[1,"a",null,[]]', JSON.stringify([{ name: 5 }, { name: 'Bad Name' }, { name: 'x' }, { name: 'ok_name', properties: 'str' }, { name: 'ok_name', properties: [1] }])]) {
        expect(await call(`record_client_events($1::uuid, $2::jsonb)`, [u, bad])).toBe(0)
      }
      expect(await call(`record_client_events(null, '[]'::jsonb)`)).toBe(0)
      expect((await events(u)).filter((e) => e.s === 'client')).toEqual([])
    })

    it('an oversized property is skipped, the rest of the batch still stored', async () => {
      const u = await newUser()
      const batch = [{ name: 'orders_view', properties: { big: 'z'.repeat(5000) } }, { name: 'wallet_view', properties: {} }]
      expect(await call(`record_client_events($1::uuid, $2::jsonb)`, [u, JSON.stringify(batch)])).toBe(1)
    })

    it('a user is limited per minute across requests, and another user is not affected', async () => {
      const a = await newUser(), b = await newUser()
      const batch = JSON.stringify(Array.from({ length: 40 }, () => ({ name: 'orders_view', properties: {} })))
      const stored = []
      for (let i = 0; i < 5; i++) stored.push(await call(`record_client_events($1::uuid, $2::jsonb, 100)`, [a, batch]))
      expect(stored).toEqual([40, 40, 20, 0, 0])
      expect(await call(`record_client_events($1::uuid, $2::jsonb, 100)`, [b, batch])).toBe(40)
    })
  })

  describe('BI: funnel', () => {
    const from = '2026-02-01T00:00:00Z', to = '2026-03-01T00:00:00Z'
    it('counts users that reached each step IN ORDER inside the window, with conversion rates', async () => {
      const [u1, u2, u3, u4, u5] = await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()])
      await ev(u1, 'catalog_view', '2026-02-02T10:00:00Z'); await ev(u1, 'checkout_started', '2026-02-02T10:05:00Z'); await ev(u1, 'order_placed', '2026-02-02T10:09:00Z', 'server')
      await ev(u2, 'catalog_view', '2026-02-03T10:00:00Z'); await ev(u2, 'checkout_started', '2026-02-03T10:02:00Z')
      await ev(u3, 'catalog_view', '2026-02-04T10:00:00Z')
      await ev(u4, 'checkout_started', '2026-02-05T10:00:00Z'); await ev(u4, 'order_placed', '2026-02-05T10:01:00Z', 'server') // never looked at the catalog
      await ev(u5, 'order_placed', '2026-02-06T09:00:00Z', 'server'); await ev(u5, 'catalog_view', '2026-02-06T10:00:00Z') // ordered BEFORE browsing
      await ev(u1, 'catalog_view', '2026-04-01T00:00:00Z') // outside the window
      const f = await call(`bi_funnel($1::timestamptz, $2::timestamptz)`, [from, to])
      expect(f.steps.map((s: any) => [s.step, s.users])).toEqual([['catalog_view', 4], ['checkout_started', 2], ['order_placed', 1]])
      expect(f.steps[1]).toMatchObject({ rate_from_previous: 50, rate_from_first: 50 })
      expect(f.steps[2]).toMatchObject({ rate_from_previous: 50, rate_from_first: 25 })
    })

    it('an empty window gives zeros and no rates, not an error', async () => {
      const f = await call(`bi_funnel('2025-01-01'::timestamptz, '2025-01-08'::timestamptz)`)
      expect(f.steps.map((s: any) => s.users)).toEqual([0, 0, 0])
      expect(f.steps[1].rate_from_previous).toBeNull()
    })

    it('refuses a backwards or a too long range', async () => {
      await expect(call(`bi_funnel('2026-03-01'::timestamptz, '2026-02-01'::timestamptz)`)).rejects.toThrow(/start before its end/)
      await expect(call(`bi_funnel('2024-01-01'::timestamptz, '2026-01-01'::timestamptz)`)).rejects.toThrow(/limited to 366 days/)
      await expect(call(`bi_funnel(null, null)`)).rejects.toThrow()
    })
  })

  describe('BI: revenue, margin and AOV by day', () => {
    it('is net of refunds, proportional on cost, lists empty days, and AOV is revenue per order', async () => {
      const u = await newUser({ funds: 1000 })
      const completed = await order(u); await finish(completed, 'completed')   // 4.00 charge, cost 2.00
      const partial = await order(u); await finish(partial, 'partial')         // 4.00 - 1.60 kept: 2.40, cost 1.20
      const refunded = await order(u); await finish(refunded, 'refunded')      // nothing
      const later = await order(u, { service: svc2, qty: 2000 }); await finish(later, 'completed') // 20.00, cost 10.00
      const pending = await order(u)                                           // paid, in flight: counts
      await at(completed, '2026-05-10T08:00:00Z'); await at(partial, '2026-05-10T20:00:00Z'); await at(refunded, '2026-05-10T21:00:00Z')
      await at(later, '2026-05-12T12:00:00Z'); await at(pending, '2026-05-12T13:00:00Z')

      const days = await call(`bi_revenue_daily('2026-05-09T00:00:00Z'::timestamptz, '2026-05-14T00:00:00Z'::timestamptz)`)
      expect(days.map((d: any) => d.day)).toEqual(['2026-05-09', '2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13'])
      expect(days[0]).toMatchObject({ orders: 0, revenue: 0, margin: 0, aov: null })
      expect(days[1]).toMatchObject({ orders: 2, revenue: 6.4, cost: 3.2, margin: 3.2, aov: 3.2 })
      expect(days[2].orders).toBe(0)
      expect(days[3]).toMatchObject({ orders: 2, revenue: 24, cost: 12, margin: 12, aov: 12 })
      expect(days[4].orders).toBe(0)
    })
  })

  describe('BI: retention by cohort', () => {
    it('day-N retention per signup day; a cohort too young for day N shows null', async () => {
      const mk = async (signup: string) => {
        const id = await newUser()
        await db.query(`update users set created_at = $2 where id = $1`, [id, signup])
        return id
      }
      const [a1, a2, a3, b1] = [await mk('2026-01-10T09:00:00Z'), await mk('2026-01-10T15:00:00Z'), await mk('2026-01-10T20:00:00Z'), await mk('2026-01-11T09:00:00Z')]
      await ev(a1, 'catalog_view', '2026-01-11T12:00:00Z')   // day 1
      await ev(a2, 'orders_view', '2026-01-11T23:00:00Z')    // day 1
      await ev(a1, 'wallet_view', '2026-01-17T12:00:00Z')    // day 7
      await ev(a3, 'wallet_view', '2026-01-13T12:00:00Z')    // day 3: neither
      await ev(b1, 'catalog_view', '2026-01-12T12:00:00Z')   // cohort b, day 1
      const young = await mk(new Date().toISOString())
      void young

      const r = await call(`bi_retention('2026-01-10T00:00:00Z'::timestamptz, '2026-01-12T00:00:00Z'::timestamptz, array[1,7])`)
      expect(r).toHaveLength(2)
      expect(r[0]).toMatchObject({ cohort: '2026-01-10', size: 3 })
      expect(r[0].retention).toEqual([{ day: 1, users: 2, rate: 66.67 }, { day: 7, users: 1, rate: 33.33 }])
      expect(r[1].retention).toEqual([{ day: 1, users: 1, rate: 100 }, { day: 7, users: 0, rate: 0 }])

      const today = new Date().toISOString().slice(0, 10)
      const yr = await call(`bi_retention((now() - interval '1 hour'), (now() + interval '1 hour'), array[1,7])`)
      const cohort = yr.find((c: any) => c.cohort === today)
      expect(cohort.retention).toEqual([{ day: 1, users: null, rate: null }, { day: 7, users: null, rate: null }])
    })

    it('validates the day list', async () => {
      await expect(call(`bi_retention('2026-01-01'::timestamptz, '2026-01-02'::timestamptz, array[0])`)).rejects.toThrow(/days must be/)
      await expect(call(`bi_retention('2026-01-01'::timestamptz, '2026-01-02'::timestamptz, array[91])`)).rejects.toThrow(/days must be/)
      await expect(call(`bi_retention('2026-01-01'::timestamptz, '2026-01-02'::timestamptz, array[]::int[])`)).rejects.toThrow(/days must be/)
    })
  })

  describe('BI: top services', () => {
    it('ranks by net revenue with margin and AOV, honours the limit, ignores refunded orders', async () => {
      const u = await newUser({ funds: 5000 })
      const o1 = await order(u, { qty: 1000 }); await finish(o1, 'completed')                       // Views 4.00
      const o2 = await order(u, { qty: 1000 }); await finish(o2, 'completed')                       // Views 4.00
      const o3 = await order(u, { service: svc2, qty: 3000 }); await finish(o3, 'completed')        // Members 30.00
      const o4 = await order(u, { service: svc2, qty: 1000 }); await finish(o4, 'refunded')         // nothing
      for (const id of [o1, o2, o3, o4]) await at(id, '2026-06-15T10:00:00Z')

      const top = await call(`bi_top_services('2026-06-01T00:00:00Z'::timestamptz, '2026-07-01T00:00:00Z'::timestamptz, 10)`)
      expect(top.map((t: any) => [t.name, t.orders, t.units, t.revenue, t.margin, t.aov])).toEqual([['Members', 1, 3000, 30, 15, 30], ['Views', 2, 2000, 8, 4, 4]])
      expect((await call(`bi_top_services('2026-06-01T00:00:00Z'::timestamptz, '2026-07-01T00:00:00Z'::timestamptz, 1)`))).toHaveLength(1)
      expect(await call(`bi_top_services('2025-01-01'::timestamptz, '2025-02-01'::timestamptz)`)).toEqual([])
    })
  })
})
