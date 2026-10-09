import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { emptySyncStats, providerPollOutcome, syncProviderOrders, type SyncOrder, type SyncPorts } from '../supabase/functions/_shared/order-sync'
import { DEFAULT_LEASE_SECONDS, withWorkerLock, type LockRpc } from '../supabase/functions/_shared/worker-lock'

describe('providerPollOutcome (the circuit breaker\'s input)', () => {
  const s = (ok: number, failed: number) => ({ statusQueriesOk: ok, statusQueryFailures: failed })
  it('answered at all = ok; every query failed = failed; nothing asked = nothing to learn', () => {
    expect(providerPollOutcome(s(1, 0))).toBe('ok')
    expect(providerPollOutcome(s(2, 3))).toBe('ok') // a partial outage is not an outage
    expect(providerPollOutcome(s(0, 1))).toBe('failed')
    expect(providerPollOutcome(s(0, 4))).toBe('failed')
    expect(providerPollOutcome(s(0, 0))).toBeNull()
  })

  it('syncProviderOrders counts its status queries chunk by chunk', async () => {
    const order = (i: number): SyncOrder => ({ id: `o${i}`, user_id: 'u', service_id: 's', provider_order_id: `P${i}`, status: 'submitted', quantity: 100, charge_amount: 1, remains: null, start_count: null, error_message: null, created_at: 't' })
    const ports: SyncPorts = { setProviderOrderId: async () => {}, updateOrder: async () => true, applyPartialRefund: async () => 0, refundOrder: async () => {}, touch: async () => {} }
    const quiet = { error: () => {}, warn: () => {} }
    const orders = Array.from({ length: 120 }, (_, i) => order(i)) // three chunks of 50 / 50 / 20

    const down = await syncProviderOrders(orders, { getOrdersStatus: async () => { throw new Error('502') } }, ports, {}, quiet)
    expect([down.statusQueriesOk, down.statusQueryFailures]).toEqual([0, 3])
    expect(providerPollOutcome(down)).toBe('failed')

    let call = 0
    const flaky = await syncProviderOrders(orders, { getOrdersStatus: async (ids) => { if (++call === 2) throw new Error('timeout'); return Object.fromEntries(ids.map((id) => [id, { ok: false as const, error: 'x', code: 'unknown' as const }])) } }, ports, {}, quiet)
    expect([flaky.statusQueriesOk, flaky.statusQueryFailures]).toEqual([2, 1])
    expect(providerPollOutcome(flaky)).toBe('ok')

    const idle = await syncProviderOrders([], { getOrdersStatus: async () => ({}) }, ports, {}, quiet)
    expect(providerPollOutcome(idle)).toBeNull()
    expect(emptySyncStats()).toMatchObject({ statusQueriesOk: 0, statusQueryFailures: 0 })
  })
})

describe('withWorkerLock (the lease around a worker run)', () => {
  const rpcOf = (impl: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }) => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const rpc: LockRpc = { rpc: async (fn, args) => { calls.push([fn, args]); return impl(fn, args) } }
    return { rpc, calls }
  }

  it('takes the lease, runs the work once, and always gives the lease back', async () => {
    const { rpc, calls } = rpcOf((fn) => ({ data: fn === 'try_acquire_worker_lock' ? 'token-1' : true, error: null }))
    const work = vi.fn(async () => 42)
    expect(await withWorkerLock(rpc, 'sync-order-status', work)).toEqual({ acquired: true, value: 42 })
    expect(work).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([
      ['try_acquire_worker_lock', { p_name: 'sync-order-status', p_ttl_seconds: DEFAULT_LEASE_SECONDS }],
      ['release_worker_lock', { p_name: 'sync-order-status', p_token: 'token-1' }],
    ])
  })

  it('another run holds the lease: the work does not run and nothing is released', async () => {
    const { rpc, calls } = rpcOf(() => ({ data: null, error: null }))
    const work = vi.fn(async () => 1)
    expect(await withWorkerLock(rpc, 'w', work)).toEqual({ acquired: false })
    expect(work).not.toHaveBeenCalled()
    expect(calls.map((c) => c[0])).toEqual(['try_acquire_worker_lock'])
  })

  it('fails closed: if the lock cannot be checked (error, throw) the run is skipped, not run unprotected', async () => {
    const work = vi.fn(async () => 1)
    expect(await withWorkerLock(rpcOf(() => ({ data: null, error: { message: 'db down' } })).rpc, 'w', work)).toEqual({ acquired: false })
    expect(await withWorkerLock({ rpc: async () => { throw new Error('network') } }, 'w', work)).toEqual({ acquired: false })
    expect(work).not.toHaveBeenCalled()
  })

  it('releases even when the work throws, and the error still reaches the caller; a failing release is harmless', async () => {
    const { rpc, calls } = rpcOf((fn) => ({ data: fn === 'try_acquire_worker_lock' ? 'token-2' : true, error: null }))
    await expect(withWorkerLock(rpc, 'w', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(calls.at(-1)).toEqual(['release_worker_lock', { p_name: 'w', p_token: 'token-2' }])
    const flaky: LockRpc = { rpc: async (fn) => { if (fn === 'release_worker_lock') throw new Error('gone'); return { data: 'token-3', error: null } } }
    expect(await withWorkerLock(flaky, 'w', async () => 'done')).toEqual({ acquired: true, value: 'done' })
  })

  it('the Edge Function wraps its whole run in the lease and polls through the SQL work list (source check)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/sync-order-status/index.ts'), 'utf8')
    expect(src).toContain("withWorkerLock(db, 'sync-order-status'")
    expect(src).toContain("db.rpc('get_order_sync_batch'")
    expect(src).toContain("db.rpc('record_provider_sync_result'")
    expect(src).toContain('providerPollOutcome(result)')
    expect(src).not.toMatch(/\.from\('orders'\)\s*\.select/) // the old PostgREST work list is gone
    // pg_try_advisory_lock is deliberately not used: see the header of _shared/worker-lock.ts
    expect(src).not.toMatch(/pg_try_advisory_lock/)
    expect(fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/worker-lock.ts'), 'utf8')).toMatch(/Why not pg_try_advisory_lock/)
  })
})

describe('resilience in the database', () => {
  let db: PGlite
  let svc: string
  let provA: string, provB: string
  let n = 0

  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const call = async (sql: string, p: unknown[] = []) => (await db.query<{ r: any }>(`select ${sql} r`, p)).rows[0].r
  const batch = async (limit = 200) => (await call(`get_order_sync_batch($1)`, [limit])) as Array<Record<string, any>>
  const ids = async (limit?: number) => (await batch(limit)).map((b) => b.id as string)
  const offers: Record<string, { id: string; provider_id: string; provider_service_id: string }> = {}

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    provA = await one<string>(`insert into providers(name, api_url) values ('Panel A', 'https://a.invalid') returning id v`)
    provB = await one<string>(`insert into providers(name, api_url) values ('Panel B', 'https://b.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const psA = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'A', 2, 1, 1000000) returning id v`, [provA])
    const psB = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '2', 'B', 2, 1, 1000000) returning id v`, [provB])
    svc = await one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'Views', $2, 4, 1, 1000000) returning id v`, [cat, psA])
    await db.query(`insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity) values ($1, $2, $3, 2, 1, 1000000)`, [svc, provB, psB])
    for (const [key, prov] of [['A', provA], ['B', provB]] as const) {
      const o = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1 and provider_id = $2`, [svc, prov]))[0]
      offers[key] = { id: o.id as string, provider_id: o.provider_id as string, provider_service_id: o.provider_service_id as string }
    }
  }, 180_000)

  // an order in a given state, created through the real function and walked through valid transitions
  const user = async () => {
    const id = await one<string>(`insert into users(telegram_id) values ($1) returning id v`, [9500 + ++n])
    await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 1000::numeric, null, 'fund', $2)`, [id, `fund-${id}`])
    return id
  }
  const order = async (u: string, provider: 'A' | 'B', state: 'submitted' | 'in_progress' | 'processing_with_id' | 'processing_held' | 'processing_recoverable' | 'canceled_owed' | 'canceled_plain' | 'completed') => {
    const o = offers[provider]
    const id = await one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, $6)`, [u, svc, o.id, o.provider_id, o.provider_service_id, `k-${++n}`])
    await db.query(`update orders set status = 'processing' where id = $1`, [id])
    if (state === 'processing_with_id') await db.query(`update orders set provider_order_id = $2 where id = $1`, [id, `P${n}`])
    else if (state === 'processing_held') await db.query(`update orders set error_message = 'needs_reconciliation: timeout: add: no response within 10000ms' where id = $1`, [id])
    else if (state === 'processing_recoverable') await db.query(`update orders set error_message = 'needs_reconciliation: provider accepted as 777 but database update failed' where id = $1`, [id])
    else {
      await db.query(`update orders set status = 'submitted', provider_order_id = $2 where id = $1`, [id, `P${n}`])
      if (state === 'in_progress') await db.query(`update orders set status = 'in_progress' where id = $1`, [id])
      if (state === 'completed') await db.query(`update orders set status = 'completed' where id = $1`, [id])
      if (state === 'canceled_owed' || state === 'canceled_plain') {
        await db.query(`update orders set status = 'canceled', error_message = $2 where id = $1`, [id, state === 'canceled_owed' ? 'needs_refund: provider canceled order' : null])
      }
    }
    return id
  }

  describe('worker leases', () => {
    it('service role only', async () => {
      for (const fn of ['try_acquire_worker_lock(text, integer)', 'release_worker_lock(text, uuid)', 'record_provider_sync_result(uuid, boolean)', 'get_order_sync_batch(integer)', 'notify_admin_anomalies()']) {
        const g = (await rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, has_function_privilege('service_role', '${fn}', 'execute') s`))[0]
        expect([g.a, g.u, g.s], fn).toEqual([false, false, true])
      }
    })

    it('one holder at a time: a second caller gets nothing until the lease is released', async () => {
      const first = await call(`try_acquire_worker_lock('lease-a', 60)`)
      expect(first).toMatch(/^[0-9a-f-]{36}$/)
      expect(await call(`try_acquire_worker_lock('lease-a', 60)`)).toBeNull()
      expect(await call(`try_acquire_worker_lock('lease-b', 60)`)).toMatch(/^[0-9a-f-]{36}$/) // another worker is independent
      expect(await call(`release_worker_lock('lease-a', $1::uuid)`, [first])).toBe(true)
      expect(await call(`try_acquire_worker_lock('lease-a', 60)`)).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('only the holder can release: a stale token frees nothing', async () => {
      const mine = await call(`try_acquire_worker_lock('lease-c', 60)`)
      expect(await call(`release_worker_lock('lease-c', '00000000-0000-4000-8000-000000000001'::uuid)`)).toBe(false)
      expect(await call(`try_acquire_worker_lock('lease-c', 60)`)).toBeNull() // still held
      expect(await call(`release_worker_lock('lease-c', $1::uuid)`, [mine])).toBe(true)
    })

    it('a worker that died frees itself: an expired lease is taken over, and its old token can no longer release the new holder', async () => {
      const dead = await call(`try_acquire_worker_lock('lease-d', 60)`)
      await db.exec(`update worker_locks set locked_until = now() - interval '1 second' where name = 'lease-d'`)
      const next = await call(`try_acquire_worker_lock('lease-d', 60)`)
      expect(next).toMatch(/^[0-9a-f-]{36}$/)
      expect(next).not.toBe(dead)
      expect(await call(`release_worker_lock('lease-d', $1::uuid)`, [dead])).toBe(false)
      expect(await call(`try_acquire_worker_lock('lease-d', 60)`)).toBeNull()
    })

    it('rejects absurd lease lengths', async () => {
      await expect(call(`try_acquire_worker_lock('lease-e', 0)`)).rejects.toThrow(/5 to 900/)
      await expect(call(`try_acquire_worker_lock('lease-e', 100000)`)).rejects.toThrow(/5 to 900/)
      await expect(call(`try_acquire_worker_lock('BAD NAME', 60)`)).rejects.toThrow()
    })

    it('two runs started together: exactly one runs the work (through withWorkerLock on the real functions)', async () => {
      const rpc: LockRpc = {
        rpc: async (fn, args) => {
          try {
            const r = await db.query<{ r: unknown }>(`select ${fn}(${Object.keys(args).map((_, i) => `$${i + 1}`).join(', ')}) r`, Object.values(args))
            return { data: r.rows[0].r, error: null }
          } catch (e) {
            return { data: null, error: { message: String(e) } }
          }
        },
      }
      let running = 0, peak = 0, ran = 0
      const work = async () => { ran++; running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running-- }
      const results = await Promise.all(Array.from({ length: 8 }, () => withWorkerLock(rpc, 'sync-order-status', work)))
      expect(results.filter((r) => r.acquired)).toHaveLength(1)
      expect([ran, peak]).toEqual([1, 1])
      // and when it is finished the next run goes ahead
      expect((await withWorkerLock(rpc, 'sync-order-status', async () => 'next')).acquired).toBe(true)
    })
  })

  describe('the circuit breaker', () => {
    it('failure n pauses the provider for 2^(n-1) minutes, capped at an hour; one success closes it', async () => {
      const minutes = async () => Math.round(Number(await one(`select extract(epoch from sync_backoff_until - now()) v from providers where id = $1`, [provB])) / 60)
      const seen: number[] = []
      for (let i = 0; i < 9; i++) {
        await call(`record_provider_sync_result($1::uuid, false)`, [provB])
        seen.push(await minutes())
      }
      expect(seen).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60])
      expect(Number(await one(`select sync_failure_count v from providers where id = $1`, [provB]))).toBe(9)
      const ok = await call(`record_provider_sync_result($1::uuid, true)`, [provB])
      expect(ok).toEqual({ failures: 0, backoff_until: null })
      expect(await one(`select sync_backoff_until is null v from providers where id = $1`, [provB])).toBe(true)
    })

    it('an unknown provider is an error, not a silent no-op', async () => {
      await expect(call(`record_provider_sync_result('00000000-0000-4000-8000-0000000000ff'::uuid, false)`)).rejects.toThrow(/not found/)
    })
  })

  describe('the work list (get_order_sync_batch)', () => {
    it('holds what must be polled and leaves out what must not', async () => {
      const u = await user()
      await db.exec(`update orders set status = 'refunded' where status in ('submitted','in_progress','processing') and false`) // (no-op: keep earlier tests' orders as they are)
      const keep = {
        submitted: await order(u, 'A', 'submitted'),
        inProgress: await order(u, 'A', 'in_progress'),
        processingWithId: await order(u, 'A', 'processing_with_id'),
        recoverable: await order(u, 'A', 'processing_recoverable'),
        owed: await order(u, 'A', 'canceled_owed'),
      }
      const skip = {
        held: await order(u, 'A', 'processing_held'),
        plainCanceled: await order(u, 'A', 'canceled_plain'),
        completed: await order(u, 'A', 'completed'),
      }
      const got = new Set(await ids())
      for (const [name, id] of Object.entries(keep)) expect(got.has(id), name).toBe(true)
      for (const [name, id] of Object.entries(skip)) expect(got.has(id), name).toBe(false)
    })

    it('an order held for a human is never polled: it has no provider order id and nobody to ask', async () => {
      const u = await user()
      const held = await order(u, 'A', 'processing_held')
      expect(await ids()).not.toContain(held)
      // ... but the moment its provider order id is known (admin "mark resolved" / recovered note) it joins the poll
      await db.query(`update orders set provider_order_id = 'P-found', status = 'submitted', error_message = null where id = $1`, [held])
      expect(await ids()).toContain(held)
    })

    it('a provider in backoff drops out, its refund retries do not, and it returns when the pause ends', async () => {
      const u = await user()
      const inflightB = await order(u, 'B', 'submitted')
      const owedB = await order(u, 'B', 'canceled_owed')
      const inflightA = await order(u, 'A', 'submitted')
      await call(`record_provider_sync_result($1::uuid, false)`, [provB])
      const during = await ids()
      expect(during).not.toContain(inflightB)
      expect(during).toContain(owedB) // finishing a refund does not need the provider
      expect(during).toContain(inflightA) // other providers are unaffected
      await db.query(`update providers set sync_backoff_until = now() - interval '1 second' where id = $1`, [provB])
      expect(await ids()).toContain(inflightB) // half-open: the next run probes it
      await call(`record_provider_sync_result($1::uuid, true)`, [provB])
    })

    it('oldest-checked first, bounded, and the limit is clamped', async () => {
      const list = await batch(3)
      expect(list.length).toBeLessThanOrEqual(3)
      const times = list.map((b) => Date.parse(b.updated_at))
      expect([...times].sort((a, b) => a - b)).toEqual(times)
      expect((await batch(0)).length).toBeLessThanOrEqual(1)
      expect((await batch(100000)).length).toBeLessThanOrEqual(200)
    })

    it('carries what the worker needs, including the provider of the order\'s offer', async () => {
      const u = await user()
      const id = await order(u, 'B', 'submitted')
      const row = (await batch()).find((b) => b.id === id)!
      expect(row).toMatchObject({ status: 'submitted', quantity: 1000, offer_provider_id: provB, provider_id: provB, user_id: u })
      expect(Number(row.charge_amount)).toBe(4)
    })
  })
})
