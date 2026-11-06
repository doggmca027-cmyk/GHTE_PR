// @vitest-environment jsdom
// The catalogue in the app: the version first, the catalogue only when the version changed (lib/catalog-version.ts, lib/catalog-cache.ts, services.ts).
// Why: the free plan of Supabase allows 5 GB of egress a month. A copy of the catalogue that is of the version still current is fresh however old it is,
// so a customer who opens the app again downloads a few hundred bytes (the version, from the CDN) and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedLoad, clearCatalogCache, hydrateCached, isFresh, peekCached, persistedLoad } from '../src/lib/catalog-cache'
import { catalogVersionReady, currentCatalogVersion, resetCatalogVersion } from '../src/lib/catalog-version'

const V1 = '1'.repeat(32)
const V2 = '2'.repeat(32)
const MIN = 60_000

/** A fetch that answers the version endpoint with the given versions in turn (a string), or fails (an Error), and counts its calls. */
function versionFetch(...answers: (string | Error)[]) {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(String(url))
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!
    if (a instanceof Error) throw a
    return new Response(JSON.stringify({ version: a, services: 1 }), { status: 200 })
  }) as unknown as typeof fetch
  return { fn, calls }
}

beforeEach(() => { vi.stubEnv('VITE_CATALOG_PROXY', 'on'); resetCatalogVersion(); clearCatalogCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('1. the version: read from the CDN, at most once in ten minutes, and never able to break the app', () => {
  it('reads /api/catalog-version once and remembers it; a read within ten minutes costs no request', async () => {
    const { fn, calls } = versionFetch(V1)
    expect(await catalogVersionReady(1_000_000, fn)).toBe(V1)
    expect(await catalogVersionReady(1_000_000 + 9 * MIN, fn)).toBe(V1)
    expect(calls).toEqual(['/api/catalog-version'])
    expect(currentCatalogVersion()).toBe(V1)
    expect(await catalogVersionReady(1_000_000 + 11 * MIN, versionFetch(V2).fn)).toBe(V2) // after ten minutes it is read again
  })

  it('a failed read leaves the app as it was (null, or the version known before) and is retried after a minute, not on every request', async () => {
    const down = versionFetch(new Error('offline'))
    expect(await catalogVersionReady(2_000_000, down.fn)).toBeNull()
    expect(await catalogVersionReady(2_000_000 + 30_000, down.fn)).toBeNull()
    expect(down.calls).toHaveLength(1) // within the minute: no new request
    const back = versionFetch(V1)
    expect(await catalogVersionReady(2_000_000 + 61_000, back.fn)).toBe(V1)
    // later the endpoint breaks again: the version known before stays in force
    expect(await catalogVersionReady(2_000_000 + 61_000 + 11 * MIN, versionFetch(new Error('x')).fn)).toBe(V1)
  })

  it('something that is not a version (a page, a number, an HTML answer) is ignored', async () => {
    const odd = (async () => new Response(JSON.stringify({ version: 'latest' }), { status: 200 })) as unknown as typeof fetch
    expect(await catalogVersionReady(3_000_000, odd)).toBeNull()
    const html = (async () => new Response('<html></html>', { status: 200 })) as unknown as typeof fetch
    resetCatalogVersion()
    expect(await catalogVersionReady(3_000_000, html)).toBeNull()
  })

  it('with the proxy off (development, tests) the version is never asked for', async () => {
    vi.stubEnv('VITE_CATALOG_PROXY', 'off')
    const { fn, calls } = versionFetch(V1)
    expect(await catalogVersionReady(4_000_000, fn)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('2. the cache: a copy of the same version is fresh however old it is; another version, or none, is not', () => {
  // real time: the copies kept in the browser are stamped with Date.now(), and a copy "from the future" is refused
  const T0 = Date.now()
  const loader = (value: string) => { const load = vi.fn(async () => value); return load }

  it('loaded under V1: after an hour it is still fresh while V1 is current, so nothing is downloaded; V2 makes it stale and it is loaded again', async () => {
    await catalogVersionReady(T0, versionFetch(V1).fn)
    const first = loader('catalogue 1')
    await cachedLoad('k', first, T0)
    expect(first).toHaveBeenCalledTimes(1)
    const later = T0 + 60 * MIN
    expect(isFresh('k', later)).toBe(true)
    const again = loader('would be a download')
    expect(await cachedLoad('k', again, later)).toBe('catalogue 1')
    expect(again).not.toHaveBeenCalled()
    expect(peekCached('k', later)).toBe('catalogue 1') // also shown at once, though older than the in-memory window
    // the catalogue changes: the version read ten minutes on is V2
    await catalogVersionReady(later + 11 * MIN, versionFetch(V2).fn)
    expect(isFresh('k', later + 11 * MIN)).toBe(false)
    const reload = loader('catalogue 2')
    expect(await cachedLoad('k', reload, later + 11 * MIN)).toBe('catalogue 2')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('when the version is unknown the old schedule is the only rule: fresh for two minutes, then loaded again', async () => {
    const first = loader('a')
    await cachedLoad('k', first, T0)
    expect(isFresh('k', T0 + MIN)).toBe(true)
    expect(isFresh('k', T0 + 3 * MIN)).toBe(false)
    const second = loader('b')
    expect(await cachedLoad('k', second, T0 + 3 * MIN)).toBe('b')
  })

  it('a copy of the last visit (localStorage) that carries the version still current is fresh on the first frame: the next visit downloads no catalogue', async () => {
    // visit 1: the version is V1, the catalogue is downloaded and remembered in the browser with the version
    await catalogVersionReady(T0, versionFetch(V1).fn)
    const download = loader('categories + platforms')
    expect(await persistedLoad('overview:public', download, T0)).toBe('categories + platforms')
    expect(download).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('gh:cc:v1:overview:public')!)).toMatchObject({ ver: V1, value: 'categories + platforms' })

    // visit 2, an hour later: a new page (memory is empty), the same version
    const keep = localStorage.getItem('gh:cc:v1:overview:public')!
    clearCatalogCache()
    localStorage.setItem('gh:cc:v1:overview:public', keep)
    resetCatalogVersion()
    vi.stubGlobal('fetch', versionFetch(V1).fn)
    hydrateCached('overview:public', T0 + 60 * MIN)
    const noDownload = loader('must not be called')
    expect(await persistedLoad('overview:public', noDownload, T0 + 60 * MIN)).toBe('categories + platforms')
    expect(noDownload).not.toHaveBeenCalled()
  })

  it('...but the same copy with a NEW version is downloaded again, and the new copy carries the new version', async () => {
    await catalogVersionReady(T0, versionFetch(V1).fn)
    await persistedLoad('overview:public', loader('old catalogue'), T0)
    const keep = localStorage.getItem('gh:cc:v1:overview:public')!
    clearCatalogCache()
    localStorage.setItem('gh:cc:v1:overview:public', keep)
    resetCatalogVersion()
    vi.stubGlobal('fetch', versionFetch(V2).fn)
    hydrateCached('overview:public', T0 + 60 * MIN)
    const download = loader('new catalogue')
    expect(await persistedLoad('overview:public', download, T0 + 60 * MIN)).toBe('new catalogue')
    expect(download).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('gh:cc:v1:overview:public')!)).toMatchObject({ ver: V2, value: 'new catalogue' })
  })

  it('a copy older than a day is never used, whatever its version (and a copy without a version is only the quick first frame)', async () => {
    localStorage.setItem('gh:cc:v1:old', JSON.stringify({ at: T0 - 25 * 60 * MIN, ver: V1, value: 'ancient' }))
    await catalogVersionReady(T0, versionFetch(V1).fn)
    hydrateCached('old', T0)
    expect(peekCached('old', T0)).toBeUndefined()
    localStorage.setItem('gh:cc:v1:unversioned', JSON.stringify({ at: T0 - 60 * MIN, value: 'from before the version existed' }))
    hydrateCached('unversioned', T0)
    expect(peekCached('unversioned', T0)).toBe('from before the version existed') // shown at once ...
    expect(isFresh('unversioned', T0)).toBe(false) // ... and renewed: it carries no version
  })
})
