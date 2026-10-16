// @vitest-environment jsdom
// Smart Arbitrage autopilot (migration 20261204000000): the fingerprint, the matcher, the admin decisions, the request parser, the sync step.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mapProviderError, parseProviderRequest, toCandidateDto } from '../supabase/functions/_shared/admin-providers.ts'
import { syncProviderCatalog, type CatalogStore } from '../supabase/functions/_shared/catalog-sync-run.ts'
import { silentLogger } from '../supabase/functions/_shared/logger.ts'
import { ArbitrageCandidates } from '../src/components/admin/ArbitrageCandidates'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let db: PGlite
const fp = async (name: string) => (await db.query<{ f: Record<string, string> }>(`select service_fingerprint($1) f`, [name])).rows[0].f

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
}, 180_000)
afterAll(async () => { await db.close() })

describe('service_fingerprint', () => {
  it('keeps what is delivered, drops how fast it is delivered', async () => {
    expect(await fp('Telegram Members [Refill: 30D] [Start Time: 0 - 1 Hr] [Max: 30K] [Speed: 20K/D] 💧⛔')).toEqual({ base: 'telegram members', tags: '', refill: '30' })
    expect(await fp('Telegram Members [refill: 30 days]')).toEqual({ base: 'telegram members', tags: '', refill: '30' })
    expect(await fp('🇮🇷 Telegram Members [Iran] [Real] [Refill: No] [Max: 400K]')).toEqual({ base: 'telegram members', tags: 'iran,real', refill: '0' })
  })

  it('guarantees: lifetime, months / years, R30, none, unclear', async () => {
    expect((await fp('X [Refill: Lifetime]')).refill).toBe('life')
    expect((await fp('X [Lifetime Guaranteed]')).refill).toBe('life')
    expect((await fp('X [Refill: 1 Year]')).refill).toBe('365')
    expect((await fp('X [R30]')).refill).toBe('30')
    expect((await fp('X [No Refill]')).refill).toBe('0')
    expect((await fp('X [Refill: No Drop]')).refill).toBe('unknown') // "low drop" is not "no guarantee"
    expect((await fp('X [Refill]')).refill).toBe('unknown')
    expect((await fp('X')).refill).toBe('unstated')
  })

  it('a bracket with several facts is split; an emoji that IS the product stays, flags and markers go', async () => {
    expect(await fp('🇩🇰 Spotify Plays ➜ [Denmark] [ Cheap | 10-20K/Day | Refill : Lifetime ]')).toEqual({ base: 'spotify plays', tags: 'cheap,denmark', refill: 'life' })
    expect(await fp('Facebook [👍] Post Reactions ➜ [Cheap | Fast | Refill : 30 Days] ♻️')).toEqual({ base: 'facebook post reactions', tags: 'cheap,fast,👍', refill: '30' })
  })
})

describe('the matcher', () => {
  const P = { center: '00000000-0000-4000-8000-0000000a0001', jap: '00000000-0000-4000-8000-0000000a0002', off: '00000000-0000-4000-8000-0000000a0003' }
  let admin: string, cat: string, seq = 0
  const ps = async (provider: string, name: string, rate: number, o: { min?: number; max?: number; refill?: boolean } = {}) =>
    (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity, refill_supported)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`, [provider, `e${++seq}`, name, rate, o.min ?? 10, o.max ?? 100000, o.refill ?? false])).rows[0].id
  /** A storefront service sold through SMM Center at `cost`. */
  const service = async (name: string, cost: number, o: { min?: number; max?: number; refill?: boolean } = {}) => {
    const source = await ps(P.center, `RU ${name}`, cost)
    return (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, refill_supported)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`, [cat, name, source, cost * 2, o.min ?? 100, o.max ?? 10000, o.refill ?? false])).rows[0].id
  }
  const refresh = async (interval = 0) => (await db.query<{ r: Record<string, number | boolean> }>(`select refresh_arbitrage_candidates(0.25, 500, $1) r`, [interval])).rows[0].r
  const candidate = async (svc: string) => (await db.query<{ status: string; mismatches: string[]; ps: string; offer_id: string | null }>(
    `select status, mismatches, provider_service_id ps, offer_id from arbitrage_candidates where service_id = $1`, [svc])).rows
  const offers = async (svc: string) => (await db.query<{ ps: string }>(`select provider_service_id ps from provider_service_offers where service_id = $1 order by cost_per_1000`, [svc])).rows.map((r) => r.ps)

  let exact: string, exactDonor: string, details: string, refillBtn: string, limits: string, small: string, offOnly: string
  beforeAll(async () => {
    await db.exec(`insert into providers (id, name, api_url, routing_enabled, catalog_mode) values
      ('${P.center}', 'SMM Center', 'https://c', true, 'publish'), ('${P.jap}', 'JAP', 'https://j', true, 'linked_only'), ('${P.off}', 'Off', 'https://o', false, 'linked_only')`)
    cat = (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug='telegram'), 'C', 'c') returning id`)).rows[0].id
    admin = (await db.query<{ id: string }>(`insert into users(telegram_id, is_admin) values (90001, true) returning id`)).rows[0].id

    exact = await service('Telegram Members [refill: 30 days] [Iran]', 1.0)
    exactDonor = await ps(P.jap, '🇮🇷 Telegram Members [IRAN] [Refill: 30D] [Max: 50K] [Speed: 5K/D] 💧', 0.5, { min: 10, max: 50000 })
    await ps(P.jap, 'Telegram Members [Iran] [Refill: 30D] [Low Quality]', 0.2) // cheaper, but "low quality": in doubt

    details = await service('Instagram Likes [refill: 30 days] [India]', 1.0)
    await ps(P.jap, 'Instagram Likes [INDIA] [Bots] [Refill: 30D]', 0.3)

    refillBtn = await service('YouTube Views [refill: 90 days]', 1.0, { refill: true })
    await ps(P.jap, 'Youtube Views [Refill: 90D]', 0.3, { refill: false }) // our refill button needs a panel that does refills

    limits = await service('TikTok Saves [refill: 30 days]', 1.0, { min: 100, max: 10000 })
    await ps(P.jap, 'TikTok Saves [Refill: 30D]', 0.3, { min: 10, max: 5000 }) // cannot take our biggest order

    small = await service('Twitter Likes [refill: 30 days]', 1.0)
    await ps(P.jap, 'Twitter Likes [Refill: 30D]', 0.8) // only 20% cheaper

    offOnly = await service('Spotify Plays [refill: lifetime]', 1.0)
    await ps(P.off, 'Spotify Plays [Refill: Lifetime]', 0.1) // donor with routing off
  }, 60_000)

  it('links only the exact cheaper pair; everything else waits with its reasons', async () => {
    const r = await refresh()
    expect(r).toMatchObject({ auto_linked: 1 })
    expect(await offers(exact)).toEqual([exactDonor, expect.any(String)])
    expect(await candidate(exact)).toEqual([expect.objectContaining({ status: 'auto_linked', ps: exactDonor, mismatches: [] })])
    expect(await candidate(details)).toEqual([expect.objectContaining({ status: 'pending', mismatches: ['details'] })])
    expect(await candidate(refillBtn)).toEqual([expect.objectContaining({ status: 'pending', mismatches: ['refill'] })])
    expect(await candidate(limits)).toEqual([expect.objectContaining({ status: 'pending', mismatches: ['limits'] })])
    expect(await candidate(small)).toEqual([])
    expect(await candidate(offOnly)).toEqual([])
    expect((await offers(details)).length).toBe(1) // nothing in doubt is ever linked by itself
  })

  it('a second run changes nothing; within the interval it is skipped', async () => {
    expect(await refresh()).toMatchObject({ auto_linked: 0 })
    expect(await refresh(55)).toEqual({ skipped: true })
  })

  it('admin: approve links, reject is final, removing an automatic link keeps it out', async () => {
    const id = async (svc: string) => (await db.query<{ id: string }>(`select id from arbitrage_candidates where service_id = $1`, [svc])).rows[0].id
    const decide = (cid: string, approve: boolean) => db.query(`select admin_decide_arbitrage_candidate($1, $2, $3) r`, [admin, cid, approve])
    await decide(await id(limits), true)
    expect((await offers(limits)).length).toBe(2)
    expect((await candidate(limits))[0].status).toBe('approved')
    await decide(await id(details), false)
    await decide(await id(exact), false) // the automatic link is switched off
    expect((await offers(exact)).length).toBe(1)
    await refresh()
    expect((await candidate(details))[0].status).toBe('rejected')
    expect((await offers(exact)).length).toBe(1)
    // the rejected pair stays out; the donor's other (low quality) offer for that service is now proposed, never linked by itself
    expect(await candidate(exact)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ps: exactDonor, status: 'rejected' }),
      expect.objectContaining({ status: 'pending', mismatches: ['details'] }),
    ]))
    const list = (await db.query<{ r: { items: unknown[]; counts: Record<string, number> } }>(`select admin_arbitrage_candidates($1, 'rejected') r`, [admin])).rows[0].r
    expect(list.counts).toMatchObject({ rejected: 2, approved: 1, pending: 2 })
    expect(list.items).toHaveLength(2)
  })

  it('pg_cron runs it hourly, or at once after an admin asked (the button only queues)', async () => {
    const run = async () => (await db.query<{ r: Record<string, unknown> }>(`select run_arbitrage_matcher() r`)).rows[0].r
    expect(await run()).toEqual({ skipped: true }) // ran a moment ago
    expect((await db.query<{ r: Record<string, unknown> }>(`select admin_refresh_arbitrage($1) r`, [admin])).rows[0].r).toEqual({ queued: true })
    expect(await run()).toHaveProperty('auto_linked')
    expect(await run()).toEqual({ skipped: true })
    await db.query(`update arbitrage_state set refreshed_at = now() - interval '56 minutes'`)
    expect(await run()).toHaveProperty('pending')
  })

  it('only admins (through the service role)', async () => {
    const user = (await db.query<{ id: string }>(`insert into users(telegram_id) values (90002) returning id`)).rows[0].id
    await expect(db.query(`select admin_arbitrage_candidates($1)`, [user])).rejects.toThrow(/forbidden/)
    await expect(db.query(`select admin_refresh_arbitrage($1)`, [user])).rejects.toThrow(/forbidden/)
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['refresh_arbitrage_candidates(numeric, integer, integer)', 'admin_arbitrage_candidates(uuid, text, integer, integer)', 'admin_decide_arbitrage_candidate(uuid, uuid, boolean)', 'admin_refresh_arbitrage(uuid)', 'run_arbitrage_matcher()', 'service_fingerprint(text)']) {
        expect((await db.query<{ p: boolean }>(`select has_function_privilege('${role}', 'public.${fn}', 'execute') p`)).rows[0].p).toBe(false)
      }
      expect((await db.query<{ p: boolean }>(`select has_table_privilege('${role}', 'public.arbitrage_candidates', 'select') p`)).rows[0].p).toBe(false)
    }
  })
})

describe('admin-providers requests', () => {
  const ID = '11111111-1111-4111-8111-111111111111'
  it('parses the three new actions', () => {
    expect(parseProviderRequest({ action: 'arbitrage_candidates' })).toEqual({ action: 'ARBITRAGE_CANDIDATES', status: 'pending', offset: 0 })
    expect(parseProviderRequest({ action: 'ARBITRAGE_CANDIDATES', status: 'auto_linked', offset: 50 })).toEqual({ action: 'ARBITRAGE_CANDIDATES', status: 'auto_linked', offset: 50 })
    expect(parseProviderRequest({ action: 'ARBITRAGE_CANDIDATES', status: 'all' })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'DECIDE_CANDIDATE', id: ID, approve: true })).toEqual({ action: 'DECIDE_CANDIDATE', id: ID, approve: true })
    expect(parseProviderRequest({ action: 'DECIDE_CANDIDATE', id: 'x', approve: true })).toHaveProperty('error')
    expect(parseProviderRequest({ action: 'RUN_ARBITRAGE_MATCH' })).toEqual({ action: 'RUN_ARBITRAGE_MATCH' })
  })
  it('maps the decision errors and the row', () => {
    expect(mapProviderError('candidate_not_pending: it is approved')).toMatchObject({ status: 409 })
    expect(mapProviderError('already_linked: x')).toMatchObject({ status: 409 })
    expect(mapProviderError('candidate_not_found: x')).toMatchObject({ status: 404 })
    expect(toCandidateDto({ id: 'c', status: 'pending', saving: '0.4', mismatches: ['refill'], current_cost: '1', donor_cost: '0.6', service_id: 's', service_name: 'S', service_min: 10, service_max: 100, donor_name: 'D', donor_external_id: '7', donor_min: 1, donor_max: 1000, provider_name: 'JAP' }))
      .toEqual({ id: 'c', status: 'pending', saving: 0.4, mismatches: ['refill'], currentCost: 1, donorCost: 0.6, service: { id: 's', name: 'S', min: 10, max: 100 }, donor: { name: 'D', externalId: '7', min: 1, max: 1000, provider: 'JAP' } })
  })
})

describe('the sync runs the matcher', () => {
  it('after a provider run, reports what it did, and never fails the sync', async () => {
    const one = { externalServiceId: '1', name: 'A', type: 'Default', categoryRaw: 'c', ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, cancelSupported: false }
    const adapter = { getServices: async () => [one], getBalance: async () => ({ balance: 1, currency: 'USD' }) }
    const store = (refreshArbitrage: CatalogStore['refreshArbitrage']): CatalogStore => ({
      loadProviderServices: async () => [], upsertProviderServices: async () => [], flagAnomaly: async () => {}, loadOffers: async () => [], updateOffers: async () => {},
      deactivateProviderServices: async () => {}, loadLinkedServices: async () => [], loadServiceOffers: async () => [], updateServices: async () => {},
      saveBalance: async () => {}, refreshArbitrage,
    } as unknown as CatalogStore)
    const provider = { id: 'p', name: 'JAP', routing_enabled: true, catalog_mode: 'linked_only' as const }
    expect(await syncProviderCatalog({ provider, adapter, store: store(async () => ({ auto_linked: 3, pending: 9 })), rules: [], log: silentLogger })).toMatchObject({ status: 'ok', arbitrage: { autoLinked: 3, pending: 9 } })
    expect(await syncProviderCatalog({ provider, adapter, store: store(async () => ({ skipped: true })), rules: [], log: silentLogger })).not.toHaveProperty('arbitrage')
    expect((await syncProviderCatalog({ provider, adapter, store: store(async () => { throw new Error('down') }), rules: [], log: silentLogger })).status).toBe('ok')
  })
})

describe('admin list', () => {
  it('renders the tabs and an empty list in demo mode', async () => {
    const session = { token: '', expiresAt: 0, isMock: true, wallet: { balance: 0, currency: 'USD' }, user: { id: 'a', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'ru', isAdmin: true } }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(createElement(ArbitrageCandidates, { session })))
    await vi.waitFor(() => expect(host.textContent).toContain('Пусто.'))
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['На проверку', 'Подключены сами', 'Одобрены', 'Отклонены'])
    act(() => root.unmount())
  })
})
