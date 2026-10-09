import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../supabase/functions/_shared/secrets.ts'
import {
  RotationError,
  applyEnvUpdates,
  fingerprint,
  newRandomSecret,
  reencryptSql,
  rotateCronSecret,
  rotateProviderApiKey,
  rotateProviderKeySecret,
  setIssuedSecret,
  type SupabasePort,
} from '../scripts/lib/rotation.ts'

const ROOT = path.resolve(__dirname, '..')
const MASTER_A = Buffer.alloc(32, 7).toString('base64')
const MASTER_B = Buffer.alloc(32, 9).toString('base64')
// built at run time so the repository secret scanner does not mistake fixtures for real keys
const PANEL_KEY = ['panel', 'key', 'for', 'tests', '0001'].join('-')

/** A Supabase stand-in: SQL goes to a handler, secrets are recorded in order with the queries. */
function fakePort(handle: (sql: string) => Record<string, unknown>[] = () => []) {
  const log: string[] = []
  const secrets: Record<string, string> = {}
  const port: SupabasePort = {
    async setSecrets(s) { Object.assign(secrets, s); log.push(`secrets:${Object.keys(s).join(',')}`) },
    async query<T>(sql: string) { log.push(`sql:${sql.trim().split("'")[0].trim().split(/\s+/).slice(0, 3).join(' ')}`); return handle(sql) as T[] },
  }
  return { port, log, secrets, writes: () => log.filter((l) => l.startsWith('secrets:') || /^sql:(update|do|select vault)/.test(l)) }
}

// ---------------------------------------------------------------------------
// 1. The rotation procedures
// ---------------------------------------------------------------------------

describe('rotate CRON_SECRET', () => {
  it('dry run reads, plans and writes nothing; no value appears in the plan', async () => {
    const f = fakePort(() => [{ n: 1 }])
    const r = await rotateCronSecret(f.port, { apply: false })
    expect(f.writes()).toEqual([])
    expect(r.steps.join('\n')).not.toContain(r.envUpdates.CRON_SECRET)
    expect(r.steps[0]).toMatch(/^new CRON_SECRET sha256:[0-9a-f]{10}$/)
  })

  it('apply updates the Vault copy pg_cron sends, then the function secret, with the same value', async () => {
    const sql: string[] = []
    const f = fakePort((s) => { sql.push(s); return s.includes('count(*)') ? [{ n: 1 }] : [] })
    const r = await rotateCronSecret(f.port, { apply: true })
    expect(f.writes()).toEqual(['sql:select vault.update_secret(id,', 'secrets:CRON_SECRET'])
    expect(sql[1]).toContain(`'${r.envUpdates.CRON_SECRET}'`)
    expect(f.secrets.CRON_SECRET).toBe(r.envUpdates.CRON_SECRET)
    expect(r.envUpdates.CRON_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url
  })

  it('creates the Vault secret when it is missing', async () => {
    const f = fakePort((s) => (s.includes('count(*)') ? [{ n: 0 }] : []))
    await rotateCronSecret(f.port, { apply: true })
    expect(f.writes()[0]).toBe('sql:select vault.create_secret(')
  })

  it('refuses a value that could break out of SQL or a header', async () => {
    for (const bad of ["x'; drop table users; --", 'short', 'with space inside it 123']) {
      await expect(rotateCronSecret(fakePort().port, { apply: true, newValue: bad })).rejects.toBeInstanceOf(RotationError)
    }
  })

  it('every rotation produces a fresh value', async () => {
    const a = await rotateCronSecret(fakePort(() => [{ n: 1 }]).port, { apply: false })
    const b = await rotateCronSecret(fakePort(() => [{ n: 1 }]).port, { apply: false })
    expect(a.envUpdates.CRON_SECRET).not.toBe(b.envUpdates.CRON_SECRET)
  })
})

describe('rotate PROVIDER_KEY_SECRET', () => {
  const rows = async () => [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Panel A', api_key_encrypted: await encryptSecret('key-of-panel-a', MASTER_A) },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Panel B', api_key_encrypted: await encryptSecret('key-of-panel-b', MASTER_A) },
  ]

  it('re-encrypts every stored provider key under the new master key, in one statement, then sets the secret', async () => {
    const stored = await rows()
    let update = ''
    const f = fakePort((s) => { if (s.startsWith('do ')) update = s; return s.startsWith('select id') ? stored : [] })
    const r = await rotateProviderKeySecret(f.port, { apply: true, oldMaster: MASTER_A, newMaster: MASTER_B })
    expect(f.writes()).toEqual(['sql:do $rotate$ declare', 'secrets:PROVIDER_KEY_SECRET'])
    expect(f.secrets.PROVIDER_KEY_SECRET).toBe(MASTER_B)
    const newCts = [...update.matchAll(/'(v1:[^']+)'\)/g)].map((m) => m[1])
    expect(await Promise.all(newCts.map((c) => decryptSecret(c, MASTER_B)))).toEqual(['key-of-panel-a', 'key-of-panel-b'])
    expect(update).not.toContain('key-of-panel') // plaintext never travels
    expect(r.steps.join('\n')).toContain('re-encrypt 2 stored provider key(s)')
  })

  it('aborts before ANY write when one stored key cannot be decrypted with the current master', async () => {
    const stored = await rows()
    stored[1].api_key_encrypted = await encryptSecret('x', MASTER_B) // encrypted with something else
    const f = fakePort((s) => (s.startsWith('select id') ? stored : []))
    await expect(rotateProviderKeySecret(f.port, { apply: true, oldMaster: MASTER_A })).rejects.toThrow(/"Panel B" cannot be decrypted.*Nothing was changed/)
    expect(f.writes()).toEqual([])
  })

  it('refuses when encrypted keys exist but the current master is unknown; works when nothing is stored', async () => {
    const stored = await rows()
    const a = fakePort((s) => (s.startsWith('select id') ? stored : []))
    await expect(rotateProviderKeySecret(a.port, { apply: true, oldMaster: undefined })).rejects.toThrow(/not in .env.local: nothing was changed/)
    expect(a.writes()).toEqual([])
    const b = fakePort(() => [])
    await rotateProviderKeySecret(b.port, { apply: true, oldMaster: undefined })
    expect(b.writes()).toEqual(['secrets:PROVIDER_KEY_SECRET'])
  })

  it('rejects a master key that is not 32 bytes, or the same as before', async () => {
    await expect(rotateProviderKeySecret(fakePort().port, { apply: false, oldMaster: MASTER_A, newMaster: 'c2hvcnQ=' })).rejects.toThrow(/32 random bytes/)
    await expect(rotateProviderKeySecret(fakePort().port, { apply: false, oldMaster: MASTER_A, newMaster: MASTER_A })).rejects.toThrow(/equals the current/)
  })
})

describe('rotate one provider API key', () => {
  const provider = (encrypted: boolean) => (s: string) => (s.includes('lower(name)') ? [{ id: '11111111-1111-4111-8111-111111111111', name: 'Panel A', encrypted }] : s.startsWith('update') ? [{ id: 'x' }] : [])

  it('auto: a provider whose key lives in the database gets it re-encrypted there', async () => {
    let update = ''
    const f = fakePort((s) => { if (s.startsWith('update')) update = s; return provider(true)(s) })
    const r = await rotateProviderApiKey(f.port, { apply: true, provider: 'panel a', newKey: PANEL_KEY, master: MASTER_A, store: 'auto' })
    const ct = /'(v1:[^']+)'/.exec(update)![1]
    expect(await decryptSecret(ct, MASTER_A)).toBe(PANEL_KEY)
    expect(update).not.toContain(PANEL_KEY)
    expect(r.envUpdates).toEqual({})
  })

  it('auto: otherwise it becomes the PROVIDER_<NAME>_API_KEY function secret', async () => {
    const f = fakePort(provider(false))
    const r = await rotateProviderApiKey(f.port, { apply: true, provider: 'Panel A', newKey: PANEL_KEY, master: undefined, store: 'auto' })
    expect(f.secrets).toEqual({ PROVIDER_PANEL_A_API_KEY: PANEL_KEY })
    expect(r.envUpdates).toEqual({ PROVIDER_PANEL_A_API_KEY: PANEL_KEY })
  })

  it('refuses an env-only update that the stored encrypted key would silently override, and db storage without a master', async () => {
    await expect(rotateProviderApiKey(fakePort(provider(true)).port, { apply: true, provider: 'Panel A', newKey: PANEL_KEY, master: MASTER_A, store: 'env' })).rejects.toThrow(/takes precedence/)
    await expect(rotateProviderApiKey(fakePort(provider(false)).port, { apply: true, provider: 'Panel A', newKey: PANEL_KEY, master: undefined, store: 'db' })).rejects.toThrow(/needs PROVIDER_KEY_SECRET/)
  })

  it('an unknown provider changes nothing; the name is quoted safely', async () => {
    let lookup = ''
    const f = fakePort((s) => { lookup = s; return [] })
    await expect(rotateProviderApiKey(f.port, { apply: true, provider: "x' or '1'='1", newKey: PANEL_KEY, master: MASTER_A, store: 'auto' })).rejects.toThrow(/No provider is named/)
    expect(lookup).toContain("lower('x'' or ''1''=''1')")
    expect(f.writes()).toEqual([])
  })
})

describe('set a secret issued elsewhere', () => {
  it('only the allow-listed names, with sane values', async () => {
    const f = fakePort()
    await setIssuedSecret(f.port, { apply: true, name: 'TELEGRAM_BOT_TOKEN', value: '123456:ABCdefGHIjklMNOpqr' })
    expect(Object.keys(f.secrets)).toEqual(['TELEGRAM_BOT_TOKEN'])
    await expect(setIssuedSecret(f.port, { apply: true, name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'x'.repeat(40) })).rejects.toThrow(/only/)
    await expect(setIssuedSecret(f.port, { apply: true, name: 'JWT_SECRET', value: 'a'.repeat(20) })).rejects.toThrow(/at least 32/)
  })
})

describe('helpers', () => {
  it('fingerprints identify without revealing', () => {
    const v = newRandomSecret()
    expect(fingerprint(v)).toMatch(/^sha256:[0-9a-f]{10}$/)
    expect(fingerprint(v)).not.toContain(v.slice(0, 6))
    expect(fingerprint(v)).toBe(fingerprint(v))
  })

  it('.env.local write-back replaces only the rotated lines and appends missing ones', () => {
    const before = '# comment\nCRON_SECRET=old\nOTHER=keep\n'
    expect(applyEnvUpdates(before, { CRON_SECRET: 'new' })).toBe('# comment\nCRON_SECRET=new\nOTHER=keep\n')
    expect(applyEnvUpdates('A=1\n', { B: '2' })).toBe('A=1\n\n# rotated by scripts/rotate-secrets.ts\nB=2\n')
    expect(applyEnvUpdates('A=1\r\nCRON_SECRET=x\r\n', { CRON_SECRET: 'y' })).toBe('A=1\nCRON_SECRET=y\n')
  })

  it('the re-encryption statement refuses anything that is not a uuid / v1 ciphertext', () => {
    expect(() => reencryptSql([{ id: "1'; drop table x; --", old: 'v1:a:b', next: 'v1:c:d' }])).toThrow(RotationError)
    expect(() => reencryptSql([{ id: '11111111-1111-4111-8111-111111111111', old: "v1:a:b'", next: 'v1:c:d' }])).toThrow(RotationError)
  })
})

// ---------------------------------------------------------------------------
// 2. The CLI fails safely
// ---------------------------------------------------------------------------

describe('rotate-secrets CLI', () => {
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts/rotate-secrets.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, NEW_SECRET_VALUE: '' }, timeout: 30_000 })
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-'))

  it('exits non-zero, touching nothing, without .env.local', () => {
    const r = run(dir(), 'cron', '--apply')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/\.env\.local not found/)
  })

  it('exits non-zero when the token or project ref is missing, and never echoes values it was given', () => {
    const d = dir()
    fs.writeFileSync(path.join(d, '.env.local'), 'SUPABASE_PROJECT_REF=abcdefghijklmnopqrst\nCRON_SECRET=current-cron-value-123456\n')
    const r = run(d, 'cron', '--apply')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF must be set/)
    expect(r.stdout + r.stderr).not.toContain('current-cron-value')
    expect(fs.readFileSync(path.join(d, '.env.local'), 'utf8')).toContain('CRON_SECRET=current-cron-value-123456')
  })

  it('refuses unknown commands and set targets outside the allow list', () => {
    const d = dir()
    fs.writeFileSync(path.join(d, '.env.local'), `SUPABASE_ACCESS_TOKEN=${'t'.repeat(40)}\nSUPABASE_PROJECT_REF=abcdefghijklmnopqrst\n`)
    expect(run(d, 'nuke').stderr).toMatch(/unknown command/)
    expect(run(d, 'set', 'SUPABASE_SERVICE_ROLE_KEY').stderr).toMatch(/set needs one of/)
    expect(run(d, 'provider-key').stderr).toMatch(/needs --provider/)
  })

  it('is wired as npm run secrets:rotate', () => {
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['secrets:rotate']).toContain('scripts/rotate-secrets.ts')
  })
})

// ---------------------------------------------------------------------------
// 3. Quarantine, runbook SQL and the rotation statement on the real schema
// ---------------------------------------------------------------------------

const RUNBOOK = fs.readFileSync(path.join(ROOT, 'docs/RUNBOOK.md'), 'utf8')
/** The ```sql blocks marked `-- runbook-test: <name>`: they are executed below exactly as an operator would paste them. */
const runbookBlock = (name: string): string => {
  const block = [...RUNBOOK.matchAll(/^([ \t]*)```sql\n([\s\S]*?)^[ \t]*```/gm)]
    .map((m) => m[2].split('\n').map((l) => l.slice(m[1].length)).join('\n'))
    .find((b) => b.startsWith(`-- runbook-test: ${name}\n`))
  if (!block) throw new Error(`runbook block ${name} not found`)
  return block
}

describe('incident SQL (real migrations on PGlite)', () => {
  let db: PGlite
  let prov: string, other: string
  type R = Record<string, unknown>
  const q = async <T = R>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows
  const settings = async () => (await q<R>(`select global_orders_enabled o, global_payments_enabled p, maintenance_mode m, minimum_treasury_reserve::float8 r from platform_settings`))[0]
  const treasury = async () => Number((await q<{ b: string }>(`select balance::text b from treasury_state`))[0].b)
  const statusOf = async (id: string) => (await q<{ s: string }>(`select status::text s from provider_payments where id = $1`, [id]))[0].s

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`insert into users(telegram_id, is_admin) values (1, true)`)
    prov = (await q<{ id: string }>(`insert into providers(name, api_url, routing_enabled, health_status, allowed_destination_wallet, max_topup_per_tx, max_daily_topup, api_key_encrypted)
      values ('Rogue Panel', 'https://r', true, 'healthy', '0:${'ab'.repeat(32)}', 100, 1000, 'v1:AAAA:BBBB') returning id`))[0].id
    other = (await q<{ id: string }>(`insert into providers(name, api_url, routing_enabled, health_status, allowed_destination_wallet, max_topup_per_tx, max_daily_topup)
      values ('Good Panel', 'https://g', true, 'healthy', '0:${'cd'.repeat(32)}', 100, 1000) returning id`))[0].id
    await db.exec(`
      insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'v');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        select id, '9', 's-' || name, 1, 1, 1000000 from providers;
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id, 'Views ' || ps.name, ps.id, 10, 1, 1000000 from categories c, provider_services ps;
      select process_treasury_transaction('deposit', 1000);
      update platform_settings set minimum_treasury_reserve = 25 where id = 1;`)
  }, 120_000)

  /** A payment walked through the real engine up to `to`. */
  async function payment(provider: string, amount: number, to: 'APPROVED' | 'VALIDATED' | 'PAYMENT_CREATED' | 'BROADCASTED') {
    const id = (await q<{ id: string }>(`insert into provider_payments(provider_id, amount, asset, network, destination_wallet, status, idempotency_key)
      select id, $2, payout_asset, payout_network, allowed_destination_wallet, 'PROPOSED', 'dr:' || gen_random_uuid() from providers where id = $1 returning id`, [provider, amount]))[0].id
    await q(`update provider_payments set status = 'APPROVED' where id = $1`, [id])
    if (to === 'APPROVED') return id
    await q(`select validate_provider_payment($1::uuid)`, [id])
    if (to === 'VALIDATED') return id
    await q(`select create_provider_payment_instruction($1::uuid)`, [id])
    if (to === 'PAYMENT_CREATED') return id
    await q(`select record_provider_payment_broadcast($1::uuid, $2)`, [id, `tx-${id}`])
    return id
  }
  const quarantine = () => db.exec(fs.readFileSync(path.join(ROOT, 'supabase/scripts/emergency_quarantine.sql'), 'utf8'))

  describe('emergency_quarantine.sql', () => {
    it('kill switches on, payouts frozen, unsent payments canceled with the money back, sent ones untouched', async () => {
      const approved = await payment(other, 10, 'APPROVED')
      const validated = await payment(other, 20, 'VALIDATED')
      const created = await payment(other, 30, 'PAYMENT_CREATED')
      const sent = await payment(other, 40, 'BROADCASTED')
      const before = await treasury()
      await quarantine()
      expect(await settings()).toEqual({ o: false, p: false, m: true, r: 999999999 })
      expect([await statusOf(approved), await statusOf(validated), await statusOf(created), await statusOf(sent)]).toEqual(['CANCELED', 'CANCELED', 'PAYMENT_CREATED', 'BROADCASTED'])
      expect(await treasury()).toBe(before + 20) // only the debited (validated) one is given back; approved was never debited
      // nothing new can leave: the reserve refuses every validation
      const next = await payment(other, 1, 'APPROVED')
      await expect(q(`select validate_provider_payment($1::uuid)`, [next])).rejects.toThrow(/treasury_reserve_breached/)
    })

    it('stores a restore point once; a second run changes nothing', async () => {
      await payment(other, 20, 'VALIDATED')
      await quarantine()
      const t = await treasury()
      await quarantine()
      expect(await treasury()).toBe(t)
      const points = await q<{ d: { previous: R } }>(`select details d from admin_audit_log where action = 'emergency_quarantine'`)
      expect(points).toHaveLength(1)
      expect(points[0].d.previous).toEqual({ global_orders_enabled: true, global_payments_enabled: true, maintenance_mode: false, minimum_treasury_reserve: 25, global_tickets_enabled: true, global_referral_transfers_enabled: true, global_signups_enabled: true })
      expect((await q(`select 1 from treasury_transactions where reference_id like 'payment-reversal:%'`))).toHaveLength(1)
    })

    it('the runbook\'s lift-quarantine block puts back exactly what was there', async () => {
      await db.exec(`update platform_settings set global_payments_enabled = false where id = 1`) // already off before the incident
      await quarantine()
      await db.exec(runbookBlock('lift-quarantine'))
      expect(await settings()).toEqual({ o: true, p: false, m: false, r: 25 })
      expect(await q(`select 1 from admin_audit_log where action = 'emergency_quarantine_lifted'`)).toHaveLength(1)
    })
  })

  describe('Scenario A: isolate-provider block', () => {
    const isolate = (name = 'Rogue Panel') => db.exec(runbookBlock('isolate-provider').split('<PROVIDER NAME>').join(name))

    it('locks the provider out, isolates its catalog, stops its payouts; the other provider is untouched', async () => {
      const validated = await payment(prov, 20, 'VALIDATED')
      const sent = await payment(prov, 30, 'BROADCASTED')
      await q(`insert into topup_proposals(provider_id, amount) values ($1, 50)`, [prov])
      const before = await treasury()
      await isolate()
      expect((await q(`select is_active, routing_enabled, health_status::text h, api_key_encrypted k, allowed_destination_wallet w, max_topup_per_tx m from providers where id = $1`, [prov]))[0])
        .toEqual({ is_active: false, routing_enabled: false, h: 'disabled', k: null, w: null, m: null })
      expect(await q(`select 1 from provider_service_offers where provider_id = $1 and (is_active or not anomaly_detected)`, [prov])).toHaveLength(0)
      expect(await q(`select 1 from provider_services where provider_id = $1 and is_active`, [prov])).toHaveLength(0)
      expect([await statusOf(validated), await statusOf(sent)]).toEqual(['CANCELED', 'BROADCASTED'])
      expect(await treasury()).toBe(before + 20)
      expect((await q<{ s: string }>(`select status::text s from topup_proposals where provider_id = $1`, [prov]))[0].s).toBe('rejected')
      expect(await q(`select 1 from admin_audit_log where action = 'incident_isolate_provider' and target_id = $1`, [prov])).toHaveLength(1)
      // the healthy provider keeps everything
      expect((await q(`select is_active, routing_enabled from providers where id = $1`, [other]))[0]).toEqual({ is_active: true, routing_enabled: true })
      expect(await q(`select 1 from provider_service_offers where provider_id = $1 and is_active`, [other])).toHaveLength(1)
      // and a new payment to the isolated provider fails closed
      const next = (await q<{ id: string }>(`insert into provider_payments(provider_id, amount, asset, network, destination_wallet, status, idempotency_key)
        values ($1, 5, 'TON', 'mainnet', '0:${'ab'.repeat(32)}', 'APPROVED', 'after') returning id`, [prov]))[0].id
      await expect(q(`select validate_provider_payment($1::uuid)`, [next])).rejects.toThrow(/payout_not_configured/)
    })

    it('a wrong or ambiguous name aborts the whole block: nothing is changed', async () => {
      await expect(isolate('No Such Panel')).rejects.toThrow(/provider not found/)
      await db.exec('rollback') // the SQL editor ends a failed run the same way
      expect((await q(`select is_active from providers where id = $1`, [prov]))[0]).toEqual({ is_active: true })
    })
  })

  it('every other runbook-test SQL block runs against the real schema', async () => {
    const names = [...RUNBOOK.matchAll(/-- runbook-test: ([a-z-]+)/g)].map((m) => m[1])
    expect(names).toEqual(expect.arrayContaining(['isolate-provider', 'lift-quarantine', 'provider-open-orders', 'admins', 'treasury-ledger', 'wallet-ledger', 'audit-log', 'payments-in-flight', 'after-rotation', 'pitr-timeline']))
    for (const n of names.filter((x) => !['isolate-provider', 'lift-quarantine'].includes(x))) {
      await expect(db.exec(runbookBlock(n).split('<PROVIDER NAME>').join('Rogue Panel')), n).resolves.toBeTruthy()
    }
  })

  it('the PROVIDER_KEY_SECRET re-encryption statement is atomic and compare-and-set', async () => {
    const a = await encryptSecret('key-a', MASTER_A)
    const b = await encryptSecret('key-b', MASTER_A)
    await q(`update providers set api_key_encrypted = $2 where id = $1`, [prov, a])
    await q(`update providers set api_key_encrypted = $2 where id = $1`, [other, b])
    const a2 = await encryptSecret('key-a', MASTER_B)
    const b2 = await encryptSecret('key-b', MASTER_B)
    // one row changed meanwhile: the whole statement aborts, both rows keep their old ciphertext
    await expect(db.exec(reencryptSql([{ id: prov, old: a, next: a2 }, { id: other, old: 'v1:c3RhbGU=:c3RhbGU=', next: b2 }]))).rejects.toThrow(/rotation aborted: 1 of 2/)
    expect((await q<{ k: string }>(`select api_key_encrypted k from providers where id = $1`, [prov]))[0].k).toBe(a)
    await db.exec(reencryptSql([{ id: prov, old: a, next: a2 }, { id: other, old: b, next: b2 }]))
    const keys = await q<{ k: string }>(`select api_key_encrypted k from providers where id in ($1, $2) order by name desc`, [prov, other])
    expect(await Promise.all(keys.map((r) => decryptSecret(r.k, MASTER_B)))).toEqual(['key-a', 'key-b'])
  })
})

// ---------------------------------------------------------------------------
// 4. The runbook itself
// ---------------------------------------------------------------------------

describe('RUNBOOK.md', () => {
  it('covers the four scenarios plus quarantine, lifting it and post-rotation checks', () => {
    for (const h of ['## Scenario A: Provider API compromised or rogue', '## Scenario B: Treasury or wallet drain suspected', '## Scenario C: Secrets compromised',
      '## Scenario D: Database corrupted: point-in-time recovery', '## Emergency quarantine', '### Lifting the quarantine', '### C3. After any rotation']) expect(RUNBOOK).toContain(h)
  })

  it('every file and npm script it tells you to run exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>
    for (const m of RUNBOOK.matchAll(/npm run ([a-z:]+)/g)) expect(pkg, m[1]).toHaveProperty(m[1])
    for (const f of ['supabase/scripts/emergency_quarantine.sql', 'supabase/cron.example.sql', 'scripts/rotate-secrets.ts']) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('never passes a secret as a command-line argument', () => {
    expect(RUNBOOK).not.toMatch(/secrets:rotate[^\n]*(--value|=\S{16,})/)
    expect(RUNBOOK).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/)
  })
})
