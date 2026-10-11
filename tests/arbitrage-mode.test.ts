// Smart Arbitrage: one switch for every donor network (catalog_mode = 'linked_only'); the primary network is never touched.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseProviderRequest, readDonorBalances, toArbitrageDonorDto } from '../supabase/functions/_shared/admin-providers.ts'
import { encryptSecret } from '../supabase/functions/_shared/secrets.ts'
import { arbitrageView } from '../src/lib/arbitrage-view'
import { createMockProviders } from '../src/services/api/mock-providers'
import type { ArbitrageDonor, ArbitrageStatus } from '../src/types/admin-providers'
import type { AuthSession } from '../src/services/api/auth'

const MASTER = Buffer.alloc(32, 7).toString('base64')

describe('SET_ARBITRAGE_MODE / ARBITRAGE_STATUS requests', () => {
  it('parses a real boolean only', () => {
    expect(parseProviderRequest({ action: 'SET_ARBITRAGE_MODE', enabled: true })).toEqual({ action: 'SET_ARBITRAGE_MODE', enabled: true })
    expect(parseProviderRequest({ action: 'set_arbitrage_mode', enabled: false })).toEqual({ action: 'SET_ARBITRAGE_MODE', enabled: false })
    expect(parseProviderRequest({ action: 'SET_ARBITRAGE_MODE', enabled: 'true' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'SET_ARBITRAGE_MODE' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'ARBITRAGE_STATUS' })).toEqual({ action: 'ARBITRAGE_STATUS' })
  })
})

describe('readDonorBalances (live balances before switching on)', () => {
  const donors = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }]

  it('reads every panel at once; one failing panel only marks that donor', async () => {
    const started: string[] = []
    const r = await readDonorBalances(donors, async (d) => {
      started.push(d.id)
      if (d.id === 'b') throw new Error('timeout')
      if (d.id === 'c') return { balance: -1 }
      if (d.id === 'd') return { balance: 0, currency: 'usd!' }
      await new Promise((ok) => setTimeout(ok, 5))
      return { balance: 12.5, currency: 'USD' }
    })
    expect(started).toEqual(['a', 'b', 'c', 'd']) // all started before the first answered
    expect(r).toEqual([
      { id: 'a', ok: true, balance: 12.5, currency: 'USD' },
      { id: 'b', ok: false },
      { id: 'c', ok: false }, // a negative balance is not a reading
      { id: 'd', ok: true, balance: 0 }, // zero is a real balance; a malformed currency is dropped
    ])
  })

  it('the donor DTO: ready = routing on and healthy', () => {
    const base = { id: 'x', name: 'X', is_active: true, provider_balance: '3.5', currency: 'USD', has_api_key: true, active_offers: 26 }
    expect(toArbitrageDonorDto({ ...base, routing_enabled: true, health_status: 'healthy' })).toMatchObject({ ready: true, balance: 3.5, activeOffers: 26 })
    expect(toArbitrageDonorDto({ ...base, routing_enabled: true, health_status: 'unavailable' })).toMatchObject({ ready: false })
    expect(toArbitrageDonorDto({ ...base, routing_enabled: false, health_status: 'healthy' })).toMatchObject({ ready: false })
  })
})

describe('admin_set_arbitrage_mode / admin_arbitrage_status (SQL)', () => {
  let db: PGlite
  let admin: string, user: string
  const ids: Record<string, string> = {}
  const rowsOf = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const setMode = async (enabled: boolean, readings: unknown = []) =>
    (await rowsOf(`select admin_set_arbitrage_mode($1, $2, $3::jsonb) r`, [admin, enabled, JSON.stringify(readings)]))[0].r as Record<string, unknown>
  const provider = async (name: string) => (await rowsOf(`select routing_enabled, health_status, provider_balance, currency, last_balance_sync from providers where name = $1`, [name]))[0]

  beforeAll(async () => {
    const ENC = await encryptSecret('sk_live_super_secret_key_123', MASTER)
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
    const add = async (name: string, mode: string, key: string | null, active = true) => {
      const r = (await rowsOf(`select admin_upsert_provider($1, null, $2, $3, $4, null, null, $5, null, $6) r`, [admin, name, `https://${name.toLowerCase()}.example.com`, key, active, mode]))[0].r as { id: string }
      ids[name] = r.id
    }
    await add('Center', 'publish', ENC)
    await add('Root', 'linked_only', ENC)
    await add('Power', 'linked_only', ENC)
    await add('Keyless', 'linked_only', null)
    await add('Sleeping', 'linked_only', ENC, false)
    await rowsOf(`select admin_set_provider_routing($1, $2, true)`, [admin, ids.Center])
    await rowsOf(`update providers set health_status = 'healthy', provider_balance = 2.9999 where id = $1`, [ids.Center])
  }, 180_000)

  it('service role only; an admin is checked again inside', async () => {
    for (const fn of ['admin_set_arbitrage_mode(uuid, boolean, jsonb)', 'admin_arbitrage_status(uuid)', 'arbitrage_donors_json()']) {
      const g = (await rowsOf(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, has_function_privilege('service_role', '${fn}', 'execute') s`))[0]
      expect([g.a, g.u, g.s]).toEqual([false, false, true])
    }
    await expect(rowsOf(`select admin_set_arbitrage_mode($1, true, '[]')`, [user])).rejects.toThrow(/forbidden/)
    await expect(rowsOf(`select admin_arbitrage_status($1)`, [user])).rejects.toThrow(/forbidden/)
    await expect(rowsOf(`select admin_set_arbitrage_mode($1, true, '{}')`, [admin])).rejects.toThrow(/readings must be an array/)
    await expect(rowsOf(`select admin_set_arbitrage_mode($1, null, '[]')`, [admin])).rejects.toThrow(/enabled is required/)
  })

  it('enabled: true switches on every active donor with a key, stores the live balance, leaves the primary alone', async () => {
    const r = await setMode(true, [
      { id: ids.Root, ok: true, balance: 0, currency: 'USD' }, // empty balance: still ready, the router falls back to the primary
      { id: ids.Power, ok: false }, // panel did not answer
    ])
    expect(r.enabled).toBe(true)
    expect(await provider('Root')).toMatchObject({ routing_enabled: true, health_status: 'healthy', provider_balance: '0.0000' })
    expect((await provider('Root')).last_balance_sync).not.toBeNull()
    expect(await provider('Power')).toMatchObject({ routing_enabled: true, health_status: 'unavailable' })
    expect((await provider('Power')).last_balance_sync).toBeNull() // no reading: the balance is not touched
    expect(await provider('Keyless')).toMatchObject({ routing_enabled: false })
    expect(await provider('Sleeping')).toMatchObject({ routing_enabled: false })
    expect(await provider('Center')).toMatchObject({ routing_enabled: true, health_status: 'healthy', provider_balance: '2.9999' })
    expect((r.skipped as { name: string; reason: string }[]).map((s) => [s.name, s.reason]).sort()).toEqual([['Keyless', 'no_api_key'], ['Sleeping', 'inactive']])
    const donors = r.donors as Record<string, unknown>[]
    expect(donors.map((d) => d.name)).toEqual(['Keyless', 'Power', 'Root', 'Sleeping']) // the primary is never a donor
    expect(donors.find((d) => d.name === 'Root')).toMatchObject({ active_offers: 0, has_api_key: true })
    expect(JSON.stringify(r)).not.toContain('v1:') // no key, not even encrypted
  })

  it('a balance reading updates the stored balance; a malformed one is ignored', async () => {
    await setMode(true, [{ id: ids.Root, ok: true, balance: 41.75, currency: 'EUR' }, { id: ids.Power, ok: true, balance: 'lots' }])
    expect(await provider('Root')).toMatchObject({ provider_balance: '41.7500', currency: 'EUR', health_status: 'healthy' })
    expect(await provider('Power')).toMatchObject({ routing_enabled: true, health_status: 'healthy' })
    expect((await provider('Power')).last_balance_sync).toBeNull()
  })

  it('enabled: false switches every donor off at once (health disabled) and keeps only the primary', async () => {
    const r = await setMode(false)
    expect(r.enabled).toBe(false)
    for (const name of ['Root', 'Power', 'Keyless', 'Sleeping']) expect(await provider(name)).toMatchObject({ routing_enabled: false, health_status: 'disabled' })
    expect(await provider('Center')).toMatchObject({ routing_enabled: true, health_status: 'healthy' })
    const status = (await rowsOf(`select admin_arbitrage_status($1) r`, [admin]))[0].r as { primary: Record<string, unknown>[]; donors: Record<string, unknown>[] }
    expect(status.primary).toEqual([{ id: ids.Center, name: 'Center', routing_enabled: true, health_status: 'healthy' }])
    expect(status.donors.every((d) => d.routing_enabled === false)).toBe(true)
  })

  it('every switch is one audit entry with what changed', async () => {
    const log = await rowsOf(`select target_id, details from admin_audit_log where action = 'set_arbitrage_mode' order by created_at, id`)
    expect(log.map((l) => l.target_id)).toEqual(expect.arrayContaining(['on', 'off']))
    const off = log.filter((l) => l.target_id === 'off').at(-1)!.details as { changes: { name: string }[] }
    expect(off.changes.map((c) => c.name).sort()).toEqual(['Power', 'Root'])
  })
})

const donor = (over: Partial<ArbitrageDonor> = {}): ArbitrageDonor => ({
  id: 'd', name: 'D', isActive: true, routingEnabled: false, healthStatus: 'disabled', balance: 0, currency: 'USD', lastBalanceSync: null,
  hasApiKey: true, activeOffers: 0, ready: false, ...over,
})
const status = (donors: ArbitrageDonor[]): ArbitrageStatus => ({
  enabled: donors.some((d) => d.routingEnabled), donors, primary: [{ id: 'p', name: 'SMM Center', routingEnabled: true, healthStatus: 'healthy' }],
})

describe('arbitrageView (card texts)', () => {
  const three = [donor({ id: '1', name: 'RootPanel', activeOffers: 26 }), donor({ id: '2', name: 'SMMPWR', activeOffers: 11 }), donor({ id: '3', name: 'SMMStone', activeOffers: 12 })]

  it('off: one network, the button switches all three on', () => {
    const v = arbitrageView(status(three))
    expect(v).toMatchObject({
      mode: 'off', title: 'Режим Smart Arbitrage (3 донорские сети · 49 лучших офферов)', status: 'Активна 1 сеть (SMM Center)',
      enableLabel: 'Включить все 3 сети (Лучшие цены)', disableLabel: null,
    })
  })

  it('on: every network, the button goes back to the primary only', () => {
    const v = arbitrageView(status(three.map((d) => ({ ...d, routingEnabled: true, healthStatus: 'healthy' as const, ready: true }))))
    expect(v).toMatchObject({ mode: 'on', status: 'Активен Smart Arbitrage (все сети)', enableLabel: null, disableLabel: 'Оставить только 1 сеть (SMM Center)' })
  })

  it('partial (one switched on by hand): both buttons', () => {
    const v = arbitrageView(status([{ ...three[0], routingEnabled: true }, three[1], three[2]]))
    expect(v).toMatchObject({ mode: 'partial', status: 'Smart Arbitrage частично: включено 1 из 3 сетей' })
    expect(v.enableLabel).not.toBeNull()
    expect(v.disableLabel).not.toBeNull()
  })

  it('a donor without a key is not counted as switchable', () => {
    const v = arbitrageView(status([three[0], { ...three[1], hasApiKey: false }]))
    expect(v.enableLabel).toBe('Включить все 1 сеть (Лучшие цены)')
  })
})

describe('client', () => {
  const session = (over: Partial<AuthSession> = {}): AuthSession => ({
    token: 'jwt-token', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' },
    user: { id: 'u1', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: true }, ...over,
  })
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('SET_ARBITRAGE_MODE posts the switch and returns the summary', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, enabled: true, skipped: [], donors: [donor({ routingEnabled: true, ready: true })] }), { status: 200 }))
    const { setArbitrageMode } = await import('../src/services/api/admin-providers')
    const r = await setArbitrageMode(session(), true)
    expect(r.donors[0].ready).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('https://proj.supabase.co/functions/v1/admin-providers')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'SET_ARBITRAGE_MODE', enabled: true })
  })

  it('dev mock mode follows the server rules: only donors with a key move, the primary stays', () => {
    const m = createMockProviders()
    const on = m.setArbitrageMode(true)
    expect(on.skipped).toEqual([{ id: 'demo-prov-3', name: 'New panel (demo)', reason: 'no_api_key' }])
    expect(m.arbitrageStatus()).toMatchObject({ enabled: true, primary: [{ name: 'Secsers (demo)', routingEnabled: true }] })
    m.setArbitrageMode(false)
    expect(m.arbitrageStatus().donors.every((d) => !d.routingEnabled && d.healthStatus === 'disabled')).toBe(true)
    expect(m.arbitrageStatus().primary[0].routingEnabled).toBe(true)
  })
})
