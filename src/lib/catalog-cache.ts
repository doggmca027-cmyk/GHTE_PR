// The catalogue reads kept in memory for a few minutes, so going back to a category or reopening the Services tab shows what was loaded
// at once (and refreshes it quietly when it is older than the freshness window). Prices are always re-checked by the server when an order
// is quoted and placed, so a cached page can never charge a stale price.
//
// THE VERSION (lib/catalog-version.ts, GET /api/catalog-version). Every entry remembers the version of the catalogue it was loaded under. While the
// version the app knows now is the same, the entry is FRESH however old it is (up to a day): the app asks the CDN for the tiny version and not for the
// catalogue, which is what keeps the free plan of Supabase (5 GB of egress) alive. When the version changes, or cannot be read, the old schedule
// (FRESH_MS) is the only rule, exactly as before the version existed.

import { catalogVersionReady, currentCatalogVersion } from '@/lib/catalog-version'

const FRESH_MS = 2 * 60_000
const KEEP_MS = 15 * 60_000
const MAX_ENTRIES = 200

// What a visit leaves in the browser for the next one (see persistedLoad): the next open shows it at once instead of a blank screen on a slow connection.
// Bump the version when the shape of a persisted value changes, so an old copy is never read by new code.
const STORE_PREFIX = 'gh:cc:v1:'
const PERSIST_MAX_AGE_MS = 24 * 60 * 60_000

interface Entry<T> {
  at: number
  value?: T
  pending?: Promise<T>
  /** The version of the catalogue this value was loaded under (null: unknown). */
  ver?: string | null
}

const entries = new Map<string, Entry<unknown>>()

/** The value is of the version the app knows now: nothing has changed in the catalogue since it was loaded. */
const sameVersion = (e: Entry<unknown>, now: number): boolean => {
  const v = currentCatalogVersion()
  return v !== null && e.ver === v && now - e.at <= PERSIST_MAX_AGE_MS
}
/** Fresh: younger than the freshness window, or loaded under the version that is still current. */
const fresh = (e: Entry<unknown> | undefined, now: number): boolean => Boolean(e && e.value !== undefined && (now - e.at <= FRESH_MS || sameVersion(e, now)))

/** What is in memory for this key (fresh or not), if anything has been loaded. */
export function peekCached<T>(key: string, now = Date.now()): T | undefined {
  const e = entries.get(key)
  if (!e || e.value === undefined || (now - e.at > KEEP_MS && !sameVersion(e, now))) return undefined
  return e.value as T
}

/** Is the cached value still fresh (no refresh needed)? */
export const isFresh = (key: string, now = Date.now()): boolean => fresh(entries.get(key), now)

/**
 * Loads through the cache: a fresh value is returned as it is, one request at a time per key (a second caller shares the first one's
 * request). A failed load is not remembered.
 */
export function cachedLoad<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const e = entries.get(key) as Entry<T> | undefined
  if (e?.value !== undefined && fresh(e, now)) return Promise.resolve(e.value)
  if (e?.pending) return e.pending
  const pending = load().then(
    (value) => {
      // the version the request was made under: the request itself waits for it (services.ts), and it is only read again after ten minutes
      entries.set(key, { at: Date.now(), value, ver: currentCatalogVersion() })
      trim()
      return value
    },
    (err) => {
      const cur = entries.get(key)
      if (cur?.pending === pending) {
        if (cur.value === undefined) entries.delete(key)
        else entries.set(key, { at: cur.at, value: cur.value, ver: cur.ver })
      }
      throw err
    },
  )
  entries.set(key, { at: e?.at ?? 0, value: e?.value, ver: e?.ver, pending })
  return pending
}

function trim() {
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string)
}

/** Loads through the cache like cachedLoad, and remembers the result in the browser for the next visit (hydrateCached). Best effort: no storage, no harm. */
export async function persistedLoad<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  // The version first (a few hundred bytes from the CDN): a copy of the last visit that is of the same version is fresh and the catalogue is not downloaded.
  await catalogVersionReady().catch(() => null)
  return cachedLoad(key, () => load().then((value) => {
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify({ at: Date.now(), ver: currentCatalogVersion(), value })) } catch { /* private mode, quota: the cache works without it */ }
    return value
  }), now)
}

/**
 * Brings back what the last visit remembered under this key (not older than a day), so peekCached shows it on the first frame. It counts as stale
 * unless it is fresher than the freshness window already: the screen shows it and loads the real thing at once. Nothing is done when the key is
 * in memory already or the copy is unreadable.
 */
export function hydrateCached(key: string, now = Date.now()): void {
  if (entries.has(key)) return
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key)
    if (!raw) return
    const saved = JSON.parse(raw) as { at?: unknown; ver?: unknown; value?: unknown }
    if (typeof saved.at !== 'number' || saved.value === undefined || saved.value === null || now - saved.at > PERSIST_MAX_AGE_MS || saved.at > now + 60_000) return
    // peekCached shows what is younger than KEEP_MS: an older copy is dated just inside that, which is still beyond the freshness window.
    // A copy older than a day was refused above, so a copy that carries the version still current is fresh without a download.
    entries.set(key, { at: Math.max(saved.at, now - KEEP_MS + 30_000), value: saved.value, ver: typeof saved.ver === 'string' ? saved.ver : null })
  } catch { /* an unreadable copy is no copy */ }
}

/** For tests. */
export function clearCatalogCache() {
  entries.clear()
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(STORE_PREFIX)) localStorage.removeItem(k)
  } catch { /* no storage */ }
}
