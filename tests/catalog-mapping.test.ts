import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { mapMappingError, parseMappingRequest } from '../supabase/functions/_shared/admin-catalog-mapping.ts'

const U1 = '00000000-0000-4000-8000-000000000001'
const U2 = '00000000-0000-4000-8000-000000000002'

describe('parseMappingRequest', () => {
  it('rejects non-objects and unknown actions', () => {
    expect(parseMappingRequest(null)).toEqual({ error: 'Body must be a JSON object.' })
    expect(parseMappingRequest([])).toEqual({ error: 'Body must be a JSON object.' })
    expect(parseMappingRequest({})).toEqual({ error: 'Unknown action.' })
    expect(parseMappingRequest({ action: 'DROP' })).toEqual({ error: 'Unknown action.' })
  })

  it('LIST_UNLINKED: defaults, trimming and bounds', () => {
    expect(parseMappingRequest({ action: 'list_unlinked' })).toEqual({ action: 'LIST_UNLINKED', providerId: null, search: null, limit: 50, offset: 0 })
    expect(parseMappingRequest({ action: 'LIST_UNLINKED', providerId: U1, search: '  views ', limit: 10, offset: 20 }))
      .toEqual({ action: 'LIST_UNLINKED', providerId: U1, search: 'views', limit: 10, offset: 20 })
    expect(parseMappingRequest({ action: 'LIST_UNLINKED', providerId: 'x' })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LIST_UNLINKED', limit: 201 })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LIST_UNLINKED', limit: 1.5 })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LIST_UNLINKED', offset: -1 })).toHaveProperty('error')
  })

  it('LINK: needs both ids; score and flags are validated', () => {
    expect(parseMappingRequest({ action: 'LINK', providerServiceId: U1 })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LINK', providerServiceId: U1, serviceId: 'nope' })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LINK', providerServiceId: U1, serviceId: U2 }))
      .toEqual({ action: 'LINK', providerServiceId: U1, serviceId: U2, routingScore: null, supportsPartial: false, makePrimary: false })
    expect(parseMappingRequest({ action: 'LINK', providerServiceId: U1, serviceId: U2, routingScore: 50, supportsPartial: true, makePrimary: true }))
      .toMatchObject({ routingScore: 50, supportsPartial: true, makePrimary: true })
    expect(parseMappingRequest({ action: 'LINK', providerServiceId: U1, serviceId: U2, routingScore: 1001 })).toHaveProperty('error')
    expect(parseMappingRequest({ action: 'LINK', providerServiceId: U1, serviceId: U2, supportsPartial: 'yes' })).toHaveProperty('error')
  })

  it('CREATE_AND_LINK: validates name, price and limits', () => {
    const ok = { action: 'CREATE_AND_LINK', providerServiceId: U1, categoryId: U2, name: '  Views  ' }
    expect(parseMappingRequest(ok)).toEqual({
      action: 'CREATE_AND_LINK', providerServiceId: U1, categoryId: U2, name: 'Views', description: null,
      customerRatePer1000: null, minQuantity: null, maxQuantity: null, supportsPartial: false,
    })
    expect(parseMappingRequest({ ...ok, description: ' d ', customerRatePer1000: 1.23456, minQuantity: 10, maxQuantity: 100 }))
      .toMatchObject({ description: 'd', customerRatePer1000: 1.2346, minQuantity: 10, maxQuantity: 100 })
    expect(parseMappingRequest({ ...ok, customerPrice: 2 })).toMatchObject({ customerRatePer1000: 2 })
    expect(parseMappingRequest({ ...ok, name: '   ' })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, name: 'x'.repeat(121) })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, description: 'x'.repeat(1001) })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, customerRatePer1000: 0 })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, customerRatePer1000: -1 })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, customerRatePer1000: '2' })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, customerRatePer1000: 0.00001 })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, minQuantity: 100, maxQuantity: 10 })).toHaveProperty('error')
    expect(parseMappingRequest({ ...ok, categoryId: 'x' })).toHaveProperty('error')
  })
})

describe('mapMappingError', () => {
  it.each([
    ['forbidden: actor is not an admin', 403, 'forbidden'],
    ['service_not_found: abc', 404, 'service_not_found'],
    ['provider_service_not_found: abc', 404, 'provider_service_not_found'],
    ['category_not_found: abc', 404, 'category_not_found'],
    ['already_linked: this panel service already has an offer for this service', 409, 'already_linked'],
    ['provider_service_inactive: the panel no longer lists this service', 409, 'provider_service_inactive'],
    ['limits_do_not_overlap: the panel accepts 1..5 but the service sells 10..20', 409, 'limits_do_not_overlap'],
    ['limits_exceed_panel: the panel accepts 1..5', 409, 'limits_exceed_panel'],
    ['below_cost: customer rate 1 is below the panel cost 2', 409, 'below_cost'],
    ['invalid_parameter_value: name must be 1..120 characters', 400, 'invalid_input'],
    ['connection reset', 500, 'server_error'],
  ])('%s', (message, status, error) => {
    expect(mapMappingError(message)).toMatchObject({ status, error })
  })

  it('never leaks raw database text for unexpected errors', () => {
    expect(mapMappingError('relation "x" does not exist').message).toBe('Something went wrong. Please try again.')
  })
})

// ---------------------------------------------------------------------------
// The SQL functions, against the real migrations
// ---------------------------------------------------------------------------
describe('catalog mapping SQL functions', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  let provA: string, provB: string
  let cat: string, catOff: string
  let psA1: string, psA2: string, psB1: string, psInactive: string, psSmall: string
  let svc: string

  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const id = (sql: string, p: unknown[] = []) => one<string>(sql, p)
  const as = (fn: string, ...args: unknown[]) => db.query<{ r: Record<string, unknown> }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)
  const rowsOf = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))

    admin = await id(`insert into users(telegram_id, is_admin) values (1, true) returning id v`)
    user = await id(`insert into users(telegram_id) values (2) returning id v`)
    banned = await id(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id v`)
    provA = await id(`insert into providers(name, api_url) values ('A', 'https://a') returning id v`)
    provB = await id(`insert into providers(name, api_url) values ('B', 'https://b') returning id v`)
    cat = await id(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'tg-views') returning id v`)
    catOff = await id(`insert into categories(platform_id, name, slug, is_active) values ((select id from platforms where slug = 'telegram'), 'Old', 'tg-old', false) returning id v`)

    const ps = (prov: string, ext: string, name: string, rate: number, min: number, max: number, active = true) =>
      id(`insert into provider_services(provider_id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity, refill_supported, is_active)
          values ($1, $2, $3, 'Telegram Views', $4, $5, $6, true, $7) returning id v`, [prov, ext, name, rate, min, max, active])
    psA1 = await ps(provA, '1', 'A views', 0.1, 100, 50000)
    psA2 = await ps(provA, '2', 'A views fast', 0.2, 100, 50000)
    psB1 = await ps(provB, '9', 'B views', 0.08, 50, 20000)
    psInactive = await ps(provA, '3', 'A gone', 0.3, 10, 1000, false)
    psSmall = await ps(provA, '4', 'A tiny', 0.5, 1, 5)
    svc = await id(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
                    values ($1, 'Views', $2, 0.4, 100, 20000) returning id v`, [cat, psA1])
  }, 180_000)

  describe('access', () => {
    it('only the service role may execute; clients cannot, even as an admin user', async () => {
      for (const fn of ['admin_unlinked_provider_services(uuid, uuid, text, integer, integer)', 'admin_link_provider_service(uuid, uuid, uuid, integer, boolean, boolean)',
        'admin_create_service_with_offer(uuid, uuid, uuid, text, text, numeric, integer, integer, boolean)', 'assert_catalog_admin(uuid)']) {
        const grants = await rowsOf(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u,
                                            has_function_privilege('service_role', '${fn}', 'execute') s`)
        expect(grants[0].a).toBe(false)
        expect(grants[0].u).toBe(false)
        if (!fn.startsWith('assert')) expect(grants[0].s).toBe(true)
      }
    })

    it('refuses a non-admin, a banned admin and a missing actor in every function', async () => {
      for (const actor of [user, banned, null]) {
        await expect(as('admin_unlinked_provider_services', actor)).rejects.toThrow(/forbidden/)
        await expect(as('admin_link_provider_service', actor, psA2, svc)).rejects.toThrow(/forbidden/)
        await expect(as('admin_create_service_with_offer', actor, psA2, cat, 'N', null, 1)).rejects.toThrow(/forbidden/)
      }
      expect(await one<number>(`select count(*)::int v from provider_service_offers where provider_service_id = $1`, [psA2])).toBe(0)
    })
  })

  describe('admin_unlinked_provider_services', () => {
    it('lists active panel services with no offer, newest data and no secrets', async () => {
      const r = (await as('admin_unlinked_provider_services', admin)).rows[0].r as { items: Record<string, unknown>[]; total: number }
      // psA1 is already sold (primary + offer); the inactive one is not linkable
      expect(r.items.map((i) => i.name)).toEqual(['A tiny', 'A views fast', 'B views'])
      expect(r.total).toBe(3)
      expect(Object.keys(r.items[0]).sort()).toEqual(['categoryRaw', 'cancelSupported', 'externalServiceId', 'id', 'lastSyncedAt', 'maxQuantity', 'minQuantity', 'name', 'providerId', 'providerName', 'ratePer1000', 'refillSupported'].sort())
      expect(JSON.stringify(r)).not.toMatch(/api_key|api_url/)
    })

    it('filters by provider and search, escapes wildcards, pages', async () => {
      const byProv = (await as('admin_unlinked_provider_services', admin, provB)).rows[0].r as { total: number; items: { name: string }[] }
      expect(byProv.items.map((i) => i.name)).toEqual(['B views'])
      const search = (await as('admin_unlinked_provider_services', admin, null, 'FAST')).rows[0].r as { items: { name: string }[] }
      expect(search.items.map((i) => i.name)).toEqual(['A views fast'])
      const wildcard = (await as('admin_unlinked_provider_services', admin, null, '%')).rows[0].r as { total: number }
      expect(wildcard.total).toBe(0)
      const page = (await as('admin_unlinked_provider_services', admin, null, null, 1, 1)).rows[0].r as { total: number; items: { name: string }[] }
      expect(page.total).toBe(3)
      expect(page.items.map((i) => i.name)).toEqual(['A views fast'])
    })
  })

  describe('admin_link_provider_service', () => {
    it('creates the offer with the panel\'s cost, limits and flags, keeps the primary and writes an audit entry', async () => {
      const r = (await as('admin_link_provider_service', admin, psB1, svc, null, true, false)).rows[0].r
      expect(r).toMatchObject({ service_id: svc, provider_service_id: psB1, routing_score: 0, is_primary: false })
      const o = (await rowsOf(`select provider_id, cost_per_1000::float8 cost, min_quantity, max_quantity, refill_supported, cancel_supported, supports_partial, is_active, routing_score
                                 from provider_service_offers where id = $1`, [r.offer_id]))[0]
      expect(o).toEqual({ provider_id: provB, cost: 0.08, min_quantity: 50, max_quantity: 20000, refill_supported: true, cancel_supported: false, supports_partial: true, is_active: true, routing_score: 0 })
      expect(await one(`select primary_provider_service_id v from services where id = $1`, [svc])).toBe(psA1)
      const audit = await rowsOf(`select admin_id, action, details->>'service_id' sid from admin_audit_log where action = 'link_provider_service'`)
      expect(audit).toEqual([{ admin_id: admin, action: 'link_provider_service', sid: svc }])
    })

    it('refuses to link the same pair twice', async () => {
      await expect(as('admin_link_provider_service', admin, psB1, svc)).rejects.toThrow(/already_linked/)
      await expect(as('admin_link_provider_service', admin, psA1, svc)).rejects.toThrow(/already_linked/) // the primary's own offer
    })

    it('refuses unknown rows, inactive panel services, non-overlapping limits and bad scores', async () => {
      const ghost = '00000000-0000-4000-8000-0000000000ff'
      await expect(as('admin_link_provider_service', admin, psA2, ghost)).rejects.toThrow(/service_not_found/)
      await expect(as('admin_link_provider_service', admin, ghost, svc)).rejects.toThrow(/provider_service_not_found/)
      await expect(as('admin_link_provider_service', admin, psInactive, svc)).rejects.toThrow(/provider_service_inactive/)
      await expect(as('admin_link_provider_service', admin, psSmall, svc)).rejects.toThrow(/limits_do_not_overlap/)
      await expect(as('admin_link_provider_service', admin, psA2, svc, 5000)).rejects.toThrow(/routing score/)
      expect(await one<number>(`select count(*)::int v from provider_service_offers where provider_service_id in ($1, $2, $3)`, [psInactive, psSmall, psA2])).toBe(0)
    })

    it('makePrimary switches services.primary_provider_service_id, keeps the old primary as an offer and defaults the score to 100', async () => {
      const r = (await as('admin_link_provider_service', admin, psA2, svc, null, false, true)).rows[0].r
      expect(r).toMatchObject({ routing_score: 100, is_primary: true })
      expect(await one(`select primary_provider_service_id v from services where id = $1`, [svc])).toBe(psA2)
      expect(await one<number>(`select count(*)::int v from provider_service_offers where service_id = $1 and provider_service_id = $2`, [svc, psA1])).toBe(1)
    })

    it('a fallback panel service already has an offer through the bridge trigger, so linking it again is refused', async () => {
      const s = await id(`insert into services(category_id, name, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
                          values ($1, 'FB', $2, $3, 1, 100, 10000) returning id v`, [cat, psA1, psB1])
      await expect(as('admin_link_provider_service', admin, psB1, s, null, false, true)).rejects.toThrow(/already_linked/)
      expect(await one(`select fallback_provider_service_id v from services where id = $1`, [s])).toBe(psB1)
    })

    it('a linked panel service leaves the unlinked list', async () => {
      const r = (await as('admin_unlinked_provider_services', admin)).rows[0].r as { items: { name: string }[] }
      expect(r.items.map((i) => i.name)).toEqual(['A tiny'])
    })
  })

  describe('admin_create_service_with_offer', () => {
    // fresh panel services for each case
    const fresh = (rate = 0.1, min = 100, max = 50000) =>
      id(`insert into provider_services(provider_id, external_service_id, name, category_raw, rate_per_1000, min_quantity, max_quantity, refill_supported)
          values ($1, 'x' || gen_random_uuid()::text, 'Fresh', 'Telegram Views', $2, $3, $4, true) returning id v`, [provA, rate, min, max])

    it('creates the service and its offer atomically, with the panel as primary', async () => {
      const p = await fresh()
      const r = (await as('admin_create_service_with_offer', admin, p, cat, '  New views ', ' desc ', 0.25, null, null, true)).rows[0].r
      expect(r).toMatchObject({ provider_service_id: p, customer_rate_per_1000: 0.25, cost_per_1000: 0.1, min_quantity: 100, max_quantity: 50000 })
      const s = (await rowsOf(`select name, description, category_id, primary_provider_service_id, fallback_provider_service_id, customer_rate_per_1000::float8 rate,
                                      min_quantity, max_quantity, is_active, refill_supported from services where id = $1`, [r.service_id]))[0]
      expect(s).toEqual({ name: 'New views', description: 'desc', category_id: cat, primary_provider_service_id: p, fallback_provider_service_id: null, rate: 0.25, min_quantity: 100, max_quantity: 50000, is_active: true, refill_supported: true })
      const offers = await rowsOf(`select id, provider_id, provider_service_id, cost_per_1000::float8 cost, routing_score, supports_partial, is_active from provider_service_offers where service_id = $1`, [r.service_id])
      expect(offers).toEqual([{ id: r.offer_id, provider_id: provA, provider_service_id: p, cost: 0.1, routing_score: 100, supports_partial: true, is_active: true }])
      expect(await one<number>(`select count(*)::int v from admin_audit_log where action = 'create_service_with_offer' and target_id = $1`, [r.service_id])).toBe(1)
    })

    it('narrower limits are kept; the service then never exceeds the panel', async () => {
      const p = await fresh()
      const r = (await as('admin_create_service_with_offer', admin, p, cat, 'Narrow', null, 1, 500, 1000)).rows[0].r
      expect(r).toMatchObject({ min_quantity: 500, max_quantity: 1000 })
    })

    it('refuses a price below the panel cost, wider limits than the panel, a bad name, an inactive category / panel service', async () => {
      const p = await fresh(0.1, 100, 1000)
      const before = await one<number>(`select count(*)::int v from services`)
      await expect(as('admin_create_service_with_offer', admin, p, cat, 'Loss', null, 0.09)).rejects.toThrow(/below_cost/)
      await expect(as('admin_create_service_with_offer', admin, p, cat, 'Wide', null, 1, 50, 1000)).rejects.toThrow(/limits_exceed_panel/)
      await expect(as('admin_create_service_with_offer', admin, p, cat, 'Wide', null, 1, 100, 5000)).rejects.toThrow(/limits_exceed_panel/)
      await expect(as('admin_create_service_with_offer', admin, p, cat, '   ', null, 1)).rejects.toThrow(/name/)
      await expect(as('admin_create_service_with_offer', admin, p, cat, 'Zero', null, 0)).rejects.toThrow(/customer rate/)
      await expect(as('admin_create_service_with_offer', admin, p, catOff, 'Off', null, 1)).rejects.toThrow(/category_not_found/)
      await expect(as('admin_create_service_with_offer', admin, psInactive, cat, 'Gone', null, 1)).rejects.toThrow(/provider_service_inactive/)
      expect(await one<number>(`select count(*)::int v from services`)).toBe(before) // nothing half-created
    })

    it('price equal to the panel cost is allowed (zero margin is the admin\'s call)', async () => {
      const p = await fresh(0.1)
      await expect(as('admin_create_service_with_offer', admin, p, cat, 'Par', null, 0.1)).resolves.toBeDefined()
    })

    it('a freshly created service is immediately visible to routing as an active offer and no longer unlinked', async () => {
      const p = await fresh()
      const r = (await as('admin_create_service_with_offer', admin, p, cat, 'Routable', null, 1)).rows[0].r
      expect(await one<number>(`select count(*)::int v from provider_service_offers where service_id = $1 and is_active`, [r.service_id])).toBe(1)
      const un = (await as('admin_unlinked_provider_services', admin)).rows[0].r as { items: { id: string }[] }
      expect(un.items.map((i) => i.id)).not.toContain(p)
    })
  })
})
