// The catalogue reads kept in memory for a few minutes, so going back to a category or reopening the Services tab shows what was loaded
// at once (and refreshes it quietly when it is older than the freshness window). Prices are always re-checked by the server when an order
// is quoted and placed, so a cached page can never charge a stale price.

const FRESH_MS = 2 * 60_000
const KEEP_MS = 15 * 60_000
const MAX_ENTRIES = 200

interface Entry<T> {
  at: number
  value?: T
  pending?: Promise<T>
}

const entries = new Map<string, Entry<unknown>>()

/** What is in memory for this key (fresh or not), if anything has been loaded. */
export function peekCached<T>(key: string, now = Date.now()): T | undefined {
  const e = entries.get(key)
  if (!e || e.value === undefined || now - e.at > KEEP_MS) return undefined
  return e.value as T
}

/** Is the cached value still fresh (no refresh needed)? */
export const isFresh = (key: string, now = Date.now()): boolean => {
  const e = entries.get(key)
  return Boolean(e && e.value !== undefined && now - e.at <= FRESH_MS)
}

/**
 * Loads through the cache: a fresh value is returned as it is, one request at a time per key (a second caller shares the first one's
 * request). A failed load is not remembered.
 */
export function cachedLoad<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const e = entries.get(key) as Entry<T> | undefined
  if (e?.value !== undefined && now - e.at <= FRESH_MS) return Promise.resolve(e.value)
  if (e?.pending) return e.pending
  const pending = load().then(
    (value) => {
      entries.set(key, { at: Date.now(), value })
      trim()
      return value
    },
    (err) => {
      const cur = entries.get(key)
      if (cur?.pending === pending) {
        if (cur.value === undefined) entries.delete(key)
        else entries.set(key, { at: cur.at, value: cur.value })
      }
      throw err
    },
  )
  entries.set(key, { at: e?.at ?? 0, value: e?.value, pending })
  return pending
}

function trim() {
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string)
}

/** For tests. */
export function clearCatalogCache() {
  entries.clear()
}
