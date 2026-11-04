// CryptoBot was tried and removed: deposits are TON Connect (Tonkeeper) only. Nothing of it may be left in the database.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')

describe('no CryptoBot left', () => {
  let db: PGlite
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(root, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('after every migration there is no invoice table and no CryptoBot function; the ledger and the TON deposits are intact', async () => {
    const t = await db.query<{ n: string }>(`select relname n from pg_class where relname like '%crypto_pay%'`)
    const f = await db.query<{ n: string }>(`select proname n from pg_proc where proname like '%crypto_pay%'`)
    expect([t.rows, f.rows]).toEqual([[], []])
    for (const table of ['wallet_transactions', 'deposits', 'notification_outbox']) expect((await db.query(`select to_regclass('public.${table}') r`)).rows[0]).toEqual({ r: table })
  })
  it('the outbox kinds are the ones that have a sender', async () => {
    await expect(db.query(`insert into notification_outbox (user_id, kind, dedupe_key, payload) values (gen_random_uuid(), 'deposit', 'x', '{}'::jsonb)`)).rejects.toThrow(/notification_outbox_kind_check/)
  })
  it('no function, secret or setting of it is in the code', () => {
    for (const p of ['supabase/functions/cryptopay-webhook', 'supabase/functions/create-crypto-invoice', 'supabase/functions/_shared/crypto-pay.ts']) expect(fs.existsSync(path.join(root, p)), p).toBe(false)
    expect(fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8')).not.toMatch(/crypto/i)
    expect(fs.readFileSync(path.join(root, '.env.example'), 'utf8')).not.toMatch(/CRYPTO_PAY/)
    expect(fs.readFileSync(path.join(root, 'scripts/lib/env-checks.ts'), 'utf8')).not.toMatch(/CRYPTO_PAY/)
  })
})
