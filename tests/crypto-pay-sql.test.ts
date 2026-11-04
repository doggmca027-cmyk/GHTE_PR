// Deposits through Crypto Pay against the REAL SQL (migration 20261231000700 on a database with every migration): the credit is booked once whatever
// arrives how many times, what is credited is what we asked for, the message for the customer is queued in the same transaction, and nobody but the
// service role reaches any of it.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')

const freshDb = async () => {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`)
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  return db
}

describe('deposits through Crypto Pay (SQL)', () => {
  let db: PGlite
  let n = 0
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  const one = async <T = unknown>(sql: string, params: unknown[] = []) => (await q<{ v: T }>(sql, params))[0]!.v
  const newUser = async () => one<string>('insert into users (telegram_id) values ($1) returning id v', [9_000 + ++n])
  const balance = async (user: string) => Number(await one<string>('select balance v from wallets where user_id = $1', [user]))
  const invoiceFor = async (user: string, amount = 25, invoiceId = 1_000 + ++n) => {
    const row = (await q<{ id: string }>('select * from create_crypto_pay_invoice($1::uuid, $2::numeric)', [user, amount]))[0]!
    await db.query('update crypto_pay_invoices set invoice_id = $2, pay_url = $3 where id = $1', [row.id, invoiceId, `https://t.me/CryptoBot?start=IV${invoiceId}`])
    return { id: row.id, invoiceId }
  }
  /** What the webhook carries. By default the invoice is reported as paid for exactly the dollars it was made for. */
  const complete = async (invoiceId: number, asset: string | null = 'USDT', paid: number | null = 25.01, fiat: string | null = 'USD', fiatAmount?: number | null) => {
    const amount = fiatAmount === undefined ? Number(await one<string>('select amount_usd v from crypto_pay_invoices where invoice_id = $1', [invoiceId])) : fiatAmount
    return one<{ result: string; amount_usd: number; balance?: number }>('select complete_crypto_pay_invoice($1, $2, $3, $4, $5) v', [invoiceId, asset, paid, fiat, amount])
  }
  const walletRows = (user: string) => q<{ type: string; amount: string; idempotency_key: string; balance_after: string }>(
    `select t.type::text, t.amount::text, t.idempotency_key, t.balance_after::text from wallet_transactions t join wallets w on w.id = t.wallet_id where w.user_id = $1 order by t.created_at`, [user])
  const outbox = (user: string) => q<{ kind: string; payload: Record<string, unknown>; dedupe_key: string; order_id: string | null }>('select kind, payload, dedupe_key, order_id from notification_outbox where user_id = $1', [user])

  beforeAll(async () => { db = await freshDb() }, 240_000)
  afterAll(async () => { await db.close() })

  describe('the credit', () => {
    it('books the deposit under the key cryptopay:<invoice_id>, adds exactly the dollars that were asked for, and marks the invoice paid', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 25)
      expect(await complete(inv.invoiceId)).toMatchObject({ result: 'credited', amount_usd: 25, balance: 25 })
      expect(await balance(u)).toBe(25)
      expect(await walletRows(u)).toEqual([{ type: 'deposit', amount: '25.0000', idempotency_key: `cryptopay:${inv.invoiceId}`, balance_after: '25.0000' }])
      expect(await q('select status, paid_asset, paid_amount::text, (paid_at is not null) paid from crypto_pay_invoices where id = $1', [inv.id])).toEqual([{ status: 'paid', paid_asset: 'USDT', paid_amount: '25.010000000', paid: true }])
    })
    it('the same webhook again, a retry and a status poll: credited once, the balance moves once', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 10)
      expect((await complete(inv.invoiceId)).result).toBe('credited')
      for (let i = 0; i < 4; i++) expect(await complete(inv.invoiceId), `repeat ${i + 1}`).toMatchObject({ result: 'already_credited', amount_usd: 10 })
      expect(await balance(u)).toBe(10)
      expect(await walletRows(u)).toHaveLength(1)
      expect(await outbox(u)).toHaveLength(1)
    })
    it('arriving together, two calls credit once: the second waits for the first and finds it done', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 7.5)
      const results = await Promise.all([complete(inv.invoiceId), complete(inv.invoiceId), complete(inv.invoiceId)])
      expect(results.map((r) => r.result).sort()).toEqual(['already_credited', 'already_credited', 'credited'])
      expect(await balance(u)).toBe(7.5)
    })
    it('what is credited is what we asked for, whatever the amount the call carries (the invoice was made for that many dollars)', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 20)
      await complete(inv.invoiceId, 'TON', 4.1, null, null) // CryptoBot did not say the fiat amount: the stored one stands
      expect(await balance(u)).toBe(20)
    })
    it('an invoice we had marked expired is still credited once it turns out to be paid: the money has arrived', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 15)
      await db.query(`update crypto_pay_invoices set status = 'expired' where id = $1`, [inv.id])
      expect((await complete(inv.invoiceId)).result).toBe('credited')
      expect(await balance(u)).toBe(15)
    })
    it('a suspended customer is credited too: the money was received', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      await db.query('update users set is_banned = true where id = $1', [u])
      expect((await complete(inv.invoiceId)).result).toBe('credited')
      expect(await balance(u)).toBe(5)
    })
    it('the invoices of two customers do not mix', async () => {
      const [a, b] = [await newUser(), await newUser()]
      const [ia, ib] = [await invoiceFor(a, 3), await invoiceFor(b, 4)]
      await complete(ib.invoiceId, 'USDT', 4, 'USD', 4)
      expect([await balance(a), await balance(b)]).toEqual([0, 4])
      await complete(ia.invoiceId, 'USDT', 3, 'USD', 3)
      expect([await balance(a), await balance(b)]).toEqual([3, 7 - 3])
    })
  })

  describe('what is refused', () => {
    it('a paid invoice that reports another amount or another currency credits nothing and is put aside for a look', async () => {
      for (const [fiat, amount] of [['USD', 24.99], ['USD', 250], ['EUR', 25], ['RUB', 25]] as const) {
        const u = await newUser()
        const inv = await invoiceFor(u, 25)
        expect(await complete(inv.invoiceId, 'USDT', 25, fiat, amount), `${fiat} ${amount}`).toMatchObject({ result: 'review' })
        expect(await balance(u)).toBe(0)
        expect(await walletRows(u)).toEqual([])
        expect(await outbox(u)).toEqual([])
        const [row] = await q<{ status: string; review_reason: string }>('select status, review_reason from crypto_pay_invoices where id = $1', [inv.id])
        expect(row!.status).toBe('review')
        expect(row!.review_reason).toContain(String(fiat))
      }
    })
    it('an amount that matches to the fourth decimal is the same amount', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 25)
      expect((await complete(inv.invoiceId, 'USDT', 25, 'usd', 25.00004)).result).toBe('credited')
    })
    it('an invoice we never made is "unknown", not a credit', async () => {
      await expect(q('select complete_crypto_pay_invoice($1, $2, 5, $3, 5)', [987_654_321, 'USDT', 'USD'])).rejects.toThrow(/unknown_invoice/)
    })
    it('no invoice id at all is refused', async () => {
      for (const bad of [null, 0, -5]) await expect(q('select complete_crypto_pay_invoice($1)', [bad]), String(bad)).rejects.toThrow(/invalid_parameter_value/)
    })
    it('an asset name that is not a coin ticker is dropped, not stored', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      await complete(inv.invoiceId, "x'; drop table users;--", 5, 'USD', 5)
      expect((await q<{ paid_asset: string | null }>('select paid_asset from crypto_pay_invoices where id = $1', [inv.id]))[0]!.paid_asset).toBeNull()
    })
    it('a paid invoice is final: nothing about it can be changed or deleted afterwards', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      await complete(inv.invoiceId)
      await expect(q(`update crypto_pay_invoices set status = 'failed' where id = $1`, [inv.id])).rejects.toThrow(/immutable/)
      await expect(q(`update crypto_pay_invoices set amount_usd = 500 where id = $1`, [inv.id])).rejects.toThrow(/immutable/)
      await expect(q('delete from crypto_pay_invoices where id = $1', [inv.id])).rejects.toThrow(/cannot be deleted/)
    })
    it('what an invoice is for never changes, paid or not; nor does its CryptoBot id', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      await expect(q('update crypto_pay_invoices set amount_usd = 500 where id = $1', [inv.id])).rejects.toThrow(/terms are immutable/)
      await expect(q('update crypto_pay_invoices set user_id = $2 where id = $1', [inv.id, await newUser()])).rejects.toThrow(/terms are immutable/)
      await expect(q('update crypto_pay_invoices set invoice_id = 1 where id = $1', [inv.id])).rejects.toThrow(/cannot change/)
    })
    it('one CryptoBot invoice is one row', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      const other = (await q<{ id: string }>('select * from create_crypto_pay_invoice($1::uuid, 5::numeric)', [u]))[0]!
      await expect(q('update crypto_pay_invoices set invoice_id = $2 where id = $1', [other.id, inv.invoiceId])).rejects.toThrow(/unique|duplicate/)
    })
  })

  describe('the message for the customer', () => {
    it('is queued in the outbox in the same transaction as the credit, with the amount and the new balance, no order behind it', async () => {
      const u = await newUser()
      await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 10::numeric, null, 'earlier', $2)`, [u, `earlier-${u}`])
      const inv = await invoiceFor(u, 25)
      await complete(inv.invoiceId, 'TON', 5.3, 'USD', 25)
      expect(await outbox(u)).toEqual([{ kind: 'deposit', payload: { amount_usd: 25, asset: 'TON', balance: 35 }, dedupe_key: `cryptopay:${inv.invoiceId}:deposit`, order_id: null }])
      const [m] = await q<{ status: string; next_due: boolean }>(`select status::text, next_attempt_at <= now() as next_due from notification_outbox where user_id = $1`, [u])
      expect(m).toEqual({ status: 'pending', next_due: true }) // due at once
    })
    it('the notifier can claim it: the customer\'s chat comes with it', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 12)
      await complete(inv.invoiceId)
      const batch = (await one<Record<string, unknown>[]>('select claim_notification_batch(100) v')).filter((b) => b.user_id === u)
      expect(batch).toHaveLength(1)
      expect(batch[0]).toMatchObject({ kind: 'deposit', order_id: null, payload: { amount_usd: 12, asset: 'USDT' }, notifications_enabled: true })
      expect(Number(batch[0]!.telegram_id)).toBeGreaterThan(9_000)
    })
    it('a review or a repeat queues nothing', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 25)
      await complete(inv.invoiceId, 'USDT', 25, 'EUR', 25)
      expect(await outbox(u)).toEqual([])
    })
    it('the outbox accepts a deposit row only in its own shape: a payload, no order', async () => {
      const u = await newUser()
      await expect(q(`insert into notification_outbox (user_id, kind, dedupe_key) values ($1, 'deposit', 'x1')`, [u])).rejects.toThrow(/notification_outbox_shape/)
      await expect(q(`insert into notification_outbox (user_id, kind, dedupe_key, payload) values ($1, 'deposit', 'x2', '{}'::jsonb)`, [u])).resolves.toBeDefined()
      await expect(q(`insert into notification_outbox (user_id, kind, dedupe_key, payload) values ($1, 'completed', 'x3', '{}'::jsonb)`, [u])).rejects.toThrow(/notification_outbox_shape/)
    })
    it('a failure to queue the message never undoes the credit', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 9)
      await db.exec(`alter table notification_outbox add constraint force_fail_cp check (kind <> 'deposit') not valid`)
      try {
        expect((await complete(inv.invoiceId)).result).toBe('credited')
      } finally {
        await db.exec('alter table notification_outbox drop constraint force_fail_cp')
      }
      expect(await balance(u)).toBe(9)
    })
  })

  describe('a new invoice', () => {
    it('is a pending row with its time to live', async () => {
      const u = await newUser()
      const [row] = await q<{ status: string; amount_usd: string; network: string; ttl: number }>(
        `select status, amount_usd::text, network, extract(epoch from (expires_at - now()))::int ttl from create_crypto_pay_invoice($1::uuid, 12.34::numeric, 'testnet', 600)`, [u])
      expect(row).toMatchObject({ status: 'pending', amount_usd: '12.3400', network: 'testnet' })
      expect(row!.ttl).toBeGreaterThan(590)
      expect(row!.ttl).toBeLessThanOrEqual(600)
    })
    it('at most the cap of unpaid invoices at a time; an invoice that was paid or expired makes room', async () => {
      const u = await newUser()
      const made: string[] = []
      for (let i = 0; i < 3; i++) made.push((await q<{ id: string }>('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 3)', [u, 'mainnet']))[0]!.id)
      await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 3)', [u, 'mainnet'])).rejects.toThrow(/too_many_pending/)
      await db.query(`update crypto_pay_invoices set status = 'failed' where id = $1`, [made[0]])
      await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 3)', [u, 'mainnet'])).resolves.toBeDefined()
    })
    it('one customer\'s open invoices do not count against another', async () => {
      const [a, b] = [await newUser(), await newUser()]
      for (let i = 0; i < 2; i++) await q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 2)', [a, 'mainnet'])
      await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 2)', [a, 'mainnet'])).rejects.toThrow(/too_many_pending/)
      await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 2)', [b, 'mainnet'])).resolves.toBeDefined()
    })
    it('two requests sent together cannot both take the last place', async () => {
      const u = await newUser()
      await q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 2)', [u, 'mainnet'])
      const results = await Promise.allSettled([1, 2, 3].map(() => q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, 3600, 2)', [u, 'mainnet'])))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    })
    it('a suspended customer cannot start one; an unknown one neither', async () => {
      const u = await newUser()
      await db.query('update users set is_banned = true where id = $1', [u])
      await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric)', [u])).rejects.toThrow(/banned/)
      await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric)', ['00000000-0000-4000-8000-00000000dead'])).rejects.toThrow(/not found/)
    })
    it('the amount is a positive number of dollars with at most two decimals; the time to live is sane', async () => {
      const u = await newUser()
      for (const amount of [0, -1, 10.005, null]) await expect(q('select * from create_crypto_pay_invoice($1::uuid, $2::numeric)', [u, amount]), String(amount)).rejects.toThrow(/invalid_parameter_value/)
      for (const ttl of [0, 59, 86_401]) await expect(q('select * from create_crypto_pay_invoice($1::uuid, 5::numeric, $2, $3)', [u, 'mainnet', ttl]), String(ttl)).rejects.toThrow(/invalid_parameter_value/)
    })
    it('the table refuses an amount over its ceiling and a network it does not know', async () => {
      const u = await newUser()
      await expect(q(`insert into crypto_pay_invoices (user_id, amount_usd, expires_at) values ($1, 100001, now())`, [u])).rejects.toThrow(/amount_usd/)
      await expect(q(`insert into crypto_pay_invoices (user_id, amount_usd, network, expires_at) values ($1, 5, 'devnet', now())`, [u])).rejects.toThrow(/network/)
    })
  })

  describe('the walls', () => {
    it('the table has row level security and no grant for the API roles; both functions are for the service role alone', async () => {
      const [t] = await q<{ rls: boolean; anon: boolean; authed: boolean }>(`select (select relrowsecurity from pg_class where oid = 'public.crypto_pay_invoices'::regclass) rls,
        has_table_privilege('anon', 'public.crypto_pay_invoices', 'select, insert, update, delete') anon, has_table_privilege('authenticated', 'public.crypto_pay_invoices', 'select, insert, update, delete') authed`)
      expect([t!.rls, t!.anon, t!.authed]).toEqual([true, false, false])
      for (const fn of ['create_crypto_pay_invoice(uuid, numeric, text, integer, integer)', 'complete_crypto_pay_invoice(bigint, text, numeric, text, numeric)']) {
        const [g] = await q<{ anon: boolean; authed: boolean; service: boolean; definer: boolean; pinned: boolean }>(`select has_function_privilege('anon', '${fn}', 'execute') anon,
          has_function_privilege('authenticated', '${fn}', 'execute') authed, has_function_privilege('service_role', '${fn}', 'execute') service,
          (select prosecdef from pg_proc where oid = '${fn}'::regprocedure) definer, (select coalesce(proconfig::text, '') like '%search_path=%' from pg_proc where oid = '${fn}'::regprocedure) pinned`)
        expect([g!.anon, g!.authed, g!.service, g!.definer, g!.pinned], fn).toEqual([false, false, true, true, true])
      }
    })
    it('a client role can neither read the invoices nor credit itself in practice', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`)
        try {
          await expect(db.query('select * from crypto_pay_invoices'), role).rejects.toThrow(/permission denied/)
          await expect(db.query(`update crypto_pay_invoices set status = 'paid'`), role).rejects.toThrow(/permission denied/)
          await expect(db.query('select complete_crypto_pay_invoice($1)', [inv.invoiceId]), role).rejects.toThrow(/permission denied/)
          await expect(db.query('select create_crypto_pay_invoice($1::uuid, 5::numeric)', [u]), role).rejects.toThrow(/permission denied/)
        } finally {
          await db.exec('reset role')
        }
      }
      expect(await balance(u)).toBe(0)
    })
  })

  describe('the ledger stays in step', () => {
    it('the wallet equals the sum of its completed transactions after deposits that were repeated', async () => {
      const u = await newUser()
      for (const amount of [5, 7.25]) {
        const inv = await invoiceFor(u, amount)
        await complete(inv.invoiceId, 'USDT', amount, 'USD', amount)
        await complete(inv.invoiceId, 'USDT', amount, 'USD', amount)
      }
      const sum = Number(await one<string>(`select coalesce(sum(t.amount), 0) v from wallet_transactions t join wallets w on w.id = t.wallet_id where w.user_id = $1 and t.status = 'completed'`, [u]))
      expect(await balance(u)).toBe(sum)
      expect(sum).toBe(12.25)
    })
    it('the first deposit is counted for the analytics like any other', async () => {
      const u = await newUser()
      const inv = await invoiceFor(u, 5)
      await complete(inv.invoiceId)
      expect(Number(await one<string>(`select count(*) v from analytics_events where user_id = $1 and event_name = 'first_deposit'`, [u]))).toBe(1)
    })
  })
})
