// @vitest-environment jsdom
// The app on a slow connection: the catalogue of the last visit is on screen at once, screens nobody asked for are not fetched, the balance is not read
// again and again, and the font stylesheet is the small one.
import fs from 'node:fs'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCatalogCache, hydrateCached, isFresh, peekCached, persistedLoad } from '../src/lib/catalog-cache'
import { canPrefetch } from '../src/lib/connection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

describe('what the last visit left behind', () => {
  beforeEach(() => clearCatalogCache())

  it('a load that went through persistedLoad is shown by the next visit on its first frame, and counts as stale so it is renewed', async () => {
    const t0 = Date.now()
    await persistedLoad('overview:public', async () => ({ platforms: ['telegram'] }), t0)
    clearMemoryOnly() // the next visit: the module is new, the browser's storage is the same
    expect(peekCached('overview:public')).toBeUndefined()
    hydrateCached('overview:public', t0 + 5 * 60_000)
    expect(peekCached('overview:public', t0 + 5 * 60_000)).toEqual({ platforms: ['telegram'] })
    expect(isFresh('overview:public', t0 + 5 * 60_000)).toBe(false) // five minutes old: shown, and loaded again at once
  })

  it('a copy younger than the freshness window is fresh: a quick reopen asks the network for nothing', async () => {
    const t0 = Date.now()
    await persistedLoad('overview:public', async () => 'now', t0)
    clearMemoryOnly()
    hydrateCached('overview:public', t0 + 60_000)
    expect(isFresh('overview:public', t0 + 60_000)).toBe(true)
  })

  it('a day-old copy is still shown (it is renewed at once); older, from the future, damaged or empty ones are not', () => {
    const now = Date.now()
    const put = (key: string, raw: string) => localStorage.setItem(`gh:cc:v1:${key}`, raw)
    put('day', JSON.stringify({ at: now - 23 * 3_600_000, value: [1] }))
    put('old', JSON.stringify({ at: now - 25 * 3_600_000, value: [1] }))
    put('future', JSON.stringify({ at: now + 3_600_000, value: [1] }))
    put('broken', '{not json')
    put('empty', JSON.stringify({ at: now }))
    put('null', JSON.stringify({ at: now, value: null }))
    for (const key of ['day', 'old', 'future', 'broken', 'empty', 'null']) hydrateCached(key, now)
    expect(peekCached('day', now)).toEqual([1])
    for (const key of ['old', 'future', 'broken', 'empty', 'null']) expect(peekCached(key, now)).toBeUndefined()
  })

  it('what is in memory is not overwritten by an older copy, and a browser without storage changes nothing', async () => {
    await persistedLoad('k', async () => 'memory')
    localStorage.setItem('gh:cc:v1:k', JSON.stringify({ at: Date.now(), value: 'disk' }))
    hydrateCached('k')
    expect(peekCached('k')).toBe('memory')
    const broken = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    await expect(persistedLoad('q', async () => 'works')).resolves.toBe('works') // the quota is full: no harm
    broken.mockRestore()
  })

  it('a failed load saves nothing', async () => {
    await expect(persistedLoad('bad', async () => { throw new Error('down') })).rejects.toThrow('down')
    expect(localStorage.getItem('gh:cc:v1:bad')).toBeNull()
  })

  /** A new visit: the in-memory cache is gone, the browser's storage is not. */
  function clearMemoryOnly() {
    const kept = Object.entries(localStorage)
    clearCatalogCache()
    for (const [k, v] of kept) localStorage.setItem(k, v)
  }
})

describe('the services screen on a repeat visit', () => {
  let host: HTMLElement
  let root: Root
  let requests: string[]
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const session = { token: 'jwt', expiresAt: 0, isMock: false, wallet: { balance: 5, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } }
  const category = { id: 'c1', name: 'Telegram Members', slug: 'c1', icon_url: null, sort_order: 1, name_i18n: {}, active_service_count: 9, platforms: { slug: 'telegram' } }

  beforeEach(() => {
    vi.resetModules()
    clearCatalogCache()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    requests = []
    vi.doMock('../src/context/AuthContext', () => ({ useAuth: () => ({ refreshWallet: async () => {}, applyWallet: () => {} }) }))
    vi.doMock('../src/lib/analytics-client', () => ({ track: () => {}, bindAnalytics: () => {} }))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('../src/context/AuthContext')
    vi.doUnmock('../src/lib/analytics-client')
  })

  const open = async (answer: (u: URL) => Response | Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const u = new URL(String(input)); requests.push(u.pathname); return answer(u) }))
    const { ServicesScreen } = await import('../src/components/services/ServicesScreen')
    await act(async () => { root.render(createElement(ServicesScreen, { session, onViewOrders: () => {} } as never)) })
  }
  const flush = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }

  it('the first visit loads and remembers; the next one shows the platforms before the network answers, then renews them', async () => {
    await open((u) => (u.pathname.endsWith('/platforms') ? json([{ slug: 'telegram', name: 'Telegram', category: 'messaging', sort_order: 1 }]) : json([category])))
    await flush()
    expect(host.textContent).toContain('Telegram')
    expect(localStorage.getItem('gh:cc:v1:overview:public')).not.toBeNull()

    // the next visit: a new page, the network is slow (never answers within the test)
    act(() => root.unmount())
    root = createRoot(host)
    vi.resetModules()
    const { clearCatalogCache: forgetMemory } = await import('../src/lib/catalog-cache')
    const kept = Object.entries(localStorage)
    forgetMemory()
    for (const [k, v] of kept) localStorage.setItem(k, v)
    // a quick reopen (inside the freshness window) asks the network for nothing at all ...
    requests = []
    await open(() => { throw new TypeError('the network must not be asked') })
    await flush(5)
    expect(host.textContent).toContain('Telegram')
    expect(requests).toEqual([])
    // ... one from ten minutes ago is shown and renewed
    act(() => root.unmount())
    root = createRoot(host)
    vi.resetModules()
    const { clearCatalogCache: forget2 } = await import('../src/lib/catalog-cache')
    forget2()
    const saved = JSON.parse(kept.find(([k]) => k === 'gh:cc:v1:overview:public')![1]) as { at: number; value: unknown }
    localStorage.setItem('gh:cc:v1:overview:public', JSON.stringify({ ...saved, at: Date.now() - 10 * 60_000 }))
    requests = []
    let release: (r: Response) => void = () => {}
    await open(() => new Promise<Response>((resolve) => { release = resolve }))
    await flush(5)
    expect(host.textContent).toContain('Telegram') // from the last visit, on the first frame
    expect(host.querySelector('.animate-pulse')).toBeNull() // not a skeleton
    expect(requests.length).toBeGreaterThan(0) // and renewed
    release(json([]))
  })

  it('a visit with no network and a remembered catalogue still shows the catalogue', async () => {
    localStorage.setItem('gh:cc:v1:overview:public', JSON.stringify({ at: Date.now() - 3_600_000, value: { categories: [{ id: 'c1', platform: 'telegram', name: 'Telegram Members', slug: 'c1', iconUrl: null, sortOrder: 1, count: 9 }], platforms: [{ slug: 'telegram', name: 'Telegram', category: 'messaging', sortOrder: 1 }] } }))
    await open(() => { throw new TypeError('Failed to fetch') })
    await flush()
    expect(host.textContent).toContain('Telegram')
    expect(host.textContent).not.toContain("Couldn't load services")
  })
})

describe('what is fetched in the background', () => {
  it.each([
    [{ effectiveType: '4g' }, true],
    [{ effectiveType: '3g' }, false],
    [{ effectiveType: '2g' }, false],
    [{ effectiveType: 'slow-2g' }, false],
    [{ effectiveType: '4g', saveData: true }, false],
    [{}, true], // nothing known: nothing assumed
    [undefined, true],
  ])('%j -> prefetch %s', (connection, expected) => {
    expect(canPrefetch(connection as never)).toBe(expected)
  })

  it('the idle prefetch of the tabs asks first', () => {
    const app = src('src/App.tsx')
    expect(app).toMatch(/function prefetchTabs\(\) \{\s*\/\/[^\n]*\n\s*if \(!canPrefetch\(\)\) return/)
  })
})

describe('the balance', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T10:00:00Z')) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../src/services/api/auth') })

  it('is read at most every 15 seconds however often the screens ask; a failed read is tried again at once; a placed order resets the clock', async () => {
    vi.resetModules()
    const reads = vi.fn(async () => ({ balance: 7, currency: 'USD' }))
    vi.doMock('../src/services/api/auth', async (orig) => ({ ...(await orig<object>()), fetchWallet: reads, authenticateWithTelegram: async () => ({ token: 't', expiresAt: Date.now() / 1000 + 3600, isMock: false, wallet: { balance: 1, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } }) }))
    const { AuthProvider, useAuth, WALLET_FRESH_MS } = await import('../src/context/AuthContext')
    expect(WALLET_FRESH_MS).toBe(15_000)
    let api!: ReturnType<typeof useAuth>
    const Probe = () => { api = useAuth(); return null }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => { root.render(createElement(AuthProvider, null, createElement(Probe))) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    await act(async () => { await Promise.all([api.refreshWallet(), api.refreshWallet(), api.refreshWallet()]) })
    expect(reads).toHaveBeenCalledTimes(1) // three screens at once: one read
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); await api.refreshWallet() })
    expect(reads).toHaveBeenCalledTimes(1) // ten seconds later: the same
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); await api.refreshWallet() })
    expect(reads).toHaveBeenCalledTimes(2) // sixteen: read again

    reads.mockResolvedValueOnce(null as never) // a read that fails ...
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); await api.refreshWallet() })
    expect(reads).toHaveBeenCalledTimes(3)
    await act(async () => { await api.refreshWallet() }) // ... is tried again at the very next ask
    expect(reads).toHaveBeenCalledTimes(4)

    await act(async () => { api.applyWallet({ balance: 3, currency: 'USD' }); await api.refreshWallet() })
    expect(reads).toHaveBeenCalledTimes(4) // an order has just told the balance: nothing to read
    act(() => root.unmount())
  })
})

describe('the document', () => {
  it('asks Google Fonts for one variable-weight family (a fraction of the stylesheet; the same four files)', () => {
    const html = src('index.html')
    expect(html).toContain('family=Plus+Jakarta+Sans:wght@400..800&display=swap')
    expect(html).not.toContain('wght@400;500;600;700;800')
  })
  it('does not use content-visibility on the cards: Telegram painted skipped cards only after a touch (see performance.test.ts)', () => {
    expect(src('src/index.css')).not.toContain('content-visibility')
  })
})
