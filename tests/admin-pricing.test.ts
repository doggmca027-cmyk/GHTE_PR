import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { affectedServices, parsePricingRequest, repriceServices, type RepriceService } from '../supabase/functions/_shared/admin-pricing.ts'
import { calculateCustomerRate } from '../supabase/functions/_shared/price-engine.ts'
import { pricingHealth } from '../src/lib/admin-view'
import { createMockPricing } from '../src/services/api/mock-pricing'

const SVC = '11111111-1111-4111-8111-111111111111'
const CAT = '22222222-2222-4222-8222-222222222222'

describe('parsePricingRequest', () => {
  it('defaults to GET and accepts a valid UPDATE_RULE', () => {
    expect(parsePricingRequest({})).toEqual({ action: 'GET' })
    expect(parsePricingRequest({ action: 'get' })).toEqual({ action: 'GET' })
    expect(parsePricingRequest({ action: 'UPDATE_RULE', serviceId: SVC, type: 'percentage', value: 150.456 })).toEqual({
      action: 'UPDATE_RULE', serviceId: SVC, categoryId: null, platform: null, type: 'percentage', value: 150.46,
    })
    expect(parsePricingRequest({ action: 'UPDATE_RULE', type: 'fixed', value: 0 })).toMatchObject({ serviceId: null, categoryId: null, platform: null })
    expect(parsePricingRequest({ action: 'UPDATE_RULE', platform: 'telegram', type: 'fixed', value: 1 })).toMatchObject({ platform: 'telegram' })
  })

  it.each([
    [null], [[]], ['x'],
    [{ action: 'DROP' }],
    [{ action: 'UPDATE_RULE', type: 'tier', value: 1 }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: -1 }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: 100_001 }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: '5' }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: Number.NaN }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: 1, serviceId: 'nope' }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: 1, platform: 'myspace' }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: 1, serviceId: SVC, categoryId: CAT }],
    [{ action: 'UPDATE_RULE', type: 'fixed', value: 1, serviceId: 5 }],
  ])('rejects %j', (body) => {
    expect(parsePricingRequest(body)).toHaveProperty('error')
  })
})

describe('re-pricing', () => {
  const svc = (id: string, over: Partial<RepriceService> = {}): RepriceService => ({
    id, category_id: CAT, platform: 'telegram', customer_rate_per_1000: 1, provider_rate: 1, ...over,
  })

  it('selects services by scope', () => {
    const all = [svc('a'), svc('b', { category_id: 'other' }), svc('c', { platform: 'tiktok' })]
    expect(affectedServices(all, { serviceId: 'a', categoryId: null, platform: null }).map((s) => s.id)).toEqual(['a'])
    expect(affectedServices(all, { serviceId: null, categoryId: CAT, platform: null }).map((s) => s.id)).toEqual(['a', 'c'])
    expect(affectedServices(all, { serviceId: null, categoryId: null, platform: 'tiktok' }).map((s) => s.id)).toEqual(['c'])
    expect(affectedServices(all, { serviceId: null, categoryId: null, platform: null })).toHaveLength(3)
  })

  it('uses the shared price engine and only returns changed services', () => {
    const rules = [{ id: 'r1', type: 'percentage' as const, value: 100, service_id: 'a', priority: 0 }]
    const changes = repriceServices([svc('a', { provider_rate: 0.5, customer_rate_per_1000: 0.1 }), svc('b', { provider_rate: 0.5, customer_rate_per_1000: 0.51 })], rules)
    // a: +100% -> 1.0 (changed). b: no matching rule -> provider rate + min margin 0.01 = 0.51 (unchanged)
    expect(changes).toEqual([{ id: 'a', rate: calculateCustomerRate(0.5, rules, { serviceId: 'a' }) }])
    expect(changes[0].rate).toBe(1)
  })

  it('a service rule beats a global one, and the margin floor still applies', () => {
    const rules = [
      { id: 'g', type: 'percentage' as const, value: 300, priority: 0 },
      { id: 's', type: 'fixed' as const, value: 0, service_id: 'a', priority: 0 },
    ]
    const [c] = repriceServices([svc('a', { provider_rate: 2, customer_rate_per_1000: 8 })], rules)
    expect(c).toEqual({ id: 'a', rate: 2.01 })
  })
})

describe('PricingTab health', () => {
  it('flags losses, margins under 10% and unknowns', () => {
    expect(pricingHealth({ marginAbsolute: -0.01, marginPercent: -1 })).toBe('loss')
    expect(pricingHealth({ marginAbsolute: 0.05, marginPercent: 9.9 })).toBe('low')
    expect(pricingHealth({ marginAbsolute: 0.1, marginPercent: 10 })).toBe('ok')
    expect(pricingHealth({ marginAbsolute: null, marginPercent: null })).toBe('unknown')
  })
})

describe('mock pricing (dev mode)', () => {
  it('reprices through the shared engine', () => {
    const m = createMockPricing()
    const before = m.list()[0]
    m.setMargin({ serviceId: before.serviceId, type: 'percentage', value: 100 })
    const after = m.list()[0]
    expect(after.customerRate).toBe(1.08)
    expect(after.marginAbsolute).toBeCloseTo(after.customerRate - (after.bestCost ?? 0), 4)
  })
})

// ---------------------------------------------------------------------------
// get_admin_pricing_view (real SQL on PGlite)
// ---------------------------------------------------------------------------

describe('get_admin_pricing_view', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  const asUser = (id: string) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${id}',false)`)
  const view = async () => {
    await asUser(admin)
    const rows = (await db.query<{ v: Record<string, unknown>[] }>(`select get_admin_pricing_view() v`)).rows[0].v
    await db.exec('reset role')
    return rows
  }
  const byName = (rows: Record<string, unknown>[], name: string) => rows.find((r) => r.name === name)!

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))

    const q = async (sql: string, p: unknown[] = []) => (await db.query<{ id: string }>(sql, p)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    banned = await q(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`)

    const pA = await q(`insert into providers(name, api_url, priority) values ('A', 'https://a', 1) returning id`)
    const pB = await q(`insert into providers(name, api_url, priority) values ('B', 'https://b', 1) returning id`)
    const pC = await q(`insert into providers(name, api_url, priority) values ('C', 'https://c', 1) returning id`)
    await db.query(`update providers set health_status = 'healthy', routing_enabled = true where id in ($1, $2)`, [pA, pB])
    await db.query(`update providers set health_status = 'degraded', routing_enabled = true where id = $1`, [pC])
    const cat = await q(`insert into categories(platform, name, slug) values ('telegram', 'Views', 'v') returning id`)

    const ps = async (provider: string, ext: string, rate: number) =>
      q(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, $2, 'x', $3, 1, 1000) returning id`, [provider, ext, rate])
    const mkService = async (name: string, primary: string, rate: number, active = true) =>
      q(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, $4, 1, 1000, $5) returning id`, [cat, name, primary, rate, active])
    const offer = (service: string, provider: string, psId: string, cost: number, score: number, active = true) =>
      db.query(
        `insert into provider_service_offers(service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score, is_active)
         values ($1, $2, $3, $4, 1, 1000, $5, $6) on conflict (service_id, provider_id, provider_service_id) do update set cost_per_1000 = $4, routing_score = $5, is_active = $6`,
        [service, provider, psId, cost, score, active])

    // "score": A (score 100, 0.50) beats cheaper B (score 0, 0.20)
    const a1 = await ps(pA, '1', 0.5), b1 = await ps(pB, '1', 0.2)
    const s1 = await mkService('score', a1, 1.0)
    await offer(s1, pA, a1, 0.5, 100); await offer(s1, pB, b1, 0.2, 0)
    // "tie": equal score, cheaper wins
    const a2 = await ps(pA, '2', 0.4), b2 = await ps(pB, '2', 0.3)
    const s2 = await mkService('tie', a2, 1.0)
    await offer(s2, pA, a2, 0.4, 5); await offer(s2, pB, b2, 0.3, 5)
    // "unhealthy": the high-score offer belongs to a degraded provider and is ignored
    const c3 = await ps(pC, '3', 0.1), b3 = await ps(pB, '3', 0.6)
    const s3 = await mkService('unhealthy', c3, 1.0)
    await offer(s3, pC, c3, 0.1, 100); await offer(s3, pB, b3, 0.6, 1)
    // "loss": retail below cost
    const a4 = await ps(pA, '4', 2)
    const s4 = await mkService('loss', a4, 1.5)
    await offer(s4, pA, a4, 2, 0)
    // "nooffer": only an inactive offer
    const a5 = await ps(pA, '5', 1)
    const s5 = await mkService('nooffer', a5, 1.2)
    await offer(s5, pA, a5, 1, 0, false)
    // inactive service is not listed
    const a6 = await ps(pA, '6', 1)
    await mkService('inactive', a6, 1.2, false)
  }, 120_000)

  it('picks the highest routing score, then the lowest cost, among healthy providers', async () => {
    const rows = await view()
    expect(Number(byName(rows, 'score').best_offer_cost)).toBe(0.5)
    expect(Number(byName(rows, 'score').margin_absolute)).toBe(0.5)
    expect(Number(byName(rows, 'tie').best_offer_cost)).toBe(0.3)
    expect(Number(byName(rows, 'unhealthy').best_offer_cost)).toBe(0.6)
  })

  it('reports negative margins and missing offers', async () => {
    const rows = await view()
    expect(Number(byName(rows, 'loss').margin_absolute)).toBe(-0.5)
    expect(byName(rows, 'nooffer').best_offer_cost).toBeNull()
    expect(byName(rows, 'nooffer').margin_absolute).toBeNull()
  })

  it('lists only active services with category and platform', async () => {
    const rows = await view()
    expect(rows.map((r) => r.name).sort()).toEqual(['loss', 'nooffer', 'score', 'tie', 'unhealthy'])
    expect(byName(rows, 'score')).toMatchObject({ category: 'Views', platform: 'telegram' })
  })

  it('is admin-only', async () => {
    for (const id of [user, banned, '']) {
      await asUser(id)
      await expect(db.query(`select get_admin_pricing_view()`)).rejects.toThrow(/forbidden/)
    }
    await db.exec(`reset role; set role anon`)
    await expect(db.query(`select get_admin_pricing_view()`)).rejects.toThrow()
    await db.exec('reset role')
  })
})
