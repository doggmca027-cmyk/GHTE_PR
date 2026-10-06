// Audits the Supabase side of the repo WITHOUT touching a real project:
//   * migration files are well-named, ordered and contain no seed data
//   * every migration applies cleanly, in order, to a fresh Postgres (in-process PGlite)
//   * Supabase's default grants are emulated (it hands ALL privileges on new public tables / functions
//     to anon + authenticated), so a forgotten REVOKE shows up here instead of in production
//   * RLS on every table, search_path pinned on every SECURITY DEFINER function,
//     clients can only read what they should, money functions are not callable by clients
//   * every Edge Function has a config.toml entry
//
//   npm run check:supabase

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = process.cwd()
const migrationsDir = join(root, 'supabase', 'migrations')
const functionsDir = join(root, 'supabase', 'functions')
const problems: string[] = []
const bad = (msg: string) => problems.push(msg)

// ---- 1. files ---------------------------------------------------------------------------------
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const seen = new Set<string>()
let previous = ''
for (const f of migrations) {
  const m = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(f)
  if (!m) bad(`migration "${f}" must be named <14-digit timestamp>_<snake_case>.sql`)
  else {
    if (seen.has(m[1])) bad(`duplicate migration timestamp ${m[1]}`)
    seen.add(m[1])
    if (m[1] <= previous) bad(`migration "${f}" is not newer than the previous one`)
    previous = m[1]
  }
  const sql = readFileSync(join(migrationsDir, f), 'utf8')
  if (/insert\s+into\s+(public\.)?(users|providers|price_rules|categories|services|provider_services)\b/i.test(sql)) {
    bad(`migration "${f}" inserts data: seed data belongs in supabase/seed.sql (which is never run in production)`)
  }
}

// ---- 2. apply to a fresh database -------------------------------------------------------------
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`)

let applied = 0
for (const f of migrations) {
  try {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
    applied++
  } catch (e) {
    bad(`migration "${f}" FAILED to apply: ${e instanceof Error ? e.message : String(e)}`)
    break
  }
}

// ---- 3. security invariants (only meaningful if everything applied) ---------------------------
if (applied === migrations.length) {
  const rows = async <T,>(sql: string) => (await db.query<T>(sql)).rows

  for (const t of await rows<{ relname: string }>(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)) {
    bad(`table public.${t.relname} does not have row level security enabled`)
  }

  for (const f of await rows<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`)) {
    bad(`SECURITY DEFINER function ${f.proname}() has no pinned search_path (privilege-escalation risk)`)
  }

  const writes = await rows<{ grantee: string; table_name: string; privilege_type: string }>(`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`)
  for (const g of writes) bad(`${g.grantee} has ${g.privilege_type} on public.${g.table_name}: all writes must go through service-role functions`)

  const READABLE: Record<string, string[]> = {
    anon: ['categories', 'services'],
    authenticated: ['categories', 'services', 'users', 'wallets', 'wallet_transactions', 'orders', 'order_status_history', 'deposits'],
  }
  const reads = await rows<{ grantee: string; table_name: string }>(`select grantee, table_name from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type = 'SELECT'`)
  for (const g of reads) {
    if (!READABLE[g.grantee].includes(g.table_name)) bad(`${g.grantee} can SELECT public.${g.table_name} (private table: provider costs, markup, audit or notification data)`)
  }

  const ADMIN_RPCS = ['get_admin_metrics', 'admin_provider_status', 'admin_reconciliation_queue', 'admin_force_refund', 'admin_mark_resolved', 'admin_list_price_rules', 'admin_update_price_rule', 'get_admin_pricing_view']
  const fns = await rows<{ proname: string; anon: boolean; authed: boolean }>(`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authed from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype`)
  for (const f of fns) {
    if (f.anon) bad(`anon can EXECUTE public.${f.proname}()`)
    if (f.authed && !ADMIN_RPCS.includes(f.proname)) bad(`authenticated users can EXECUTE public.${f.proname}() (only the audited admin RPCs may be callable by clients)`)
  }
  for (const name of ADMIN_RPCS) if (!fns.some((f) => f.proname === name)) bad(`expected admin RPC ${name}() is missing`)

  for (const p of await rows<{ tablename: string; policyname: string }>(`select tablename, policyname from pg_policies where schemaname = 'public' and (qual = 'true' or with_check = 'true')`)) {
    bad(`policy ${p.policyname} on ${p.tablename} allows every row (USING true)`)
  }
}

// ---- 4. every function is configured ----------------------------------------------------------
const functions = readdirSync(functionsDir).filter((n) => !n.startsWith('_') && statSync(join(functionsDir, n)).isDirectory())
const config = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8')
const configured = new Map([...config.matchAll(/\[functions\.([a-z0-9-]+)\][^[]*?verify_jwt\s*=\s*(true|false)/g)].map((m) => [m[1], m[2]]))
for (const name of functions) {
  if (!configured.has(name)) bad(`supabase/config.toml has no [functions.${name}] entry (it would default to verify_jwt = true and reject our own tokens)`)
  else if (configured.get(name) !== 'false') bad(`[functions.${name}] must set verify_jwt = false (each function authenticates itself)`)
  try {
    readFileSync(join(functionsDir, name, 'index.ts'), 'utf8')
  } catch {
    bad(`supabase/functions/${name}/index.ts is missing`)
  }
}
for (const name of configured.keys()) if (!functions.includes(name)) bad(`config.toml configures [functions.${name}] but supabase/functions/${name}/ does not exist`)

if (problems.length > 0) {
  console.error(`check-supabase: ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`check-supabase: OK (${migrations.length} migrations applied to a fresh database, ${functions.length} functions configured, security invariants hold).`)
