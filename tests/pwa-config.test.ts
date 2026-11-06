// The service worker (vite.pwa.ts): what it keeps, what it must never keep, how it updates. The decisions that matter are the ones that protect the rest of the
// app: the catalogue (kept per version by the CDN and by lib/catalog-cache.ts) and the API are never copied by the worker, and a new worker never reloads a
// page that is placing an order.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PWA_OPTIONS } from '../vite.pwa'

const workbox = PWA_OPTIONS.workbox!
type Match = (a: { url: URL; sameOrigin: boolean }) => boolean
const rules = workbox.runtimeCaching!
const ruleFor = (handler: string) => rules.find((r) => r.handler === handler)!
const at = (p: string, sameOrigin = true) => ({ url: new URL(`https://hub.example${p}`), sameOrigin })

describe('1. what the worker never keeps: the API and the catalogue (their own cache, per version, is the only one)', () => {
  const api = ruleFor('NetworkOnly').urlPattern as Match

  it('every /api/ address goes to the network only: the catalogue, its version, the assistant', () => {
    for (const p of ['/api/catalog', '/api/catalog-version', '/api/chat', '/api/anything']) expect(api(at(p)), p).toBe(true)
  })
  it('...and only the app\'s own: another origin\'s /api/ is not decided here', () => {
    expect(api(at('/api/catalog', false))).toBe(false)
    expect(api(at('/en/buy-telegram-followers'))).toBe(false)
  })
  it('no rule keeps Supabase or Telegram\'s script: the other origins are not matched by any caching rule but the fonts', () => {
    const cached = rules.filter((r) => r.handler !== 'NetworkOnly')
    for (const url of ['https://abc.supabase.co/rest/v1/services?select=id', 'https://telegram.org/js/telegram-web-app.js']) {
      for (const r of cached) {
        const p = r.urlPattern as Match | RegExp
        const hit = typeof p === 'function' ? p({ url: new URL(url), sameOrigin: false }) : p.test(url)
        expect(hit, `${r.handler} ${url}`).toBe(false)
      }
    }
  })
  it('the API rule is not shadowed by a rule that comes before it', () => {
    const order = rules.map((r) => r.handler)
    const first = rules.findIndex((r) => (typeof r.urlPattern === 'function' ? (r.urlPattern as Match)(at('/api/catalog')) : false))
    expect(order[first]).toBe('NetworkOnly')
  })
})

describe('2. what it keeps: the shell at once, the rest the first time it is used', () => {
  const globs = workbox.globPatterns!
  it('precaches the shell: index.html, the entry bundle and its CSS, the vendor chunks, the icon', () => {
    for (const g of ['index.html', 'assets/index-*.{js,css}', 'assets/react-vendor-*.js', 'assets/icons-*.js', 'tonconnect-icon.png']) expect(globs).toContain(g)
  })
  it('does NOT precache the admin panel, TON Connect or the other languages: a customer never pays for what they do not open', () => {
    const text = globs.join(' ')
    expect(text).not.toMatch(/Admin|ton-connect|mock|ru-|uk-|\*\.js'/)
    expect(globs.some((g) => g === '**/*' || g === '**/*.js')).toBe(false)
  })
  it('the hashed files of /assets/ are kept for good on first use (CacheFirst, bounded), the font renewed in the background', () => {
    const assets = ruleFor('CacheFirst')
    expect((assets.urlPattern as Match)(at('/assets/AdminScreen-abc.js'))).toBe(true)
    expect((assets.urlPattern as Match)(at('/sitemap.xml'))).toBe(false)
    expect(assets.options).toMatchObject({ cacheName: 'gh-assets', expiration: { maxEntries: 150 } })
    expect(ruleFor('StaleWhileRevalidate').options).toMatchObject({ cacheName: 'gh-fonts' })
  })
})

describe('3. navigation and updates', () => {
  const deny = workbox.navigateFallbackDenylist!
  const denied = (p: string) => deny.some((re) => re.test(p))

  it('an address of the app opens the cached shell offline; the API, the files and the static pages do not', () => {
    expect(workbox.navigateFallback).toBe('/index.html')
    for (const p of ['/', '/ru/', '/es/buy-instagram-followers', '/en/crypto-smm-panel']) expect(denied(p), p).toBe(false)
    for (const p of ['/api/chat', '/terms', '/privacy', '/ru/terms', '/uk/privacy', '/sitemap.xml', '/llm-context.txt', '/sw.js', '/assets/x.js']) expect(denied(p), p).toBe(true)
  })

  it('a new worker takes over at once but never reloads a page by itself (an order being placed is not interrupted); old caches are cleaned', () => {
    expect(PWA_OPTIONS.registerType).toBe('prompt')
    expect(workbox).toMatchObject({ skipWaiting: true, clientsClaim: true, cleanupOutdatedCaches: true })
  })

  it('is registered by the app after the page has loaded, not by a script of its own', () => {
    expect(PWA_OPTIONS.injectRegister).toBe(false)
    const reg = fs.readFileSync(path.resolve(import.meta.dirname, '../src/lib/pwa.ts'), 'utf8')
    expect(reg).toContain("window.addEventListener('load'")
    expect(reg).toContain('import.meta.env.DEV')
    expect(PWA_OPTIONS.devOptions).toEqual({ enabled: false })
  })

  it('the manifest names the app and starts at "/"', () => {
    expect(PWA_OPTIONS.manifest).toMatchObject({ name: 'GRAM Hub', start_url: '/', display: 'standalone' })
  })
})

describe('4. the headers that make the worker updatable (vercel.json)', () => {
  const vercel = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../vercel.json'), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
    rewrites: { source: string; destination: string }[]
    redirects: { source: string; destination: string; permanent: boolean }[]
  }
  const rule = (source: string) => vercel.headers.find((h) => h.source === source)!

  it('sw.js, the loader and the manifest are never cached by the browser (an old worker would keep an old app)', () => {
    const r = rule('/(sw.js|registerSW.js|manifest.webmanifest|workbox-.*.js)') // no nested capture group: Vercel refuses the whole deployment for one (tests/vercel-config.test.ts)
    expect(r.headers).toContainEqual({ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' })
    expect(r.headers).toContainEqual({ key: 'Service-Worker-Allowed', value: '/' })
  })
  it('the hashed assets stay immutable, as they were', () => {
    expect(rule('/assets/(.*)').headers).toContainEqual({ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' })
  })
  it('the landing addresses open the app (a rewrite), and only the ones that exist; a bare /buy-... goes to /en/ for good', () => {
    const langs = 'en|ru|uk|es|ar'
    expect(vercel.rewrites.map((r) => r.destination)).toEqual(['/index.html', '/index.html'])
    expect(vercel.rewrites[1]!.source).toContain(`(${langs})`)
    expect(vercel.redirects[0]).toMatchObject({ destination: '/en/:slug', permanent: true })
    expect(rule('/llm-context.txt').headers).toContainEqual({ key: 'Content-Type', value: 'text/plain; charset=utf-8' })
  })
})
