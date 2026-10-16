// Catalogue sync in rotation (migration 20261203000000): one due provider per scheduled run, the one that waited longest.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXPECTED_JOBS } from '../supabase/functions/_shared/observability.ts'

const ids = { a: '00000000-0000-4000-8000-00000000c0a1', b: '00000000-0000-4000-8000-00000000c0b2', c: '00000000-0000-4000-8000-00000000c0c3', off: '00000000-0000-4000-8000-00000000c0d4' }

describe('catalogue sync rotation', () => {
  let db: PGlite
  const claim = async () => (await db.query<{ id: string | null }>(`select claim_catalog_sync_provider() id`)).rows[0].id
  const finish = (id: string) => db.query(`select finish_catalog_sync($1)`, [id])
  const ago = (id: string, col: 'catalog_sync_started_at' | 'catalog_synced_at', minutes: number | null) =>
    db.query(`update providers set ${col} = ${minutes === null ? 'null' : `now() - make_interval(mins => ${minutes})`} where id = $1`, [id])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers(id, name, api_url, routing_enabled, priority) values
        ('${ids.a}', 'A', 'https://a', true, 3), ('${ids.b}', 'B', 'https://b', true, 2), ('${ids.c}', 'C', 'https://c', true, 1),
        ('${ids.off}', 'Off', 'https://off', false, 9);`)
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('hands out each due routing-enabled provider once, never one with routing off, then nothing until one is due again', async () => {
    const got = [await claim(), await claim(), await claim()]
    expect(new Set(got)).toEqual(new Set([ids.a, ids.b, ids.c]))
    expect(got[0]).toBe(ids.a) // never synced, highest priority first
    expect(await claim()).toBeNull() // all three are running (started < 15 min ago)
    for (const id of got) await finish(id!)
    expect(await claim()).toBeNull() // all synced just now: not due for 50 minutes
  })

  it('a provider synced more than 50 minutes ago is due again; the longest-waiting attempt goes first', async () => {
    for (const id of [ids.a, ids.b, ids.c]) await ago(id, 'catalog_synced_at', 55)
    await ago(ids.a, 'catalog_sync_started_at', 56)
    await ago(ids.b, 'catalog_sync_started_at', 70)
    await ago(ids.c, 'catalog_sync_started_at', 60)
    expect([await claim(), await claim(), await claim()]).toEqual([ids.b, ids.c, ids.a])
  })

  it('a run that was killed (started, never finished) does not block the others and is retried after 15 minutes', async () => {
    for (const id of [ids.a, ids.b, ids.c]) { await finish(id); await ago(id, 'catalog_synced_at', 120); await ago(id, 'catalog_sync_started_at', 60) }
    await ago(ids.a, 'catalog_sync_started_at', 5) // A's run is going (or was just killed)
    expect([await claim(), await claim()]).toEqual(expect.arrayContaining([ids.b, ids.c]))
    expect(await claim()).toBeNull()
    await ago(ids.a, 'catalog_sync_started_at', 16)
    expect(await claim()).toBe(ids.a)
  })

  it('service role only; the health check expects a run every 5 minutes', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['claim_catalog_sync_provider(integer)', 'finish_catalog_sync(uuid)']) {
        expect((await db.query<{ p: boolean }>(`select has_function_privilege('${role}', 'public.${fn}', 'execute') p`)).rows[0].p).toBe(false)
      }
    }
    expect(EXPECTED_JOBS.find((j) => j.name === 'sync-catalog')).toMatchObject({ everyMinutes: 5, lateAfterMinutes: 45 })
    const fn = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/sync-catalog/index.ts'), 'utf8')
    expect(fn).toContain("db.rpc('claim_catalog_sync_provider')")
    expect(fn).toContain("db.rpc('finish_catalog_sync'")
  })
})
