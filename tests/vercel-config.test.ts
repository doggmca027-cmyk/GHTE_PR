// vercel.json is checked by the validator Vercel itself runs when a deployment is created (@vercel/routing-utils). On 2026-11-06 a header rule with a nested
// capture group, "workbox-(.*).js", made Vercel refuse the whole deployment ("invalid-route-source-pattern") while every test and the build of CI were green:
// nothing in this repository read the file the way Vercel does. This test does.
import fs from 'node:fs'
import path from 'node:path'
import { getTransformedRoutes } from '@vercel/routing-utils'
import { describe, expect, it } from 'vitest'
import { sitemapEntries } from '../scripts/lib/sitemap'
import { LANDING_LANGS, SEO_LANGS, allLandings, landingSlug } from '../src/seo/pages'

const config = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../vercel.json'), 'utf8')) as {
  cleanUrls?: boolean
  redirects?: { source: string; destination: string; permanent?: boolean }[]
  rewrites?: { source: string; destination: string }[]
  headers?: { source: string; headers: { key: string; value: string }[] }[]
}
const transform = (c: typeof config) => getTransformedRoutes({ cleanUrls: c.cleanUrls, redirects: c.redirects, rewrites: c.rewrites, headers: c.headers })

describe('vercel.json as Vercel reads it', () => {
  it('is accepted: every redirect, rewrite and header pattern is valid (an invalid one fails the whole deployment)', () => {
    const { error, routes } = transform(config)
    expect(error?.message).toBeUndefined()
    expect(routes!.length).toBeGreaterThan(10)
  })

  it('the validator really refuses the mistake that broke the deployment (the control: this test can fail)', () => {
    const bad = transform({ headers: [{ source: '/(sw.js|registerSW.js|manifest.webmanifest|workbox-(.*).js)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }] })
    expect(bad.error?.code).toBe('invalid_header')
    expect(bad.error?.message).toContain('invalid `source` pattern')
    // ...and the way to write it that is accepted
    expect(transform({ headers: [{ source: '/(sw.js|workbox-.*.js)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }] }).error).toBeNull()
  })

  it('every source of the file is checked one by one, so a failure names the rule', () => {
    for (const [kind, rules] of [['redirect', config.redirects ?? []], ['rewrite', config.rewrites ?? []], ['header', config.headers ?? []]] as const) {
      for (const rule of rules) {
        const one = kind === 'redirect' ? transform({ redirects: [rule as never] }) : kind === 'rewrite' ? transform({ rewrites: [rule as never] }) : transform({ headers: [rule as never] })
        expect(one.error?.message, `${kind} ${rule.source}`).toBeUndefined()
      }
    }
  })

  it('the order is what the site relies on: the redirect first, then the headers (which let the request go on), the files, and only then the rewrites', () => {
    const { routes } = transform(config)
    const list = routes!.map((r) => ('handle' in r && r.handle ? `handle:${r.handle}` : String((r as { src?: string }).src)))
    const files = list.indexOf('handle:filesystem')
    expect(files).toBeGreaterThan(0)
    const at = (needle: RegExp) => list.findIndex((s) => needle.test(s))
    expect(at(/buy-\[a-z0-9-\]\+/)).toBeLessThan(files) // the bare /buy-... redirect to /en/
    expect(at(/sw\.js/)).toBeLessThan(files) // the headers of the worker
    expect(list.findIndex((s, i) => i > files && /\(en\|ru\|uk\|es\|pt/.test(s))).toBeGreaterThan(files) // the rewrite to the app, after the real files
  })

  it('with cleanUrls a rewrite to the app must point at "/", never at "/index.html" (that address is itself a redirect to "/": the rewrite ended in NOT_FOUND on production)', () => {
    expect(config.cleanUrls).toBe(true)
    for (const r of config.rewrites ?? []) {
      expect(r.destination, r.source).toBe('/')
      expect(r.destination).not.toMatch(/index(\.html)?$/)
    }
    const { routes } = transform(config)
    const redirectsIndex = routes!.find((r) => /index/.test(String((r as { src?: string }).src)) && (r as { status?: number }).status === 308)
    expect(redirectsIndex, 'cleanUrls redirects /index.html to /').toBeTruthy()
  })

  describe('every address of the site opens for a person (the 404 of "/ru/" on production: the rewrite had no optional trailing slash)', () => {
    type Rule = { src?: string; dest?: string; handle?: string }
    /** The addresses that do not open: neither a file of public/ (the legal pages, served without ".html" by cleanUrls) nor a rewrite to the app. */
    const unreachable = (c: typeof config, paths: string[]): string[] => {
      const routes = (transform(c).routes ?? []) as Rule[]
      const after = routes.slice(routes.findIndex((r) => r.handle === 'filesystem') + 1).filter((r) => r.src && r.dest)
      const opens = (p: string) => {
        if (p === '/') return true // public/index.html of the build
        const file = path.resolve(import.meta.dirname, '../public', `${p.replace(/\/+$/, '').slice(1)}.html`)
        return fs.existsSync(file) || after.some((r) => new RegExp(r.src!).test(p))
      }
      return paths.filter((p) => !opens(p))
    }
    const sitemapPaths = sitemapEntries('https://hub.example').map((e) => new URL(e.loc).pathname)
    const withSlash = (ps: string[]) => ps.flatMap((p) => (p === '/' ? [p] : [p, `${p.replace(/\/+$/, '')}/`]))
    const everyLanguage = SEO_LANGS.map((l) => `/${l}`)

    it('every URL of the sitemap, and the home page of each of the 15 languages, with and without a trailing slash', () => {
      expect(unreachable(config, withSlash([...sitemapPaths, ...everyLanguage]))).toEqual([])
    })

    it('the control: the rewrites as they were (no optional slash) leave "/ru/" and the landing pages with a slash unreachable, so this test can fail', () => {
      const old = { ...config, rewrites: (config.rewrites ?? []).map((r) => ({ ...r, source: r.source.replace('{/}?', '') })) }
      expect(unreachable(old, withSlash([...sitemapPaths, ...everyLanguage]))).toEqual(expect.arrayContaining(['/ru/', '/es/buy-instagram-followers/']))
    })

    it('what is not a page does not open (a made-up address is a 404, never the app under a thin duplicate address), and neither does a page that is prepared but not published', () => {
      const notPages = ['/xx/', '/ru/anything', '/de/buy-telegram-views', '/en/buy-telegram-views/extra', '/en/buy-telegram-likes', '/en/buy-garbage', '/en/buy-telegram-slow-auto-views', '/buy-telegram-slow-auto-views']
      expect(unreachable(config, notPages)).toEqual(notPages)
    })

    it('the slugs in the rewrite and in the redirect are EXACTLY the pages of the table, the languages those of the table: a page is added in one place and a test says where the other is missing', () => {
      const listOf = (source: string, name: string) => new RegExp(`:${name}\\(([^)]*)\\)`).exec(source)![1]!.split('|').sort()
      const expected = allLandings().map(landingSlug).sort()
      expect(listOf(config.redirects![0]!.source, 'slug')).toEqual(expected)
      expect(listOf(config.rewrites![1]!.source, 'slug')).toEqual(expected)
      expect(listOf(config.rewrites![1]!.source, 'lang')).toEqual([...LANDING_LANGS].sort())
      expect(listOf(config.rewrites![0]!.source, 'lang')).toEqual([...SEO_LANGS].sort())
    })
  })

  it('the static pages keep their address: a rewrite never reaches /ru/terms or /uk/privacy (they are files, and files come first)', () => {
    const { routes } = transform(config)
    const list = routes!.map((r) => String((r as { src?: string }).src ?? ''))
    for (const p of ['/ru/terms', '/uk/privacy', '/terms']) {
      const rewriteHits = (config.rewrites ?? []).filter((r) => new RegExp(`^${r.source.replace(/:\w+\(([^)]*)\)/g, '($1)')}$`).test(p))
      expect(rewriteHits, p).toEqual([])
    }
    expect(list.some((s) => /llm-context/.test(s))).toBe(true)
  })
})
