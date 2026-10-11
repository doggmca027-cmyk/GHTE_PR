// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebApp } from '../src/lib/webapp'
import { SCREEN_COLOR, applyScheme, detectScheme, initTheme } from '../src/lib/theme'
import { describeServiceDetails } from '../src/lib/service-view'
// @ts-expect-error the config is plain JavaScript without a declaration file
import tailwindConfig from '../tailwind.config.js'

const telegram = WebApp as unknown as { colorScheme?: string; onEvent?: (e: string, cb: () => void) => void }

afterEach(() => {
  delete telegram.colorScheme
  delete telegram.onEvent
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

describe('the colour scheme', () => {
  it('follows Telegram when the app runs inside it', () => {
    telegram.colorScheme = 'dark'
    expect(detectScheme()).toBe('dark')
    telegram.colorScheme = 'light'
    expect(detectScheme()).toBe('light')
  })

  it('follows the browser outside Telegram', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark'), addEventListener: () => {}, removeEventListener: () => {} }))
    expect(detectScheme()).toBe('dark')
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    expect(detectScheme()).toBe('light')
  })

  it('is written to <html> and to the theme-color meta', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#EBF3FE">'
    applyScheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(SCREEN_COLOR.dark)
  })

  it('is re-applied when Telegram reports a theme change', () => {
    let listener: (() => void) | undefined
    telegram.colorScheme = 'light'
    telegram.onEvent = (event, cb) => { if (event === 'themeChanged') listener = cb }
    expect(initTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    telegram.colorScheme = 'dark'
    listener!()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('the palette', () => {
  it('has a dark value for every colour variable the light theme defines', () => {
    const plugin = (tailwindConfig as { plugins: Array<{ handler: (api: { addBase: (b: Record<string, Record<string, string>>) => void }) => void }> }).plugins[0]!
    let base: Record<string, Record<string, string>> = {}
    plugin.handler({ addBase: (b) => { base = b } })
    const light = Object.keys(base[':root']!).filter((k) => k.startsWith('--'))
    const dark = Object.keys(base[':root[data-theme="dark"]']!).filter((k) => k.startsWith('--'))
    expect(light.length).toBeGreaterThan(40)
    expect(dark.sort()).toEqual(light.sort())
    expect(base[':root[data-theme="dark"]']!['--screen']).toBe('14 22 33') // Telegram's night background #0E1621
  })

  it('leaves no fixed white or pale-blue background in the screens (they would stay bright in the dark theme)', () => {
    for (const f of ['components/services/OrderModal.tsx', 'components/services/ServiceCard.tsx', 'components/layout/Layout.tsx', 'components/wallet/BalanceCard.tsx']) {
      const src = readFileSync(`src/${f}`, 'utf8')
      expect(src, f).not.toMatch(/\bbg-white\b|#EBF3FE|#EDF4FD|#F8FAFC/)
    }
  })
})

describe('the description rows', () => {
  it('explain each fact in a full sentence, in the panel\'s order', () => {
    const rows = describeServiceDetails({ refill: 45, startMax: 0, speed: 3000, real: true, drop: 'none', geo: ['US'] }, 'en-US')
    expect(rows.map((r) => r.kind)).toEqual(['refill', 'guarantee', 'start', 'speed', 'quality', 'geo'])
    expect(rows[0]!.text).toMatch(/^Recovery: 45 days — .*support ticket with the order number/)
    expect(rows[1]!.text).toBe('Guarantee: yes — against drops within 45 days')
    expect(rows[2]!.text).toMatch(/^Start time: instant — /)
    expect(rows[3]!.text).toMatch(/^Average speed: up to 3K per day — /)
    expect(rows[4]!.text).toBe('Quality: Real accounts, No drops')
  })

  it('says nothing about what the service does not state', () => {
    expect(describeServiceDetails(undefined, 'en-US')).toEqual([])
    expect(describeServiceDetails({}, 'en-US')).toEqual([])
    expect(describeServiceDetails({ refill: 'none' }, 'en-US').map((r) => r.kind)).toEqual(['refill', 'guarantee'])
  })
})

describe('the customer\'s choice', () => {
  it('overrides Telegram, is remembered on the device, and "auto" goes back to following Telegram', async () => {
    const { getThemePreference, setThemePreference, THEME_STORAGE_KEY } = await import('../src/lib/theme')
    telegram.colorScheme = 'light'
    setThemePreference('dark')
    expect(detectScheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    setThemePreference('light')
    telegram.colorScheme = 'dark'
    expect(detectScheme()).toBe('light')
    setThemePreference('auto')
    expect(getThemePreference()).toBe('auto')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(detectScheme()).toBe('dark')
  })
})
