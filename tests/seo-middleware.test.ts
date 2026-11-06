// The Edge middleware (middleware.ts): crawlers get the finished page of a public address, people and everything unknown pass through untouched, and an
// error never fails a crawl. The platform's own fetch is injected, so nothing here touches a network.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import middleware, { config } from '../middleware'
import { fillPage } from '../scripts/lib/seo'
import { BOT_AGENTS, isBot } from '../src/seo/bots'

const root = path.resolve(import.meta.dirname, '..')
const INDEX = fillPage(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), 'https://hub.example', { url: 'https://t.me/x', name: '@x' })
const GOOGLE = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const CHATGPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'

const ask = (pathname: string, ua: string, init: RequestInit = {}) => new Request(`https://hub.example${pathname}`, { headers: { 'user-agent': ua, ...(init.headers as object) }, method: init.method })
const env = { APP_URL: 'https://hub.example', VITE_TWA_RETURN_URL: 'https://t.me/GHTE_PR_BOT/app' }
const passes = (res: Response) => res.headers.get('x-middleware-next') === '1'

/** A fetch that serves the app's index.html for "/" (as the static site does) and records what was asked. */
function site(over: { html?: string; status?: number; type?: string } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(over.html ?? INDEX, { status: over.status ?? 200, headers: { 'content-type': over.type ?? 'text/html; charset=utf-8' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

// the middleware keeps the template ten minutes: every test starts from a cold instance
beforeEach(() => { vi.resetModules() })
const fresh = async () => (await import('../middleware')).default

describe('1. who gets the finished page: crawlers, and only on an address that is a page', () => {
  it('Googlebot asking for a landing page gets the page: its title, canonical and text in the HTML', async () => {
    const { fn } = site()
    const res = await (await fresh())(ask('/es/buy-instagram-followers', GOOGLE), { fetch: fn, env })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-language')).toBe('es')
    const html = await res.text()
    expect(html).toContain('<title>Comprar seguidores de Instagram con TON | GRAM Hub</title>')
    expect(html).toContain('<link rel="canonical" href="https://hub.example/es/buy-instagram-followers" />')
    expect(html).toContain('<h1>Comprar seguidores de Instagram con TON</h1>')
    expect(html).toContain('href="https://t.me/GHTE_PR_BOT">Abrir en Telegram</a>')
    expect((html.match(/hreflang=/g) ?? []).length).toBe(6) // en ru uk es ar + x-default
  })

  it('an AI crawler (ChatGPT-User) gets the same: it reads the page without running its JavaScript', async () => {
    const res = await (await fresh())(ask('/en/buy-telegram-slow-auto-views', CHATGPT), { fetch: site().fn, env })
    const html = await res.text()
    expect(html).toContain('<h1>Buy Telegram slow auto views with TON</h1>')
    expect(html).toContain('application/ld+json')
  })

  it('"/" is the English home page for a crawler; "/ru/" the Russian one', async () => {
    const mw = await fresh()
    expect(await (await mw(ask('/', GOOGLE), { fetch: site().fn, env })).text()).toContain('<title>GRAM Hub — social media promotion paid with TON</title>')
    const ru = await (await mw(ask('/ru/', GOOGLE), { fetch: site().fn, env })).text()
    expect(ru).toContain('<title>GRAM Hub — продвижение в соцсетях за TON</title>')
    expect(ru).toContain('<html lang="ru" dir="ltr">')
  })

  it('a person gets nothing from it: the request goes on to the app', async () => {
    const { fn, calls } = site()
    expect(passes(await (await fresh())(ask('/es/buy-instagram-followers', HUMAN), { fetch: fn, env }))).toBe(true)
    expect(calls).toHaveLength(0) // not even the template is fetched
  })

  it.each(['/en/buy-telegram-likes', '/de/buy-telegram-followers', '/xx/', '/random', '/api/chat', '/assets/index.js', '/en/buy-telegram-followers/extra'])(
    'an address that is not a page is left to the normal routing, crawler or not: %s', async (p) => {
      expect(passes(await (await fresh())(ask(p, GOOGLE), { fetch: site().fn, env }))).toBe(true)
    },
  )

  it('only GET and HEAD are answered; a HEAD gets the headers and no body', async () => {
    const mw = await fresh()
    expect(passes(await mw(ask('/en/crypto-smm-panel', GOOGLE, { method: 'POST' }), { fetch: site().fn, env }))).toBe(true)
    const head = await mw(ask('/en/crypto-smm-panel', GOOGLE, { method: 'HEAD' }), { fetch: site().fn, env })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
})

describe('2. it never fails a crawl, and never loops', () => {
  it('the template is the app\'s own "/" fetched with the internal header, which makes that very request skip the middleware', async () => {
    const { fn, calls } = site()
    await (await fresh())(ask('/en/buy-tiktok-views', GOOGLE), { fetch: fn, env })
    expect(calls).toEqual([{ url: 'https://hub.example/', headers: expect.objectContaining({ 'x-seo-internal': '1' }) }])
    expect(passes(await (await fresh())(ask('/en/buy-tiktok-views', GOOGLE, { headers: { 'x-seo-internal': '1' } }), { fetch: fn, env }))).toBe(true)
  })

  it('the template is kept for ten minutes: the second crawl does not fetch it again', async () => {
    const mw = await fresh()
    const { fn, calls } = site()
    await mw(ask('/en/buy-tiktok-views', GOOGLE), { fetch: fn, env })
    await mw(ask('/en/buy-tiktok-likes', GOOGLE), { fetch: fn, env })
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['the site answers 500', { status: 500 }],
    ['the answer is not HTML', { type: 'application/json', html: '{}' }],
    ['the HTML has no #root (not the app)', { html: '<html><body>maintenance</body></html>' }],
  ])('%s: the request goes on untouched', async (_label, over) => {
    expect(passes(await (await fresh())(ask('/en/crypto-smm-panel', GOOGLE), { fetch: site(over).fn, env }))).toBe(true)
  })

  it('a fetch that throws, or a render that fails, is not an error for the crawler', async () => {
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(passes(await (await fresh())(ask('/en/crypto-smm-panel', GOOGLE), { fetch: boom, env }))).toBe(true)
  })

  it('the canonical address is APP_URL (the production one), not the host that was asked (a preview deployment)', async () => {
    const res = await (await fresh())(new Request('https://preview-abc.vercel.app/en/crypto-smm-panel', { headers: { 'user-agent': GOOGLE } }), { fetch: site().fn, env })
    expect(await res.text()).toContain('<link rel="canonical" href="https://hub.example/en/crypto-smm-panel" />')
  })

  it('without a bot link the page has no "Open in Telegram" (a dead link is worse than none)', async () => {
    const html = await (await (await fresh())(ask('/en/crypto-smm-panel', GOOGLE), { fetch: site().fn, env: { APP_URL: 'https://hub.example' } })).text()
    expect(html).not.toContain('Open in Telegram')
    expect(html).toContain('Open the web app')
  })
})

describe('3. the matcher: the middleware runs for crawlers ONLY, so people cost no invocation and no delay', () => {
  const rule = config.matcher[0]!
  const ua = new RegExp(rule.has[0]!.value)

  it('every crawler of the list is matched by the literal of the matcher, case as it is written by the crawlers', () => {
    for (const agent of BOT_AGENTS) expect(ua.test(`Mozilla/5.0 (compatible; ${agent}/1.0)`), agent).toBe(true)
    expect(rule.has[0]).toMatchObject({ type: 'header', key: 'user-agent' })
  })

  it('and the literal has no name the list does not (the two are one list)', () => {
    const named = rule.has[0]!.value.replace(/^\.\*\(|\)\.\*$/g, '').split('|')
    expect(named.sort()).toEqual([...BOT_AGENTS].sort())
  })

  it('people, assets, the API and files are not matched', () => {
    expect(ua.test(HUMAN)).toBe(false)
    expect(ua.test('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36 Telegram-Android/10.0')).toBe(false)
    const source = new RegExp(`^${rule.source}$`)
    expect(source.test('/es/buy-instagram-followers')).toBe(true)
    expect(source.test('/')).toBe(true) // the English home page is "/": a crawler gets its finished page too
    for (const p of ['/api/chat', '/assets/index-abc.js', '/sitemap.xml', '/llm-context.txt', '/sw.js', '/tonconnect-icon.png']) expect(source.test(p), p).toBe(false)
  })

  it('isBot is the same test in code', () => {
    expect(isBot(GOOGLE)).toBe(true)
    expect(isBot(CHATGPT)).toBe(true)
    expect(isBot('Mozilla/5.0 (compatible; OAI-SearchBot/1.0)')).toBe(true)
    expect(isBot(HUMAN)).toBe(false)
    expect(isBot('')).toBe(false)
    expect(isBot(null)).toBe(false)
  })
})

describe('4. what the default export is, for Vercel', () => {
  it('is a function of one request (Vercel passes nothing else) that returns a Response', async () => {
    expect(typeof middleware).toBe('function')
    expect(passes(await middleware(ask('/', HUMAN)))).toBe(true)
  })
})
