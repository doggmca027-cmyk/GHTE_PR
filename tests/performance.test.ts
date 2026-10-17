// Load speed: what the first screen must not wait for, and the catalogue reads kept in memory.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedLoad, clearCatalogCache, isFresh, peekCached } from '../src/lib/catalog-cache'

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

describe('the first screen', () => {
  it('TON Connect (the heaviest library) is not loaded before the first screen: only the lazy wallet tab sets it up', () => {
    expect(src('src/main.tsx')).not.toMatch(/@tonconnect/)
    expect(src('src/App.tsx')).not.toMatch(/import\s*\{[^}]*\}\s*from\s*'@\/components\/wallet\/(WalletScreen|WalletRoute)'/)
    expect(src('src/App.tsx')).toContain("import('@/components/wallet/WalletRoute')")
    expect(src('src/components/wallet/WalletRoute.tsx')).toContain('TonConnectUIProvider')
  })

  it('tabs other than Home and the catalogue are their own chunks, fetched when the browser is idle', () => {
    const app = src('src/App.tsx')
    for (const screen of ['OrdersScreen', 'SupportScreen', 'SettingsScreen', 'WebSignIn', 'AdminScreen']) {
      expect(app).toMatch(new RegExp(`const ${screen} = lazy\\(`))
      expect(app).not.toMatch(new RegExp(`import \\{[^}]*\\b${screen}\\b[^}]*\\} from`))
    }
    expect(app).toContain('requestIdleCallback')
  })

  it('the Telegram script does not block the page (deferred, still before the app bundle)', () => {
    const html = src('index.html')
    expect(html).toMatch(/<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js" defer><\/script>/)
    expect(html.indexOf('telegram-web-app.js')).toBeLessThan(html.indexOf('/src/main.tsx'))
  })
})

describe('the catalogue cache', () => {
  beforeEach(() => clearCatalogCache())

  it('a fresh value is served from memory; one request at a time per key', async () => {
    const load = vi.fn(async () => ['a'])
    const [a, b] = await Promise.all([cachedLoad('k', load), cachedLoad('k', load)])
    expect(a).toEqual(['a'])
    expect(b).toEqual(['a'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(await cachedLoad('k', load)).toEqual(['a'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(peekCached('k')).toEqual(['a'])
    expect(isFresh('k')).toBe(true)
  })

  it('after the freshness window it is still shown, and loaded again', async () => {
    const t0 = Date.now()
    await cachedLoad('k', async () => 1, t0)
    expect(isFresh('k', t0 + 3 * 60_000)).toBe(false)
    expect(peekCached('k', t0 + 3 * 60_000)).toBe(1)          // shown at once while it refreshes
    expect(peekCached('k', t0 + 16 * 60_000)).toBeUndefined() // too old to show
    expect(await cachedLoad('k', async () => 2, t0 + 3 * 60_000)).toBe(2)
  })

  it('a failed load is not remembered; the previous value survives it', async () => {
    await expect(cachedLoad('x', async () => { throw new Error('down') })).rejects.toThrow('down')
    expect(peekCached('x')).toBeUndefined()
    const t0 = Date.now()
    await cachedLoad('y', async () => 'old', t0)
    await expect(cachedLoad('y', async () => { throw new Error('down') }, t0 + 3 * 60_000)).rejects.toThrow('down')
    expect(peekCached('y')).toBe('old')
  })
})
