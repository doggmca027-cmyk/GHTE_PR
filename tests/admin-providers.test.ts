import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { mapProviderError, parseProviderRequest, toProviderDto, validateProviderUrl } from '../supabase/functions/_shared/admin-providers.ts'
import { encryptSecret, resolveProviderApiKey } from '../supabase/functions/_shared/secrets.ts'

const U1 = '00000000-0000-4000-8000-000000000001'
const MASTER = Buffer.alloc(32, 7).toString('base64')
const RAW_KEY = 'sk_live_super_secret_key_123'

describe('validateProviderUrl', () => {
  it('accepts public https URLs and normalises the trailing slash', () => {
    expect(validateProviderUrl('https://panel.example.com/api/v2/')).toEqual({ url: 'https://panel.example.com/api/v2' })
    expect(validateProviderUrl('  https://panel.example.com  ')).toEqual({ url: 'https://panel.example.com' })
  })

  it.each([
    'http://panel.example.com', 'ftp://panel.example.com', 'not a url', 'https://user:pw@panel.example.com',
    'https://localhost/api', 'https://127.0.0.1/api', 'https://10.1.2.3', 'https://192.168.0.5', 'https://172.16.0.1', 'https://172.31.255.255',
    'https://169.254.169.254/latest', 'https://0.0.0.0', 'https://[::1]/', 'https://intranet/api', 'https://db.internal', 'https://printer.local',
  ])('refuses %s', (url) => {
    expect(validateProviderUrl(url)).toHaveProperty('error')
  })

  it('does not block a public address next to the private ranges', () => {
    expect(validateProviderUrl('https://172.32.0.1')).toHaveProperty('url')
    expect(validateProviderUrl('https://8.8.8.8')).toHaveProperty('url')
  })
})

describe('parseProviderRequest', () => {
  it('rejects non-objects and unknown actions', () => {
    expect(parseProviderRequest(null)).toEqual({ error: 'Body must be a JSON object.' })
    expect(parseProviderRequest([])).toEqual({ error: 'Body must be a JSON object.' })
    expect(parseProviderRequest({ action: 'DROP' })).toEqual({ error: 'Unknown action.' })
  })

  it('LIST_PROVIDERS takes no input', () => {
    expect(parseProviderRequest({ action: 'list_providers' })).toEqual({ action: 'LIST_PROVIDERS' })
  })

  it('TOGGLE_ROUTING needs a UUID and a real boolean', () => {
    expect(parseProviderRequest({ action: 'TOGGLE_ROUTING', id: U1, enabled: true })).toEqual({ action: 'TOGGLE_ROUTING', id: U1, enabled: true })
    expect(parseProviderRequest({ action: 'TOGGLE_ROUTING', id: 'x', enabled: true })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'TOGGLE_ROUTING', id: U1, enabled: 'yes' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'TOGGLE_ROUTING', id: U1 })).toHaveProperty('error')
  })

  it('UPSERT_PROVIDER create: name and apiUrl are required, the key is optional', () => {
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', name: 'Panel' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', apiUrl: 'https://p.example.com' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', name: ' Panel ', apiUrl: 'https://p.example.com/', apiKey: ` ${RAW_KEY} `, currency: 'usd', priority: 5 })).toEqual({
      action: 'UPSERT_PROVIDER', id: null, name: 'Panel', apiUrl: 'https://p.example.com', apiKey: RAW_KEY, apiVersion: null, priority: 5, isActive: null, currency: 'USD',
    })
  })

  it('UPSERT_PROVIDER update: an empty key means "keep the stored key"', () => {
    const r = parseProviderRequest({ action: 'UPSERT_PROVIDER', id: U1, name: 'New name', apiKey: '' })
    expect(r).toMatchObject({ action: 'UPSERT_PROVIDER', id: U1, name: 'New name', apiKey: null })
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', id: U1, apiKey: null, name: 'x' })).toMatchObject({ apiKey: null })
  })

  it('UPSERT_PROVIDER update with nothing to change is refused', () => {
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', id: U1 })).toEqual({ error: 'Nothing to update.' })
    expect(parseProviderRequest({ action: 'UPSERT_PROVIDER', id: U1, apiKey: '' })).toEqual({ error: 'Nothing to update.' })
  })

  it('validates every field', () => {
    const base = { action: 'UPSERT_PROVIDER', id: U1 }
    expect(parseProviderRequest({ ...base, id: 'x', name: 'a' })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, name: 'a'.repeat(81) })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, name: 5 })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, apiUrl: 'http://p.example.com' })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, apiKey: 'short' })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, apiKey: 'has some spaces inside' })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, apiKey: 12345678 })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, apiVersion: '2' })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, priority: 1.5 })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, priority: 10_001 })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, isActive: 'no' })).toHaveProperty('error')
    expect(parseProviderRequest({ ...base, currency: 'US' })).toHaveProperty('error')
  })

  it('does not echo the raw key in an error message', () => {
    const r = parseProviderRequest({ action: 'UPSERT_PROVIDER', id: U1, apiKey: 'has some spaces inside' }) as { error: string }
    expect(r.error).not.toContain('spaces inside')
  })
})

describe('mapProviderError', () => {
  it('maps business errors and hides everything else', () => {
    expect(mapProviderError('forbidden: actor is not an admin').status).toBe(403)
    expect(mapProviderError('provider_not_found').status).toBe(404)
    expect(mapProviderError('name_taken: a provider with this name already exists').status).toBe(409)
    expect(mapProviderError('no_api_key: x').error).toBe('no_api_key')
    expect(mapProviderError('provider_inactive: x').status).toBe(409)
    expect(mapProviderError('invalid_parameter_value: apiVersion must look like v2')).toMatchObject({ status: 400, message: 'apiVersion must look like v2' })
    expect(mapProviderError('connection refused 10.0.0.1')).toMatchObject({ status: 500, error: 'server_error' })
  })
})

describe('toProviderDto', () => {
  it('has no key field at all', () => {
    const dto = toProviderDto({ id: 'x', name: 'P', api_key_encrypted: 'v1:aaa:bbb', has_api_key: true, routing_enabled: false, is_active: true, priority: 0,
      provider_balance: '1.5', low_balance_threshold: '0', target_topup_balance: '0', reliability_penalty_multiplier: '1.000' })
    expect(JSON.stringify(dto)).not.toMatch(/v1:aaa|encrypted|api_key|"apiKey"/i)
    expect(dto).toMatchObject({ hasApiKey: true, balance: 1.5, reliabilityPenalty: 1 })
  })
})

describe('the API key envelope', () => {
  it('encrypts with the worker\'s envelope: the workers decrypt it back, the ciphertext holds no plaintext', async () => {
    const enc = await encryptSecret(RAW_KEY, MASTER)
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    expect(enc).not.toContain(RAW_KEY)
    expect(await resolveProviderApiKey({ name: 'P', api_key_encrypted: enc }, { get: (n) => (n === 'PROVIDER_KEY_SECRET' ? MASTER : undefined) })).toBe(RAW_KEY)
    // a fresh IV every time
    expect(await encryptSecret(RAW_KEY, MASTER)).not.toBe(enc)
  })
})

describe('provider SQL functions', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  let ENC: string

  const as = (fn: string, ...args: unknown[]) => db.query<{ r: Record<string, unknown> }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)
  const rowsOf = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const upsert = (args: Record<string, unknown>) =>
    as('admin_upsert_provider', args.actor ?? admin, args.id ?? null, args.name ?? null, args.url ?? null, args.key ?? null, args.version ?? null, args.priority ?? null, args.active ?? null, args.currency ?? null)

  beforeAll(async () => {
    ENC = await encryptSecret(RAW_KEY, MASTER)
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin = (await rowsOf(`insert into users(telegram_id, is_admin) values (1, true) returning id`))[0].id as string
    user = (await rowsOf(`insert into users(telegram_id) values (2) returning id`))[0].id as string
    banned = (await rowsOf(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`))[0].id as string
  }, 180_000)

  it('only the service role can execute them', async () => {
    for (const fn of ['admin_providers_list(uuid)', 'admin_upsert_provider(uuid, uuid, text, text, text, text, integer, boolean, text)', 'admin_set_provider_routing(uuid, uuid, boolean)']) {
      const g = (await rowsOf(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, has_function_privilege('service_role', '${fn}', 'execute') s`))[0]
      expect([g.a, g.u, g.s]).toEqual([false, false, true])
    }
  })

  it('refuses a non-admin and a banned admin', async () => {
    await expect(as('admin_providers_list', user)).rejects.toThrow(/forbidden/)
    await expect(upsert({ actor: banned, name: 'X', url: 'https://x.example.com' })).rejects.toThrow(/forbidden/)
    await expect(as('admin_set_provider_routing', user, admin, true)).rejects.toThrow(/forbidden/)
  })

  it('creates a provider: routing starts off, the key is stored encrypted, the answer has no key', async () => {
    const r = (await upsert({ name: ' Panel One ', url: 'https://one.example.com', key: ENC, priority: 3, currency: 'eur' })).rows[0].r
    expect(r).toMatchObject({ name: 'Panel One', api_url: 'https://one.example.com', routing_enabled: false, is_active: true, priority: 3, currency: 'EUR', has_api_key: true, created: true, slug: 'panel-one' })
    expect(JSON.stringify(r)).not.toContain(ENC)
    expect(r).not.toHaveProperty('api_key_encrypted')
    const stored = (await rowsOf(`select api_key_encrypted k from providers where id = $1`, [r.id]))[0].k as string
    expect(stored).toBe(ENC)
    expect(stored).not.toContain(RAW_KEY)
  })

  it('needs name and url for a new provider, refuses a duplicate name and a plaintext key', async () => {
    await expect(upsert({ name: 'No url' })).rejects.toThrow(/invalid_parameter_value/)
    await expect(upsert({ name: 'panel one', url: 'https://other.example.com' })).rejects.toThrow(/name_taken/)
    await expect(upsert({ name: 'Raw', url: 'https://raw.example.com', key: RAW_KEY })).rejects.toThrow(/must be sent encrypted/)
    expect(await rowsOf(`select 1 from providers where name = 'Raw'`)).toHaveLength(0)
  })

  it('an update without a key keeps the stored key; with a key it replaces it', async () => {
    const id = (await rowsOf(`select id from providers where name = 'Panel One'`))[0].id as string
    const r1 = (await upsert({ id, name: 'Panel 1', url: 'https://one-b.example.com' })).rows[0].r
    expect(r1).toMatchObject({ name: 'Panel 1', api_url: 'https://one-b.example.com', created: false, has_api_key: true })
    expect((await rowsOf(`select api_key_encrypted k from providers where id = $1`, [id]))[0].k).toBe(ENC)

    const ENC2 = await encryptSecret('another_secret_key_999', MASTER)
    await upsert({ id, key: ENC2 })
    expect((await rowsOf(`select api_key_encrypted k from providers where id = $1`, [id]))[0].k).toBe(ENC2)
  })

  it('an unknown id and a clashing rename are refused', async () => {
    await expect(upsert({ id: '00000000-0000-4000-8000-0000000000ff', name: 'Ghost' })).rejects.toThrow(/provider_not_found/)
    await upsert({ name: 'Panel Two', url: 'https://two.example.com' })
    const id = (await rowsOf(`select id from providers where name = 'Panel 1'`))[0].id as string
    await expect(upsert({ id, name: 'panel two' })).rejects.toThrow(/name_taken/)
  })

  it('routing: needs a key and an active provider; toggling is audited; switching a provider off turns routing off', async () => {
    const two = (await rowsOf(`select id from providers where name = 'Panel Two'`))[0].id as string
    await expect(as('admin_set_provider_routing', admin, two, true)).rejects.toThrow(/no_api_key/)

    const one = (await rowsOf(`select id from providers where name = 'Panel 1'`))[0].id as string
    expect((await as('admin_set_provider_routing', admin, one, true)).rows[0].r).toMatchObject({ routing_enabled: true })
    expect((await as('admin_set_provider_routing', admin, one, true)).rows[0].r).toMatchObject({ routing_enabled: true }) // idempotent
    expect(await rowsOf(`select 1 from admin_audit_log where action = 'set_provider_routing' and target_id = $1`, [one])).toHaveLength(1)

    expect((await upsert({ id: one, active: false })).rows[0].r).toMatchObject({ is_active: false, routing_enabled: false })
    await expect(as('admin_set_provider_routing', admin, one, true)).rejects.toThrow(/provider_inactive/)
    await expect(as('admin_set_provider_routing', admin, '00000000-0000-4000-8000-0000000000ff', true)).rejects.toThrow(/provider_not_found/)
    expect((await as('admin_set_provider_routing', admin, one, false)).rows[0].r).toMatchObject({ routing_enabled: false })
  })

  it('the list never contains the key column, in any form', async () => {
    const list = (await as('admin_providers_list', admin)).rows[0].r as unknown as Record<string, unknown>[]
    expect(list.length).toBeGreaterThanOrEqual(2)
    const text = JSON.stringify(list)
    expect(text).not.toContain('v1:')
    expect(text).not.toContain('api_key_encrypted')
    expect(list.find((p) => p.name === 'Panel Two')).toMatchObject({ has_api_key: false })
    expect(list.find((p) => p.name === 'Panel 1')).toMatchObject({ has_api_key: true })
  })

  it('the audit log records that the key changed, never the key', async () => {
    const rows = await rowsOf(`select details::text d from admin_audit_log where action in ('create_provider', 'update_provider')`)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const r of rows) {
      expect(r.d as string).not.toContain('v1:')
      expect(r.d as string).not.toContain(RAW_KEY)
    }
    expect(rows.some((r) => (r.d as string).includes('"api_key_changed": true'))).toBe(true)
  })
})
