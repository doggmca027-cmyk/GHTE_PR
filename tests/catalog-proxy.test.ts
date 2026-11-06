// The catalogue through the CDN (api/catalog.ts, api/catalog-version.ts; _lib/catalog-proxy.ts). Why: the free plan of Supabase allows 5 GB of egress a month
// and the project was restricted (HTTP 402) on 2026-11-06. The catalogue is the same for everyone, so Vercel's CDN keeps it per version of the catalogue and
// Supabase is asked once per version, not once per customer. What is tested here: what the window lets through (and refuses), what the CDN is told to keep
// (and for how long), that an error is never kept, and that compression is asked for.
import { describe, expect, it } from 'vitest'
import {
  CACHE_UNVERSIONED, CACHE_VERSION, CACHE_VERSIONED, checkCatalogPath, handleCatalog, handleCatalogVersion, MAX_LIMIT, upstreamHeaders, type CatalogDeps,
} from '../api/_lib/catalog-proxy'
import { CATEGORY_SELECT, SERVICE_COLUMNS } from '../src/services/api/services'

const BASE = 'https://x.supabase.co'
const VERSION = 'a'.repeat(32)
const env = { supabaseUrl: BASE, anonKey: 'anon-key' }

/** The reads the app really makes (src/services/api/services.ts), written the way it writes them. */
const APP_READS = [
  'platforms?select=slug,name,category,sort_order&active=eq.true&order=sort_order,name&limit=500',
  'categories?select=id,name,slug,icon_url,sort_order,name_i18n,active_service_count,platforms!inner(slug)&is_active=eq.true&active_service_count=gt.0&platforms.active=eq.true&order=sort_order,name&limit=1000',
  `services?select=${CATEGORY_SELECT}&category_id=eq.7b3c1f7e-1111-4222-8333-444455556666&is_active=eq.true&parent_service_id=is.null&variants.is_active=eq.true&order=is_premium.desc,sort_order,customer_rate_per_1000,id&limit=30&offset=0`,
  `services?select=${SERVICE_COLUMNS.join(',')}&category_id=in.(a,b)&is_active=eq.true&and=${encodeURIComponent('(or(name.ilike.*views*,description.ilike.*views*))')}&order=is_premium.desc,sort_order,customer_rate_per_1000,id&limit=30&offset=30`,
  `services?select=${SERVICE_COLUMNS.join(',')},category:categories!inner(platform:platforms!inner(slug,name))&sku=eq.IG-FOL-STD-ROOT89336&is_active=eq.true&category.platform.active=eq.true&limit=1`,
  'services?select=customer_rate_per_1000&is_active=eq.true&customer_rate_per_1000=gt.0&order=customer_rate_per_1000.asc&limit=1',
]

const ask = (path: string, version?: string, init: RequestInit = {}) =>
  new Request(`https://app.test/api/catalog?p=${encodeURIComponent(path)}${version ? `&v=${version}` : ''}`, init)

describe('1. what the window lets through: the reads the app makes, and only those kinds', () => {
  it.each(APP_READS.map((p) => [p.slice(0, 60), p]))('the app\'s own read is accepted: %s…', (_label, path) => {
    expect(checkCatalogPath(path)).toEqual({ ok: true, path })
  })

  it.each([
    ['select=* (every column the role may read)', 'services?select=*&limit=10', 'select_star_forbidden'],
    ['a star inside an embed', 'services?select=id,variants:services!parent_service_id(*)&limit=10', 'select_star_forbidden'],
    ['no select', 'services?is_active=eq.true&limit=10', 'select_required'],
    ['no limit', 'services?select=id&is_active=eq.true', 'limit_required'],
    [`a limit over ${MAX_LIMIT}`, `services?select=id&limit=${MAX_LIMIT + 1}`, 'limit_required'],
    ['a limit that is not a number', 'services?select=id&limit=all', 'limit_required'],
    ['a table that is not public (orders)', 'orders?select=id&limit=1', 'table_not_allowed'],
    ['the provider side', 'provider_services?select=id&limit=1', 'table_not_allowed'],
    ['an RPC', 'rpc/get_admin_metrics?select=id&limit=1', 'table_not_allowed'],
    ['a path inside the path', 'services/../orders?select=id&limit=1', 'table_not_allowed'],
    ['no query at all', 'services', 'missing_query'],
    ['a fragment', 'services?select=id&limit=1#x', 'query_not_allowed'],
    ['a second query string', 'services?select=id&limit=1?x=1', 'query_not_allowed'],
    ['a semicolon', 'services?select=id;drop&limit=1', 'query_not_allowed'],
    ['a backslash', 'services?select=id\\&limit=1', 'query_not_allowed'],
    ['a quote', "services?select=id'&limit=1", 'query_not_allowed'],
  ])('%s', (_label, path, reason) => {
    expect(checkCatalogPath(path)).toEqual({ ok: false, reason })
  })

  it('an empty, a missing and an over-long path are refused', () => {
    expect(checkCatalogPath(null)).toEqual({ ok: false, reason: 'missing_path' })
    expect(checkCatalogPath('')).toEqual({ ok: false, reason: 'missing_path' })
    expect(checkCatalogPath(`services?select=${'a'.repeat(3000)}&limit=1`)).toEqual({ ok: false, reason: 'path_too_long' })
  })
})

describe('2. GET /api/catalog: what Supabase is asked, and what the CDN is told to keep', () => {
  const run = async (req: Request, answer: () => Response | Promise<Response> = () => new Response('[{"id":"1"}]', { status: 200 }), over: Partial<CatalogDeps> = {}) => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const res = await handleCatalog(req, {
      env, fetch: (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }); return answer() }) as unknown as typeof fetch, ...over,
    })
    return { res, calls }
  }

  it('asks Supabase for exactly that path with the anon key, and asks for compression out loud (gzip, deflate, br)', async () => {
    const path = APP_READS[1]!
    const { res, calls } = await run(ask(path, VERSION))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/rest/v1/${path}`)
    expect(calls[0]!.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer anon-key', 'Accept-Encoding': 'gzip, deflate, br' })
    expect(upstreamHeaders('k')['Accept-Encoding']).toBe('gzip, deflate, br')
    expect(await res.json()).toEqual([{ id: '1' }])
  })

  it('a known version: the CDN keeps it for a day and renews it in the background for a week (the URL is unique to the version)', async () => {
    const { res } = await run(ask(APP_READS[0]!, VERSION))
    expect(res.headers.get('Cache-Control')).toBe(CACHE_VERSIONED)
    expect(CACHE_VERSIONED).toContain('s-maxage=86400')
    expect(CACHE_VERSIONED).toContain('stale-while-revalidate=604800')
  })

  it('no version, or one that is not a version: kept only five minutes', async () => {
    for (const v of [undefined, 'latest', 'A'.repeat(32), 'a'.repeat(31)]) {
      const { res } = await run(ask(APP_READS[0]!, v))
      expect(res.headers.get('Cache-Control'), String(v)).toBe(CACHE_UNVERSIONED)
    }
    expect(CACHE_UNVERSIONED).toContain('s-maxage=300')
  })

  it('an error is NEVER kept: a 402 or a 500 of Supabase becomes a 502 with no-store, so it cannot outlive the problem', async () => {
    for (const status of [402, 401, 500, 503]) {
      const { res } = await run(ask(APP_READS[0]!, VERSION), () => new Response('{"message":"restricted"}', { status }))
      expect(res.status).toBe(502)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(await res.json()).toEqual({ error: 'upstream_error', status })
    }
    const { res } = await run(ask(APP_READS[0]!, VERSION), () => { throw new Error('network') })
    expect(res.status).toBe(502)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('a refused path never reaches Supabase: 400, not kept', async () => {
    const { res, calls } = await run(ask('services?select=*&limit=10', VERSION))
    expect(res.status).toBe(400)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ error: 'invalid_catalog_path', reason: 'select_star_forbidden' })
    expect(calls).toHaveLength(0)
  })

  it('only GET (and HEAD); not configured is a 503, not kept', async () => {
    expect((await run(ask(APP_READS[0]!, VERSION, { method: 'POST', body: '{}' }))).res.status).toBe(405)
    const { res, calls } = await run(ask(APP_READS[0]!, VERSION), undefined, { env: {} })
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(calls).toHaveLength(0)
  })
})

describe('3. GET /api/catalog-version: the version, kept an hour', () => {
  const version = async (answer: () => Response, over: Partial<CatalogDeps> = {}) => {
    const urls: string[] = []
    const res = await handleCatalogVersion(new Request('https://app.test/api/catalog-version'), {
      env, fetch: (async (url: string) => { urls.push(String(url)); return answer() }) as unknown as typeof fetch, ...over,
    })
    return { res, urls }
  }

  it('reads the one row of the view catalog_version and answers {version, services}; the CDN keeps it an hour, so Supabase sees one request an hour per region', async () => {
    const { res, urls } = await version(() => new Response(JSON.stringify([{ version: VERSION, services: 7395 }]), { status: 200 }))
    expect(urls).toEqual([`${BASE}/rest/v1/catalog_version?select=version,services&limit=1`])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: VERSION, services: 7395 })
    expect(res.headers.get('Cache-Control')).toBe(CACHE_VERSION)
    expect(CACHE_VERSION).toContain('s-maxage=3600')
  })

  it('anything that is not a version is a 502 that is not kept (the app then loads the catalogue as before)', async () => {
    for (const answer of [
      () => new Response('[]', { status: 200 }),
      () => new Response('[{"version":"nope"}]', { status: 200 }),
      () => new Response('not json', { status: 200 }),
      () => new Response('{"message":"restricted"}', { status: 402 }),
    ]) {
      const { res } = await version(answer)
      expect(res.status).toBe(502)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
  })
})
