// The version of the catalogue the storefront shows (GET /api/catalog-version, api/catalog-version.ts), so that the app downloads the catalogue again
// only when it has changed. It is an optimisation of the egress of Supabase (free plan, 5 GB): when the version cannot be read, nothing breaks, the
// catalogue is simply loaded on the old schedule (catalog-cache.ts) and from Supabase itself (services.ts).

const REFRESH_MS = 10 * 60_000
const RETRY_MS = 60_000
const REQUEST_TIMEOUT_MS = 2_500
/** What the endpoint answers for the version: 32 hex characters (md5). Anything else is not a version. */
export const VERSION_RE = /^[a-f0-9]{32}$/

let current: string | null = null
let readAt = 0
let pending: Promise<string | null> | null = null

/** The version known now (null: not read yet, or it could not be read). */
export const currentCatalogVersion = (): string | null => current

/** Is the proxy off (VITE_CATALOG_PROXY=off, for development without the /api routes)? */
export const catalogProxyOff = (): boolean => import.meta.env.VITE_CATALOG_PROXY === 'off'

/**
 * The version, read from the CDN at most once in ten minutes (a failed read is retried after a minute). Never rejects: null when it cannot be read,
 * and then the previous version, if any, stays in force until it is read again.
 */
export function catalogVersionReady(now = Date.now(), doFetch: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined): Promise<string | null> {
  if (catalogProxyOff() || !doFetch) return Promise.resolve(current)
  if (now - readAt < REFRESH_MS) return Promise.resolve(current)
  if (pending) return pending
  pending = doFetch('/api/catalog-version', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`catalog version ${res.status}`)
      const body = (await res.json()) as { version?: unknown }
      if (typeof body.version !== 'string' || !VERSION_RE.test(body.version)) throw new Error('catalog version unreadable')
      current = body.version
      readAt = now
      return current
    })
    .catch(() => {
      readAt = now - REFRESH_MS + RETRY_MS // try again in a minute, not on every request
      return current
    })
    .finally(() => { pending = null })
  return pending
}

/** For tests. */
export function resetCatalogVersion(): void {
  current = null
  readAt = 0
  pending = null
}
