import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { mapTreasuryError, parseTreasuryRequest } from '../supabase/functions/_shared/admin-treasury.ts'
import { signedUsd, treasuryTypeLabel } from '../src/lib/admin-view'
import { AdminApiError } from '../src/services/api/mock-admin'
import { createMockTreasury } from '../src/services/api/mock-treasury'

const KEY = 'abcdefgh-1234'

describe('parseTreasuryRequest', () => {
  it('defaults to GET with a bounded page size', () => {
    expect(parseTreasuryRequest({})).toEqual({ action: 'GET', limit: 50, beforeSeq: null })
    expect(parseTreasuryRequest({ action: 'get', limit: 5000, beforeSeq: 9 })).toEqual({ action: 'GET', limit: 200, beforeSeq: 9 })
  })

  it('accepts a signed manual adjustment and rounds to 4 decimals', () => {
    expect(parseTreasuryRequest({ action: 'MANUAL_ADJUSTMENT', amount: 100.123456, description: ' Initial funding ', idempotencyKey: KEY }))
      .toEqual({ action: 'MANUAL_ADJUSTMENT', amount: 100.1235, description: 'Initial funding', idempotencyKey: KEY })
    expect(parseTreasuryRequest({ action: 'MANUAL_ADJUSTMENT', amount: -5, description: 'Bank fee', idempotencyKey: KEY })).toMatchObject({ amount: -5 })
  })

  it.each([
    [null], [[]], ['x'], [{ action: 'DROP' }],
    [{ limit: 0 }], [{ limit: 1.5 }], [{ limit: '5' }], [{ beforeSeq: 0 }], [{ beforeSeq: 'a' }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 0, description: 'zero', idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 0.00001, description: 'rounds to zero', idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: Number.NaN, description: 'nan', idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: '5', description: 'string', idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 1e9, description: 'too big', idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 5, description: 'ab', idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 5, description: 'x'.repeat(201), idempotencyKey: KEY }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 5, description: 'no key' }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 5, description: 'short key', idempotencyKey: 'short' }],
    [{ action: 'MANUAL_ADJUSTMENT', amount: 5, description: 'bad key', idempotencyKey: 'has spaces in it!' }],
  ])('rejects %j', (body) => {
    expect(parseTreasuryRequest(body)).toHaveProperty('error')
  })
})

describe('mapTreasuryError', () => {
  it('maps the ledger errors and hides everything else', () => {
    expect(mapTreasuryError('insufficient_treasury_funds: available 10.0000, required 50.0000')).toMatchObject({ status: 409, error: 'insufficient_treasury_funds' })
    expect(mapTreasuryError('reference manual:x was already used with a different amount')).toMatchObject({ status: 409, error: 'idempotency_conflict' })
    expect(mapTreasuryError('amount must be non-zero')).toMatchObject({ status: 400 })
    const other = mapTreasuryError('connection to server at "10.0.0.5" failed')
    expect(other.status).toBe(500)
    expect(other.message).not.toContain('10.0.0.5')
  })
})

describe('view helpers and dev mock', () => {
  it('formats signed amounts and labels', () => {
    expect(signedUsd(5)).toBe('+$5.00')
    expect(signedUsd(-120.5)).toBe('-$120.50')
    expect(treasuryTypeLabel('provider_topup')).toBe('Provider top-up')
  })

  it('mock ledger refuses overdrafts, replays by key and paginates', () => {
    const m = createMockTreasury()
    const start = m.page(null).balance
    expect(() => m.adjust({ amount: -(start + 1), description: 'too much', idempotencyKey: KEY })).toThrow(AdminApiError)
    m.adjust({ amount: 10, description: 'add', idempotencyKey: KEY })
    m.adjust({ amount: 10, description: 'add', idempotencyKey: KEY }) // replay
    expect(m.page(null).balance).toBe(start + 10)
    const first = m.page(null, 2)
    expect(first.transactions).toHaveLength(2)
    expect(first.nextBefore).not.toBeNull()
    expect(m.page(first.nextBefore, 2).transactions.every((t) => t.seq < first.nextBefore!)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The ledger itself (real SQL on PGlite)
// ---------------------------------------------------------------------------

async function freshDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  return db
}

describe('process_treasury_transaction (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  beforeEach(async () => {
    db = await freshDb()
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    banned = await q(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`)
  }, 120_000)

  const tx = (type: string, amount: number | null, desc: string | null = null, ref: string | null = null, actor: string | null = null) =>
    db.query<Record<string, unknown>>(`select * from process_treasury_transaction($1::treasury_transaction_type_enum, $2::numeric, $3, $4, $5::uuid)`, [type, amount, desc, ref, actor])
  const balance = async () => Number((await db.query<{ b: string }>(`select balance::text b from treasury_state`)).rows[0].b)

  it('initialises exactly one row with a zero balance', async () => {
    const rows = (await db.query<{ id: number; b: string }>(`select id, balance::text b from treasury_state`)).rows
    expect(rows).toEqual([{ id: 1, b: '0.0000' }])
  })

  it('can never have a second row or a different id', async () => {
    await expect(db.exec(`insert into treasury_state(id) values (2)`)).rejects.toThrow()
    await expect(db.exec(`insert into treasury_state(id) values (1)`)).rejects.toThrow()
    await expect(db.exec(`delete from treasury_state`)).rejects.toThrow(/append-only/)
    await expect(db.exec(`truncate treasury_state`)).rejects.toThrow(/append-only/)
    await expect(db.exec(`update treasury_state set balance = -1`)).rejects.toThrow() // never negative
  })

  it('books credits and debits and records balance_after', async () => {
    const a = (await tx('deposit', 500, 'seed')).rows[0]
    const b = (await tx('provider_topup', -120.5, 'topup A')).rows[0]
    const c = (await tx('fee', -0.25)).rows[0]
    const d = (await tx('manual_adjustment', 3)).rows[0]
    expect([a, b, c, d].map((r) => Number(r.balance_after))).toEqual([500, 379.5, 379.25, 382.25])
    expect(await balance()).toBe(382.25)
    // the ledger always adds up to the balance
    const sum = (await db.query<{ s: string }>(`select sum(amount)::text s from treasury_transactions`)).rows[0].s
    expect(Number(sum)).toBe(382.25)
  })

  it('refuses to overdraw and leaves everything untouched', async () => {
    await tx('deposit', 100)
    await expect(tx('provider_topup', -100.0001)).rejects.toThrow(/insufficient_treasury_funds: available 100\.0000, required 100\.0001/)
    await expect(tx('manual_adjustment', -500)).rejects.toThrow(/insufficient_treasury_funds/)
    expect(await balance()).toBe(100)
    expect((await db.query(`select 1 from treasury_transactions`)).rows).toHaveLength(1)
    await tx('withdrawal', -100) // exactly zero is allowed
    expect(await balance()).toBe(0)
  })

  it.each([
    ['deposit', -5], ['withdrawal', 5], ['provider_topup', 5], ['fee', 5], ['deposit', 0], ['manual_adjustment', 0], ['deposit', null], ['deposit', 1e9], ['manual_adjustment', 0.00001],
  ] as [string, number | null][])('rejects %s with amount %s', async (type, amount) => {
    await expect(tx(type, amount)).rejects.toThrow()
    expect(await balance()).toBe(0)
  })

  it('is idempotent per (type, reference): a replay returns the original and books nothing', async () => {
    await tx('deposit', 200)
    const a = (await tx('provider_topup', -50, 'topup', 'topup:42')).rows[0]
    const b = (await tx('provider_topup', -50, 'topup retried', 'topup:42')).rows[0]
    expect(b.id).toBe(a.id)
    expect(await balance()).toBe(150)
    await expect(tx('provider_topup', -60, null, 'topup:42')).rejects.toThrow(/different amount/)
    expect(await balance()).toBe(150)
    // the same reference under another type is a different movement
    await tx('fee', -1, null, 'topup:42')
    expect(await balance()).toBe(149)
  })

  it('writes the audit entry in the same transaction when an admin is the actor', async () => {
    const row = (await tx('manual_adjustment', 40, 'Initial funding', 'manual:k1', admin)).rows[0]
    const audit = (await db.query<{ admin_id: string; action: string; details: { amount: number; balance_after: number } }>(
      `select admin_id, action, details from admin_audit_log where target_id = '${row.id}'`)).rows
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ admin_id: admin, action: 'treasury_manual_adjustment' })
    expect(audit[0].details).toMatchObject({ amount: 40, balance_after: 40 })

    // a failed movement leaves neither a ledger row nor an audit entry
    await expect(tx('manual_adjustment', -1000, 'x', 'manual:k2', admin)).rejects.toThrow()
    expect((await db.query(`select 1 from admin_audit_log where action like 'treasury_%'`)).rows).toHaveLength(1)
    // replays do not audit twice
    await tx('manual_adjustment', 40, 'Initial funding', 'manual:k1', admin)
    expect((await db.query(`select 1 from admin_audit_log where action like 'treasury_%'`)).rows).toHaveLength(1)
  })

  it('refuses an actor who is not a (live) admin', async () => {
    await expect(tx('manual_adjustment', 5, null, null, user)).rejects.toThrow(/forbidden/)
    await expect(tx('manual_adjustment', 5, null, null, banned)).rejects.toThrow(/forbidden/)
    await expect(tx('manual_adjustment', 5, null, null, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/forbidden/)
    expect(await balance()).toBe(0)
  })

  it('the ledger is append-only', async () => {
    const row = (await tx('deposit', 10)).rows[0]
    await expect(db.exec(`update treasury_transactions set amount = 99 where id = '${row.id}'`)).rejects.toThrow(/append-only/)
    await expect(db.exec(`delete from treasury_transactions`)).rejects.toThrow(/append-only/)
    await expect(db.exec(`truncate treasury_transactions`)).rejects.toThrow(/append-only/)
  })

  it('concurrent withdrawals can never overdraw (row lock)', async () => {
    await tx('deposit', 100)
    // 8 simultaneous debits of 30: at most 3 can succeed
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => tx('provider_topup', -30, null, `race:${i}`)))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    expect(ok).toBe(3)
    expect(await balance()).toBe(10)
    const last = (await db.query<{ b: string }>(`select balance_after::text b from treasury_transactions order by seq desc limit 1`)).rows[0].b
    expect(Number(last)).toBe(10)
    const sum = (await db.query<{ s: string }>(`select sum(amount)::text s from treasury_transactions`)).rows[0].s
    expect(Number(sum)).toBe(10)
  })

  it('concurrent retries of the same reference book once', async () => {
    await tx('deposit', 100)
    await Promise.all(Array.from({ length: 5 }, () => tx('manual_adjustment', -10, 'dup', 'manual:same')))
    expect(await balance()).toBe(90)
  })

  describe('access control', () => {
    it('anon and signed-in users can neither read nor write treasury data nor call the function', async () => {
      await tx('deposit', 10)
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`reset role; set role ${role}`)
        await expect(db.query(`select * from treasury_state`)).rejects.toThrow()
        await expect(db.query(`select * from treasury_transactions`)).rejects.toThrow()
        await expect(db.query(`update treasury_state set balance = 1000000`)).rejects.toThrow()
        await expect(db.query(`insert into treasury_transactions(type, amount, balance_after) values ('deposit', 1, 1)`)).rejects.toThrow()
        await expect(tx('deposit', 1000)).rejects.toThrow()
      }
      await db.exec('reset role')
      expect(await balance()).toBe(10)
    })

    it('service_role may call the function', async () => {
      await db.exec(`reset role; set role service_role`)
      await expect(tx('deposit', 25)).resolves.toBeTruthy()
      await db.exec('reset role')
      expect(await balance()).toBe(25)
    })
  })
})
