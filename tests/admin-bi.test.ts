import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BI_RETENTION_DAYS, BI_TOP_SERVICES, biWindow, handleAdminBi, parseBiRequest, toFunnel, toRetention, toRevenue, toTopServices } from '../supabase/functions/_shared/admin-bi'
import { barPercents, formatRate, noSales, overallRetention, revenueTotals, shortDay } from '../src/lib/bi-view'
import type { BiResponse, RetentionCohort, RevenueDay } from '../src/types/admin-bi'
import type { AuthSession } from '../src/services/api/auth'

describe('request and window', () => {
  it('days: 7, 30 or 90, default 30; nothing else', () => {
    expect(parseBiRequest({ action: 'BI' })).toEqual({ ok: true, days: 30 })
    expect(parseBiRequest({ action: 'BI', days: 7 })).toEqual({ ok: true, days: 7 })
    expect(parseBiRequest({ action: 'BI', days: 90 })).toEqual({ ok: true, days: 90 })
    for (const days of [0, 1, 14, 365, '30', -7, 7.5, Number.NaN, {}, []]) expect(parseBiRequest({ action: 'BI', days })).toMatchObject({ ok: false })
    for (const body of [null, 5, 'x', []]) expect(parseBiRequest(body)).toMatchObject({ ok: false })
  })

  it('the window is the last N UTC days including today, ending now', () => {
    const now = new Date('2026-10-09T15:30:00Z')
    expect(biWindow(7, now)).toEqual({ from: '2026-10-03T00:00:00.000Z', to: '2026-10-09T15:30:01.000Z' })
    expect(biWindow(30, now).from).toBe('2026-09-10T00:00:00.000Z')
    expect(biWindow(90, new Date('2026-03-01T00:00:00Z')).from).toBe('2025-12-02T00:00:00.000Z')
  })
})

describe('answer mapping', () => {
  it('maps the SQL json (snake_case, numeric strings) to numbers and camelCase', () => {
    expect(toFunnel({ steps: [{ step: 'catalog_view', users: '4', rate_from_previous: null, rate_from_first: 100 }, { step: 'checkout_started', users: 2, rate_from_previous: '50.00', rate_from_first: 50 }] }))
      .toEqual([{ step: 'catalog_view', users: 4, rateFromPrevious: null, rateFromFirst: 100 }, { step: 'checkout_started', users: 2, rateFromPrevious: 50, rateFromFirst: 50 }])
    expect(toRevenue([{ day: '2026-05-10', orders: 2, revenue: '6.4', cost: 3.2, margin: 3.2, aov: null }])).toEqual([{ day: '2026-05-10', orders: 2, revenue: 6.4, cost: 3.2, margin: 3.2, aov: null }])
    expect(toRetention([{ cohort: '2026-01-10', size: 3, retention: [{ day: 1, users: 2, rate: 66.67 }, { day: 7, users: null, rate: null }] }]))
      .toEqual([{ cohort: '2026-01-10', size: 3, retention: [{ day: 1, users: 2, rate: 66.67 }, { day: 7, users: null, rate: null }] }])
    expect(toTopServices([{ service_id: 's1', name: 'Views', orders: 2, units: 2000, revenue: 8, margin: 4, aov: 4 }])).toEqual([{ serviceId: 's1', name: 'Views', orders: 2, units: 2000, revenue: 8, margin: 4, aov: 4 }])
  })

  it('garbage from the database becomes empty sections, never an exception', () => {
    for (const bad of [null, undefined, 5, 'x', {}, { steps: 'no' }, [null, 1]]) {
      expect(() => { toFunnel(bad); toRevenue(bad); toRetention(bad); toTopServices(bad) }).not.toThrow()
    }
    expect(toFunnel(null)).toEqual([])
    expect(toRevenue('x')).toEqual([])
  })
})

describe('access control and querying (handleAdminBi)', () => {
  const NOW = () => new Date('2026-10-09T12:00:00Z')
  const ok = (data: unknown) => Promise.resolve({ data, error: null })
  const make = (over: { admin?: boolean | 'throw'; rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> } = {}) => {
    const rpc = vi.fn(over.rpc ?? ((fn: string) => ok(fn === 'bi_funnel' ? { steps: [] } : [])))
    const adminCheck = vi.fn(async () => {
      if (over.admin === 'throw') throw new Error('db down')
      return over.admin ?? true
    })
    return { rpc, adminCheck, deps: { adminCheck, rpc, now: NOW } }
  }

  it('a regular user gets 403 and the database is never queried', async () => {
    const { deps, rpc } = make({ admin: false })
    const r = await handleAdminBi({ action: 'BI', days: 30 }, deps)
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ success: false, error: 'forbidden' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('the 403 comes before input validation: a stranger learns nothing about the request format', async () => {
    const { deps, rpc } = make({ admin: false })
    expect((await handleAdminBi({ action: 'BI', days: 'garbage' }, deps)).status).toBe(403)
    expect((await handleAdminBi(null, deps)).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('if the admin lookup itself fails, nobody gets data (500, no query)', async () => {
    const { deps, rpc } = make({ admin: 'throw' })
    expect((await handleAdminBi({ action: 'BI' }, deps)).status).toBe(500)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('an admin with a bad range gets 400 and no query', async () => {
    const { deps, rpc } = make()
    const r = await handleAdminBi({ action: 'BI', days: 14 }, deps)
    expect(r).toMatchObject({ status: 400, body: { error: 'invalid_input' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('queries the four aggregations TOGETHER over the window, with the retention days and the top-services limit', async () => {
    const started: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { deps, rpc } = make({ rpc: async (fn) => { started.push(fn); await gate; return { data: fn === 'bi_funnel' ? { steps: [] } : [], error: null } } })
    const pending = handleAdminBi({ action: 'BI', days: 7 }, deps)
    await new Promise((r) => setTimeout(r, 10))
    // all four are in flight before any has answered: parallel, not one after another
    expect(started.sort()).toEqual(['bi_funnel', 'bi_retention', 'bi_revenue_daily', 'bi_top_services'])
    release()
    const r = await pending
    expect(r.status).toBe(200)
    const window = { p_from: '2026-10-03T00:00:00.000Z', p_to: '2026-10-09T12:00:01.000Z' }
    expect(rpc).toHaveBeenCalledWith('bi_funnel', window)
    expect(rpc).toHaveBeenCalledWith('bi_revenue_daily', window)
    expect(rpc).toHaveBeenCalledWith('bi_retention', { ...window, p_days: BI_RETENTION_DAYS })
    expect(rpc).toHaveBeenCalledWith('bi_top_services', { ...window, p_limit: BI_TOP_SERVICES })
    expect(r.status === 200 && r.body).toMatchObject({ success: true, days: 7, from: window.p_from, to: window.p_to })
  })

  it('one failing aggregation shows as an error on its own section; the others still arrive', async () => {
    const { deps } = make({ rpc: async (fn) => (fn === 'bi_retention' ? { data: null, error: { message: 'boom: internal detail' } } : { data: fn === 'bi_funnel' ? { steps: [] } : [], error: null }) })
    const r = await handleAdminBi({ action: 'BI' }, deps)
    expect(r.status).toBe(200)
    const body = (r as { body: BiResponse }).body
    expect(body.retention).toEqual({ error: 'This section could not be loaded.' })
    expect(body.funnel).toEqual({ data: [] })
    expect(JSON.stringify(body)).not.toContain('internal detail') // database messages never reach the client
  })

  it('a rejected call is a failed section too; only when all four fail is the request a 500', async () => {
    const { deps } = make({ rpc: async (fn) => { if (fn === 'bi_funnel') throw new Error('network'); return { data: [], error: null } } })
    const partial = await handleAdminBi({ action: 'BI' }, deps)
    expect(partial.status).toBe(200)
    expect((partial as { body: BiResponse }).body.funnel).toEqual({ error: 'This section could not be loaded.' })

    const all = make({ rpc: async () => ({ data: null, error: { message: 'down' } }) })
    expect((await handleAdminBi({ action: 'BI' }, all.deps)).status).toBe(500)
  })

  it('the Edge Function authenticates, then hands the BI request to this core (which checks the admin role before any query)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/admin-analytics/index.ts'), 'utf8')
    expect(src.indexOf('authenticate(req, jwtSecret)')).toBeGreaterThan(-1)
    expect(src.indexOf('authenticate(req, jwtSecret)')).toBeLessThan(src.indexOf('handleAdminBi('))
    expect(src).toMatch(/is_admin', true\)\.eq\('is_banned', false\)/)
    expect(src).toContain("fail(401, 'unauthorized'")
    // the profit analytics keep their own admin check
    expect(src).toContain("fail(403, 'forbidden', 'Admin access required.')")
    // the bi_* functions are service-role only: they are called with the service client, never the caller's token
    const bi = src.slice(src.indexOf('handleAdminBi('), src.indexOf('const { data: admin, error: adminError }'))
    expect(bi).toContain('db.rpc(fn, args)')
    expect(bi).not.toContain('asUser')
  })
})

describe('display maths', () => {
  const day = (d: string, orders: number, revenue: number, cost: number): RevenueDay => ({ day: d, orders, revenue, cost, margin: revenue - cost, aov: orders ? revenue / orders : null })

  it('totals: revenue, margin, margin %, orders and the order-weighted AOV', () => {
    const t = revenueTotals([day('2026-05-10', 2, 6.4, 3.2), day('2026-05-11', 0, 0, 0), day('2026-05-12', 2, 24, 12)])
    expect(t).toEqual({ orders: 4, revenue: 30.4, cost: 15.2, margin: 15.2, aov: 7.6, marginPercent: 50 })
    expect(revenueTotals([])).toEqual({ orders: 0, revenue: 0, cost: 0, margin: 0, aov: null, marginPercent: null })
  })

  it('bars are relative to the biggest day; a non-zero day is always visible; zero is zero', () => {
    expect(barPercents([10, 5, 0, 0.01])).toEqual([100, 50, 0, 2])
    expect(barPercents([0, 0])).toEqual([0, 0])
    expect(barPercents([])).toEqual([])
  })

  it('formats days and rates; knows when nothing was sold', () => {
    expect(shortDay('2026-05-09')).toBe('05-09')
    expect(formatRate(null)).toBe('–')
    expect(formatRate(50)).toBe('50%')
    expect(formatRate(66.67)).toBe('66.7%')
    expect(noSales([day('a', 0, 0, 0)])).toBe(true)
    expect(noSales([day('a', 0, 0, 0), day('b', 1, 1, 0)])).toBe(false)
  })

  it('overall retention is weighted by cohort size and ignores cohorts too young for the day', () => {
    const c = (cohort: string, size: number, d1: number | null, d7: number | null): RetentionCohort => ({ cohort, size, retention: [{ day: 1, users: d1, rate: null }, { day: 7, users: d7, rate: null }] })
    expect(overallRetention([c('a', 10, 5, 2), c('b', 30, 6, null)])).toEqual([
      { day: 1, users: 11, size: 40, rate: 27.5 },
      { day: 7, users: 2, size: 10, rate: 20 },
    ])
    expect(overallRetention([c('a', 5, null, null)])).toEqual([])
    expect(overallRetention([])).toEqual([])
  })
})

describe('client', () => {
  const fetchMock = vi.fn()
  const session = (admin = true, isMock = false): AuthSession => ({ token: 'jwt-token', expiresAt: 0, isMock, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: admin } })
  const section = { data: [] }
  const okBody = { success: true, days: 30, from: 'a', to: 'b', funnel: section, revenue: section, retention: section, topServices: section }

  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const load = () => import('../src/services/api/admin-bi')
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

  it('posts the BI action with the range and the user JWT', async () => {
    reply(200, okBody)
    const { getBiDashboard } = await load()
    expect(await getBiDashboard(session(), 90)).toMatchObject({ success: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/admin-analytics')
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
    expect(JSON.parse(init.body)).toEqual({ action: 'BI', days: 90 })
  })

  it('403 and 401 are "forbidden"; a malformed or partial answer is a server error, not a half-rendered dashboard', async () => {
    const { getBiDashboard } = await load()
    reply(403, { success: false, error: 'forbidden' })
    await expect(getBiDashboard(session(false), 30)).rejects.toMatchObject({ code: 'forbidden' })
    reply(401, { success: false })
    await expect(getBiDashboard(session(), 30)).rejects.toMatchObject({ code: 'forbidden' })
    reply(200, { success: true, funnel: section })
    await expect(getBiDashboard(session(), 30)).rejects.toMatchObject({ code: 'server' })
    reply(500, { success: false })
    await expect(getBiDashboard(session(), 30)).rejects.toMatchObject({ code: 'server' })
    fetchMock.mockRejectedValueOnce(new TypeError('failed'))
    await expect(getBiDashboard(session(), 30)).rejects.toMatchObject({ code: 'network' })
  })

  it('dev mock: an admin gets demo data in the real shape, a non-admin is refused', async () => {
    const { getBiDashboard } = await load()
    const r = await getBiDashboard(session(true, true), 7)
    expect(r.revenue).toMatchObject({ data: expect.any(Array) })
    expect(r.revenue && 'data' in r.revenue && r.revenue.data).toHaveLength(7)
    await expect(getBiDashboard(session(false, true), 7)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
