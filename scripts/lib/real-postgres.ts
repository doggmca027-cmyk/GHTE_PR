// A real PostgreSQL for scripts (PGlite runs on one connection and cannot prove row locking).
//   * CONCURRENCY_DB_URL set  -> that database (LOCAL only: localhost / 127.0.0.1 / ::1), migrations assumed applied
//   * otherwise                -> a throwaway PostgreSQL 17 from the embedded-postgres package, deleted afterwards
// Used by scripts/concurrency-test.ts and scripts/ton-e2e.ts.

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pg from 'pg'

const root = process.cwd()

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })

export interface Db {
  url: string
  stop: () => Promise<void>
  embedded: boolean
}

export async function openDatabase(): Promise<Db> {
  const external = process.env.CONCURRENCY_DB_URL
  if (external) {
    const host = new URL(external).hostname
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
      throw new Error(`refusing to run against ${host}: CONCURRENCY_DB_URL must point at a LOCAL database`)
    }
    return { url: external, stop: async () => {}, embedded: false }
  }
  const bin = await postgresBinaries()
  const dir = mkdtempSync(join(tmpdir(), 'pg-concurrency-'))
  const port = await freePort()
  // A neutral locale and English messages: initdb fails on some Windows system locales (e.g. Ukrainian_Ukraine.1251).
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }
  execFileSync(bin.initdb, ['-D', dir, '-U', 'postgres', '--auth=trust', '--locale=C', '--lc-messages=C', '--encoding=UTF8'], { env, stdio: 'pipe' })
  const server = spawn(bin.postgres, ['-D', dir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=300'], { env, stdio: 'ignore' })
  const stop = async () => {
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r))
      try {
        // a clean shutdown releases the data files; a bare kill leaves backends holding them on Windows
        execFileSync(bin.pg_ctl, ['-D', dir, 'stop', '-m', 'fast', '-w'], { env, stdio: 'pipe' })
      } catch {
        server.kill()
      }
      await exited
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (e) {
      console.warn(`(could not delete the temporary cluster ${dir}: ${e instanceof Error ? e.message : e})`)
    }
  }
  try {
    const base = `postgresql://postgres@127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      const c = new pg.Client({ connectionString: `${base}/postgres` })
      try {
        await c.connect()
        await c.query('create database race')
        await c.end()
        break
      } catch (e) {
        await c.end().catch(() => {})
        if (i > 100) throw e
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    return { url: `${base}/race`, embedded: true, stop }
  } catch (e) {
    await stop()
    throw e
  }
}

/**
 * Real PostgreSQL 17 binaries from the embedded-postgres package for this platform. PostgreSQL cannot initialise a
 * cluster from an install path with non-ASCII characters (its own path ends up in bootstrap SQL), so when the project
 * lives in such a folder the binaries are copied once to the temp directory. (17, not 18: the 18.4 Windows build
 * crashes in initdb's post-bootstrap step on this setup.)
 */
async function postgresBinaries(): Promise<{ initdb: string; postgres: string; pg_ctl: string }> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const mod = (await import(`@embedded-postgres/${platform}-${process.arch}`)) as { initdb: string; postgres: string; pg_ctl: string }
  const native = dirname(dirname(mod.initdb))
  if (!/[^\x20-\x7e]/.test(native)) return mod
  const copy = join(tmpdir(), 'gthe-pg17-native')
  if (!existsSync(join(copy, 'bin'))) cpSync(native, copy, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  return { initdb: join(copy, 'bin', `initdb${exe}`), postgres: join(copy, 'bin', `postgres${exe}`), pg_ctl: join(copy, 'bin', `pg_ctl${exe}`) }
}

/** A plain PostgreSQL has no Supabase roles / auth schema: create what the migrations expect, then apply them all. */
export async function migrate(admin: pg.Client) {
  await admin.query(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = join(root, 'supabase', 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) await admin.query(readFileSync(join(dir, f), 'utf8'))
  return files.length
}

