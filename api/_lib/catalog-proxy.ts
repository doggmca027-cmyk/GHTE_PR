// The catalogue through the CDN (api/catalog.ts and api/catalog-version.ts, Vercel Edge). Pure: no I/O of its own, so it is tested without a network.
//
// WHY. The free plan of Supabase allows 5 GB of egress a month and every customer who opens the app used to read the same public catalogue (platforms,
// categories, pages of services) straight from Supabase. Now the app asks THIS function for it. The answer is the same for everyone, so Vercel's CDN keeps
// it and Supabase is asked once per version of the catalogue, not once per customer:
//   /api/catalog-version             -> {"version": "<md5>", "services": N}      kept 1 hour (view catalog_version, migration 20270104000000)
//   /api/catalog?p=<PostgREST path>&v=<version>  -> the rows, as Supabase answers   kept 1 day, refreshed in the background for a week
// The version is part of the URL: when the catalogue changes the URL changes, so a stale answer is never served for a new version, and an answer
// without a valid version is kept only 5 minutes. An error is NEVER kept (a 402 or a 502 must not outlive the problem).
//
// It is a read-only window onto three tables with the ANON key (what any visitor can read anyway): only GET, only platforms / categories / services,
// an explicit column list (select=* is refused), a bounded limit. It is not a general proxy.

export const CATALOG_TABLES: ReadonlySet<string> = new Set(['platforms', 'categories', 'services'])
export const MAX_PATH_CHARS = 2_500
export const MAX_LIMIT = 1_000
export const UPSTREAM_TIMEOUT_MS = 8_000

/** An answer for a known version: the URL is unique to that version, so a day is safe; the CDN refreshes it in the background for a week. */
export const CACHE_VERSIONED = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800'
/** An answer asked for without a (valid) version: short, the next version wipes it anyway. */
export const CACHE_UNVERSIONED = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400'
/** The version itself: at most one request an hour per CDN region reaches Supabase. */
export const CACHE_VERSION = 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=604800'
export const NO_STORE = 'no-store'

export const VERSION_RE = /^[a-f0-9]{32}$/
/** What a PostgREST query string is made of: letters, digits and the punctuation of select / eq / in / and / or / order. No path, no fragment, no second query. */
const SAFE_QUERY = /^[A-Za-z0-9_.,:()!=&%*~+>\- ]+$/

export interface CatalogEnv { supabaseUrl?: string; anonKey?: string }
export interface CatalogDeps { env: CatalogEnv; fetch: typeof fetch }

const json = (status: number, body: unknown, cache: string = NO_STORE) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } })

/** The request to Supabase: the anon key, and compression asked for out loud (an uncompressed catalogue is megabytes, a compressed one tens of kilobytes). */
export const upstreamHeaders = (anonKey: string): Record<string, string> => ({
  apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br',
})

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/** Is this PostgREST path one the catalogue window may read? (`categories?select=id,name&limit=1000&...`) */
export function checkCatalogPath(raw: string | null): PathCheck {
  if (!raw) return { ok: false, reason: 'missing_path' }
  if (raw.length > MAX_PATH_CHARS) return { ok: false, reason: 'path_too_long' }
  const at = raw.indexOf('?')
  if (at <= 0) return { ok: false, reason: 'missing_query' }
  const table = raw.slice(0, at)
  const query = raw.slice(at + 1)
  if (!CATALOG_TABLES.has(table)) return { ok: false, reason: 'table_not_allowed' }
  if (!SAFE_QUERY.test(query)) return { ok: false, reason: 'query_not_allowed' }
  let params: URLSearchParams
  try {
    decodeURIComponent(query)
    params = new URLSearchParams(query)
  } catch {
    return { ok: false, reason: 'query_not_allowed' }
  }
  const select = params.get('select')
  if (!select) return { ok: false, reason: 'select_required' }
  if (/(^|[,(:>])\*($|[,)])/.test(select)) return { ok: false, reason: 'select_star_forbidden' } // every column the role may read: never
  const limit = Number(params.get('limit'))
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, reason: 'limit_required' }
  return { ok: true, path: raw }
}

const configured = (env: CatalogEnv): env is Required<CatalogEnv> => Boolean(env.supabaseUrl && env.anonKey)

/** GET /api/catalog?p=<path>&v=<version>: the rows of one catalogue read, kept by the CDN for the version it was asked for. */
export async function handleCatalog(req: Request, { env, fetch: doFetch }: CatalogDeps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method_not_allowed' })
  if (!configured(env)) return json(503, { error: 'catalog_not_configured' })
  const url = new URL(req.url)
  const checked = checkCatalogPath(url.searchParams.get('p'))
  if (!checked.ok) return json(400, { error: 'invalid_catalog_path', reason: checked.reason })
  const version = url.searchParams.get('v')
  let upstream: Response
  try {
    upstream = await doFetch(`${env.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${checked.path}`, { headers: upstreamHeaders(env.anonKey), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch {
    return json(502, { error: 'upstream_unreachable' })
  }
  // an error is passed on as 502 and never kept: the app falls back to reading Supabase itself
  if (!upstream.ok) return json(502, { error: 'upstream_error', status: upstream.status })
  const body = await upstream.text()
  return new Response(req.method === 'HEAD' ? null : body, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': version !== null && VERSION_RE.test(version) ? CACHE_VERSIONED : CACHE_UNVERSIONED },
  })
}

/** GET /api/catalog-version: {version, services}, read from the view catalog_version (one row), kept 1 hour. */
export async function handleCatalogVersion(req: Request, { env, fetch: doFetch }: CatalogDeps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method_not_allowed' })
  if (!configured(env)) return json(503, { error: 'catalog_not_configured' })
  let upstream: Response
  try {
    upstream = await doFetch(`${env.supabaseUrl.replace(/\/+$/, '')}/rest/v1/catalog_version?select=version,services&limit=1`, { headers: upstreamHeaders(env.anonKey), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch {
    return json(502, { error: 'upstream_unreachable' })
  }
  if (!upstream.ok) return json(502, { error: 'upstream_error', status: upstream.status })
  let row: { version?: unknown; services?: unknown } | undefined
  try {
    row = ((await upstream.json()) as { version?: unknown; services?: unknown }[])[0]
  } catch {
    return json(502, { error: 'upstream_unreadable' })
  }
  if (typeof row?.version !== 'string' || !VERSION_RE.test(row.version)) return json(502, { error: 'version_unreadable' })
  return json(200, { version: row.version, services: typeof row.services === 'number' ? row.services : null }, CACHE_VERSION)
}
