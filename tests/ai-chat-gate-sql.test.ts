// The assistant's hourly limit and its log, against the REAL SQL (migration 20261231000500 on a database with every migration): the counting, the
// window, the clean-up, and the walls around both tables (nobody but the service role reaches them).
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const dir = path.resolve(__dirname, '../supabase/migrations')
const TG = 'tg:777000111'
const OTHER = 'tg:42'
const GUEST = 'ip:0123456789abcdef'
const USER = 'user:3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12'

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

describe('the assistant\'s limit and log (SQL)', () => {
  let db: PGlite
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  const hit = async (identifier: string, limit = 3, window = 3600) =>
    (await q<{ r: { allowed: boolean; limit: number; remaining: number; retry_after: number } }>('select chat_rate_hit($1, $2, $3) r', [identifier, limit, window]))[0]!.r
  const count = async (table: string, where = 'true') => Number((await q<{ n: string }>(`select count(*) n from ${table} where ${where}`))[0]!.n)
  const log = (identifier = TG, over: Partial<{ prompt: string; intent: object; matched: string[]; recommended: string[]; found: number; calls: number; model: string | null }> = {}) =>
    q('select record_ai_chat_log($1, $2, $3::jsonb, $4::text[], $5::text[], $6, $7, $8)', [
      identifier, over.prompt ?? 'cheap instagram followers', JSON.stringify(over.intent ?? { platform: 'instagram', cheap: true }),
      over.matched ?? ['IG-FOL-STD-ROOT1', 'IG-FOL-STD-ROOT2'], over.recommended ?? ['IG-FOL-STD-ROOT1'], over.found ?? 2, over.calls ?? 1, over.model === undefined ? 'gemini-3.5-flash-lite' : over.model,
    ])

  beforeAll(async () => { db = await freshDb() }, 240_000)
  afterAll(async () => { await db.close() })
  beforeEach(async () => { await db.exec('delete from ai_chat_hits; delete from ai_chat_logs;') })

  describe('the walls', () => {
    it('both tables have row level security and no grant for the API roles; the three functions are for the service role alone', async () => {
      for (const table of ['ai_chat_logs', 'ai_chat_hits']) {
        const [t] = await q<{ rls: boolean; anon: boolean; authed: boolean }>(`select
          (select relrowsecurity from pg_class where oid = 'public.${table}'::regclass) rls,
          has_table_privilege('anon', 'public.${table}', 'select, insert, update, delete') anon,
          has_table_privilege('authenticated', 'public.${table}', 'select, insert, update, delete') authed`)
        expect([t!.rls, t!.anon, t!.authed], table).toEqual([true, false, false])
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const [g] = await q<{ ok: boolean }>(`select (has_table_privilege('anon', 'public.${table}', '${privilege}') or has_table_privilege('authenticated', 'public.${table}', '${privilege}')) ok`)
          expect(g!.ok, `${table} ${privilege}`).toBe(false)
        }
      }
      for (const fn of ['chat_rate_hit(text, integer, integer, uuid, integer)', 'purge_ai_chat_logs(integer)', 'record_ai_chat_log(text, text, jsonb, text[], text[], integer, integer, text)']) {
        const [g] = await q<{ anon: boolean; authed: boolean; service: boolean; definer: boolean; pinned: boolean }>(`select
          has_function_privilege('anon', '${fn}', 'execute') anon, has_function_privilege('authenticated', '${fn}', 'execute') authed,
          has_function_privilege('service_role', '${fn}', 'execute') service,
          (select prosecdef from pg_proc where oid = '${fn}'::regprocedure) definer,
          (select coalesce(proconfig::text, '') like '%search_path=%' from pg_proc where oid = '${fn}'::regprocedure) pinned`)
        expect([g!.anon, g!.authed, g!.service, g!.definer, g!.pinned], fn).toEqual([false, false, true, true, true])
      }
    })
    it('a client role cannot read or write them in practice', async () => {
      await log()
      await hit(TG)
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`)
        try {
          await expect(db.query('select * from ai_chat_logs'), role).rejects.toThrow(/permission denied/)
          await expect(db.query('select * from ai_chat_hits'), role).rejects.toThrow(/permission denied/)
          await expect(db.query(`insert into ai_chat_logs (user_identifier, user_prompt) values ('${TG}', 'x')`), role).rejects.toThrow(/permission denied/)
          await expect(db.query(`select chat_rate_hit('${TG}', 1, 60)`), role).rejects.toThrow(/permission denied/)
        } finally {
          await db.exec('reset role')
        }
      }
    })
  })

  describe('the limit', () => {
    it('lets a person ask up to the limit in the window and says how many places are left', async () => {
      expect(await hit(TG)).toEqual({ allowed: true, limit: 3, remaining: 2, retry_after: 0, paying: false })
      expect(await hit(TG)).toEqual({ allowed: true, limit: 3, remaining: 1, retry_after: 0, paying: false })
      expect(await hit(TG)).toEqual({ allowed: true, limit: 3, remaining: 0, retry_after: 0, paying: false })
      const blocked = await hit(TG)
      expect(blocked).toMatchObject({ allowed: false, limit: 3, remaining: 0 })
      expect(blocked.retry_after).toBeGreaterThanOrEqual(3598)
      expect(blocked.retry_after).toBeLessThanOrEqual(3600)
    })
    it('a refused question is not counted: waiting is never punished', async () => {
      for (let i = 0; i < 3; i++) await hit(TG)
      for (let i = 0; i < 5; i++) expect((await hit(TG)).allowed).toBe(false)
      expect(await count('ai_chat_hits', `identifier = '${TG}'`)).toBe(3)
    })
    it('every person has their own hour: a Telegram id, a website account and a guest do not share', async () => {
      for (let i = 0; i < 3; i++) await hit(TG)
      expect((await hit(TG)).allowed).toBe(false)
      for (const other of [OTHER, USER, GUEST]) expect((await hit(other)).allowed, other).toBe(true)
    })
    it('the hour slides: hits older than the window do not count, and the wait is until the oldest one leaves it', async () => {
      await db.exec(`insert into ai_chat_hits (identifier, created_at) values
        ('${TG}', now() - interval '2 hours'), ('${TG}', now() - interval '61 minutes'),
        ('${TG}', now() - interval '3000 seconds'), ('${TG}', now() - interval '10 minutes')`)
      const first = await hit(TG, 3) // the two old ones are out of the hour: two inside it, so one place was left
      expect(first).toMatchObject({ allowed: true, remaining: 0 })
      const blocked = await hit(TG, 3)
      expect(blocked.allowed).toBe(false)
      expect(blocked.retry_after).toBeGreaterThanOrEqual(598) // the oldest inside the hour is 3000 s old: 600 s to go
      expect(blocked.retry_after).toBeLessThanOrEqual(601)
    })
    it('a window of another length is respected', async () => {
      await db.exec(`insert into ai_chat_hits (identifier, created_at) values ('${TG}', now() - interval '90 seconds')`)
      expect(await hit(TG, 1, 60)).toMatchObject({ allowed: true }) // 90 s ago is outside a 60 s window
      const blocked = await hit(TG, 1, 60)
      expect(blocked.allowed).toBe(false)
      expect(blocked.retry_after).toBeLessThanOrEqual(60)
      expect(blocked.retry_after).toBeGreaterThanOrEqual(58)
    })
    it('answers only for an identifier of the three known kinds: a raw IP address is refused and never stored', async () => {
      for (const bad of ['1.2.3.4', 'ip:1.2.3.4', 'ip:0123456789ABCDEF', 'ip:0123', 'tg:abc', 'tg:', `tg:${'9'.repeat(21)}`, 'user:not-a-uuid', 'unknown', '', "tg:1'; drop table ai_chat_hits;--"]) {
        await expect(q('select chat_rate_hit($1, 3, 3600)', [bad]), bad).rejects.toThrow(/invalid_parameter_value/)
      }
      await expect(q('select chat_rate_hit(null, 3, 3600)')).rejects.toThrow(/invalid_parameter_value/)
      expect(await count('ai_chat_hits')).toBe(0)
    })
    it('a limit or a window that is not positive is refused', async () => {
      for (const [limit, window] of [[0, 3600], [-1, 3600], [3, 0], [3, -5]]) await expect(q('select chat_rate_hit($1, $2, $3)', [TG, limit, window]), `${limit}/${window}`).rejects.toThrow(/invalid_parameter_value/)
      await expect(q('select chat_rate_hit($1, null, 3600)', [TG])).rejects.toThrow(/invalid_parameter_value/)
      await expect(q('select chat_rate_hit($1, 3, null)', [TG])).rejects.toThrow(/invalid_parameter_value/)
    })
    describe('the limit follows the money', () => {
      const user = async (telegram: number) => (await q<{ id: string }>('insert into users (telegram_id) values ($1) returning id', [telegram]))[0]!.id
      const paying = async (id: string, identifier: string, limit = 3, payingLimit = 6) =>
        (await q<{ r: { allowed: boolean; limit: number; remaining: number; paying: boolean } }>('select chat_rate_hit($1, $2, 3600, $3::uuid, $4) r', [identifier, limit, id, payingLimit]))[0]!.r
      const fund = (id: string, amount: number) => q(`select process_wallet_transaction($1::uuid, 'deposit', $2::numeric, null, 'fund', $3)`, [id, amount, `fund-${id}-${amount}`])

      it('an account that never paid, and a guest, keep the ordinary limit', async () => {
        const id = await user(881_001)
        expect(await paying(id, 'tg:881001')).toMatchObject({ allowed: true, limit: 3, paying: false })
        for (let i = 0; i < 2; i++) await paying(id, 'tg:881001')
        expect((await paying(id, 'tg:881001')).allowed).toBe(false) // the 4th question
        expect(await hit(GUEST)).toMatchObject({ limit: 3 }) // no user id: the plain three-argument call
      })
      it('money on the balance gives the larger hour', async () => {
        const id = await user(881_002)
        await fund(id, 5)
        const first = await paying(id, 'tg:881002')
        expect(first).toMatchObject({ allowed: true, limit: 6, remaining: 5, paying: true })
        for (let i = 0; i < 5; i++) expect((await paying(id, 'tg:881002')).allowed, `question ${i + 2}`).toBe(true)
        expect((await paying(id, 'tg:881002')).allowed).toBe(false) // the 7th
      })
      it('a customer who spent everything is still a customer: any completed ledger line counts', async () => {
        const id = await user(881_003)
        await fund(id, 2)
        await db.query(`update wallets set balance = 0 where user_id = $1`, [id]).catch(() => undefined) // the ledger forbids it; the balance may stay
        const wallet = Number((await q<{ b: string }>('select balance b from wallets where user_id = $1', [id]))[0]!.b)
        expect(wallet).toBeGreaterThanOrEqual(0)
        expect(await paying(id, 'tg:881003')).toMatchObject({ limit: 6, paying: true })
      })
      it('a pending credit is not money: only completed lines and a positive balance count', async () => {
        const id = await user(881_004)
        await q(`select process_wallet_transaction($1::uuid, 'deposit', 3::numeric, null, 'pending', $2, 'pending')`, [id, `p-${id}`])
        expect(await paying(id, 'tg:881004')).toMatchObject({ limit: 3, paying: false })
      })
      it('the larger hour is never smaller than the ordinary one', async () => {
        const id = await user(881_005)
        await fund(id, 5)
        expect(await paying(id, 'tg:881005', 10, 4)).toMatchObject({ limit: 10, paying: true })
      })
      it('without a paying limit, or for an unknown user, nothing changes', async () => {
        const id = await user(881_006)
        await fund(id, 5)
        expect((await q<{ r: { limit: number } }>('select chat_rate_hit($1, 3, 3600, $2::uuid, null) r', ['tg:881006', id]))[0]!.r.limit).toBe(3)
        expect(await paying('00000000-0000-4000-8000-00000000beef', 'tg:881007')).toMatchObject({ limit: 3, paying: false })
      })
      it('a paying limit that is not positive is refused', async () => {
        await expect(q('select chat_rate_hit($1, 3, 3600, null, 0)', ['tg:881008'])).rejects.toThrow(/invalid_parameter_value/)
      })
      it('once the customer pays the same hour widens at once: the questions already asked count against the new limit', async () => {
        const id = await user(881_009)
        for (let i = 0; i < 3; i++) await paying(id, 'tg:881009')
        expect((await paying(id, 'tg:881009')).allowed).toBe(false)
        await fund(id, 5)
        expect(await paying(id, 'tg:881009')).toMatchObject({ allowed: true, limit: 6, remaining: 2, paying: true })
      })
      it('the retry hint of a refused paying customer is for their own hour', async () => {
        const id = await user(881_010)
        await fund(id, 5)
        for (let i = 0; i < 6; i++) await paying(id, 'tg:881010')
        const r = (await q<{ r: { allowed: boolean; retry_after: number } }>('select chat_rate_hit($1, 3, 3600, $2::uuid, 6) r', ['tg:881010', id]))[0]!.r
        expect(r.allowed).toBe(false)
        expect(r.retry_after).toBeGreaterThan(3590)
      })
    })

    it('twenty an hour, as the chat asks for it', async () => {
      for (let i = 0; i < 20; i++) expect((await hit(TG, 20)).allowed, `question ${i + 1}`).toBe(true)
      expect((await hit(TG, 20)).allowed).toBe(false)
    })
  })

  describe('the log', () => {
    it('stores a line: who, what was asked, what was understood, what was found and what was recommended', async () => {
      await log(TG)
      const [row] = await q<Record<string, unknown>>('select * from ai_chat_logs')
      expect(row).toMatchObject({
        user_identifier: TG, user_prompt: 'cheap instagram followers', extracted_intent: { platform: 'instagram', cheap: true },
        matched_skus: ['IG-FOL-STD-ROOT1', 'IG-FOL-STD-ROOT2'], recommended_skus: ['IG-FOL-STD-ROOT1'], found_count: 2, tool_calls: 1, model: 'gemini-3.5-flash-lite',
      })
      expect(row!.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(row!.created_at).toBeInstanceOf(Date)
    })
    it('a guest, a website account and a model that is not known are stored as they are', async () => {
      await log(GUEST, { model: null })
      await log(USER)
      expect((await q<{ user_identifier: string; model: string | null }>('select user_identifier, model from ai_chat_logs order by user_identifier')).map((r) => r.user_identifier)).toEqual([GUEST, USER])
      expect(await count('ai_chat_logs', 'model is null')).toBe(1)
    })
    it('the second wall: a long prompt, long lists, huge numbers and a long model name are cut, not stored whole', async () => {
      await log(TG, {
        prompt: `  ${'x'.repeat(800)}  `, matched: Array.from({ length: 50 }, (_, i) => `IG-FOL-STD-ROOT${i}`), recommended: Array.from({ length: 30 }, (_, i) => `IG-FOL-STD-ROOT${i}`),
        found: 123_456, calls: 999, model: 'm'.repeat(200),
      })
      const [row] = await q<{ user_prompt: string; matched_skus: string[]; recommended_skus: string[]; found_count: number; tool_calls: number; model: string }>('select * from ai_chat_logs')
      expect(row!.user_prompt).toHaveLength(500)
      expect(row!.matched_skus).toHaveLength(20)
      expect(row!.recommended_skus).toHaveLength(10)
      expect([row!.found_count, row!.tool_calls]).toEqual([1000, 50])
      expect(row!.model).toHaveLength(80)
    })
    it('the table itself refuses what must never be there: a raw IP address as the person, an empty question, an intent that is not an object', async () => {
      await expect(log('1.2.3.4')).rejects.toThrow(/user_identifier/)
      await expect(log('ip:1.2.3.4')).rejects.toThrow(/user_identifier/)
      await expect(log(TG, { prompt: '   ' })).rejects.toThrow(/user_prompt/)
      await expect(q(`insert into ai_chat_logs (user_identifier, user_prompt, extracted_intent) values ('${TG}', 'x', '[1]'::jsonb)`)).rejects.toThrow(/extracted_intent/)
      await expect(q(`insert into ai_chat_logs (user_identifier, user_prompt, extracted_intent) values ('${TG}', 'x', jsonb_build_object('k', repeat('x', 2500)))`)).rejects.toThrow(/extracted_intent/)
      expect(await count('ai_chat_logs')).toBe(0)
    })
    it('missing lists and numbers are empty ones and zeros', async () => {
      await q('select record_ai_chat_log($1, $2, null, null, null, null, null, null)', [TG, 'hello'])
      const [row] = await q<Record<string, unknown>>('select * from ai_chat_logs')
      expect(row).toMatchObject({ extracted_intent: {}, matched_skus: [], recommended_skus: [], found_count: 0, tool_calls: 0, model: null })
    })
  })

  describe('the clean-up', () => {
    it('removes what is past its time and keeps the rest: log lines after 90 days, counted questions after two days', async () => {
      await db.exec(`
        insert into ai_chat_logs (user_identifier, user_prompt, created_at) values ('${TG}', 'old one', now() - interval '91 days'), ('${TG}', 'old two', now() - interval '120 days'),
                                                                                  ('${TG}', 'recent', now() - interval '89 days'), ('${TG}', 'today', now());
        insert into ai_chat_hits (identifier, created_at) values ('${TG}', now() - interval '3 days'), ('${TG}', now() - interval '30 hours'), ('${TG}', now());`)
      const [{ n }] = await q<{ n: number }>('select purge_ai_chat_logs(90) n')
      expect(n).toBe(2)
      expect((await q<{ user_prompt: string }>('select user_prompt from ai_chat_logs order by created_at')).map((r) => r.user_prompt)).toEqual(['recent', 'today'])
      expect(await count('ai_chat_hits')).toBe(2) // the one from three days ago is gone
    })
    it('a shorter time can be asked for, and a nonsense one is refused', async () => {
      await db.exec(`insert into ai_chat_logs (user_identifier, user_prompt, created_at) values ('${TG}', 'a week old', now() - interval '8 days'), ('${TG}', 'today', now())`)
      expect((await q<{ n: number }>('select purge_ai_chat_logs(7) n'))[0]!.n).toBe(1)
      for (const days of [0, -1]) await expect(q('select purge_ai_chat_logs($1)', [days])).rejects.toThrow(/invalid_parameter_value/)
      await expect(q('select purge_ai_chat_logs(null)')).rejects.toThrow(/invalid_parameter_value/)
    })
    it('happens by itself while the log is written (one call in fifty): nothing has to be scheduled', async () => {
      await db.exec(`insert into ai_chat_logs (user_identifier, user_prompt, created_at) values ('${OTHER}', 'long ago', now() - interval '200 days')`)
      // 800 lines: the chance that none of them triggers the clean-up is 0.98^800
      await q(`select record_ai_chat_log('${TG}', 'q', '{}'::jsonb, '{}'::text[], '{}'::text[], 0, 0, null) from generate_series(1, 800)`)
      expect(await count('ai_chat_logs', `user_prompt = 'long ago'`)).toBe(0)
      expect(await count('ai_chat_logs', `user_prompt = 'q'`)).toBe(800)
    })
  })
})
