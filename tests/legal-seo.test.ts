// The public legal pages are indexable: one canonical URL each, a complete and reciprocal hreflang set, valid structured data,
// working anchors and links; postbuild fills the placeholders and publishes robots.txt and sitemap.xml.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOT_NAME_PLACEHOLDER, BOT_URL_PLACEHOLDER, DOCS, DOC_LANGS, SITE_PLACEHOLDER, botLink, buildRobots, buildSitemap, docFile, docPath, fillPage } from '../scripts/lib/seo'
import { legalDocPath } from '../src/lib/legal'

const PUBLIC = path.resolve(__dirname, '../public')
const SITE = 'https://ghte-pr.vercel.app'
const BOT = { url: 'https://t.me/GHTE_PR_BOT', name: '@GHTE_PR_BOT' }
const read = (file: string) => fs.readFileSync(path.join(PUBLIC, file), 'utf8')
const attr = (html: string, re: RegExp) => re.exec(html)?.[1] ?? null
const all = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m.slice(1))

const pages = DOCS.flatMap((doc) => DOC_LANGS.map((lang) => ({ doc, lang, file: docFile(doc, lang), html: read(docFile(doc, lang)) })))

describe('legal pages', () => {
  it('are the six documents: terms and privacy in English (root), Russian and Ukrainian', () => {
    expect(pages.map((p) => p.file)).toEqual(['terms.html', 'ru/terms.html', 'uk/terms.html', 'privacy.html', 'ru/privacy.html', 'uk/privacy.html'])
  })

  it.each(pages.map((p) => [p.file, p] as const))('%s: language, title, description, robots, one h1', (_f, p) => {
    expect(attr(p.html, /<html lang="([a-z]+)"/)).toBe(p.lang)
    const title = attr(p.html, /<title>([^<]+)<\/title>/)!
    expect(title.length).toBeGreaterThan(10)
    expect(title.length).toBeLessThanOrEqual(60) // shown whole in search results
    expect(title).toContain('GRAM Hub')
    const description = attr(p.html, /<meta name="description" content="([^"]+)"/)!
    expect(description.length).toBeGreaterThanOrEqual(110)
    expect(description.length).toBeLessThanOrEqual(175)
    expect(p.html).toContain('<meta name="robots" content="index, follow')
    expect(all(p.html, /<h1[ >]/g)).toHaveLength(1)
    expect(p.html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}">/)
  })

  it.each(pages.map((p) => [p.file, p] as const))('%s: canonical and a complete, reciprocal hreflang set', (_f, p) => {
    expect(attr(p.html, /<link rel="canonical" href="([^"]+)"/)).toBe(SITE_PLACEHOLDER + docPath(p.doc, p.lang))
    const alternates = Object.fromEntries(all(p.html, /<link rel="alternate" hreflang="([a-z-]+)" href="([^"]+)"/g))
    expect(alternates).toEqual({
      en: SITE_PLACEHOLDER + docPath(p.doc, 'en'), ru: SITE_PLACEHOLDER + docPath(p.doc, 'ru'), uk: SITE_PLACEHOLDER + docPath(p.doc, 'uk'),
      'x-default': SITE_PLACEHOLDER + docPath(p.doc, 'en'),
    })
    expect(attr(p.html, /<meta property="og:url" content="([^"]+)"/)).toBe(SITE_PLACEHOLDER + docPath(p.doc, p.lang))
  })

  it.each(pages.map((p) => [p.file, p] as const))('%s: structured data is valid JSON-LD describing this page', (_f, p) => {
    const raw = attr(fillPage(p.html, SITE, BOT), /<script type="application\/ld\+json">([\s\S]*?)<\/script>/)!
    const graph = (JSON.parse(raw) as { '@graph': Record<string, unknown>[] })['@graph']
    const page = graph.find((n) => n['@type'] === 'WebPage')!
    expect(page).toMatchObject({ url: SITE + docPath(p.doc, p.lang), inLanguage: p.lang, dateModified: '2026-10-12' })
    expect(graph.find((n) => n['@type'] === 'Organization')).toMatchObject({ name: 'GRAM Hub', sameAs: [BOT.url] })
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList') as { itemListElement: { item: string }[] }
    expect(crumbs.itemListElement.at(-1)!.item).toBe(SITE + docPath(p.doc, p.lang))
  })

  it.each(pages.map((p) => [p.file, p] as const))('%s: every in-page anchor exists, every internal link is a real page', (_f, p) => {
    const ids = new Set(all(p.html, /\sid="([^"]+)"/g).map(([id]) => id))
    for (const [anchor] of all(p.html, /href="#([^"]+)"/g)) expect(ids.has(anchor), `#${anchor}`).toBe(true)
    const known = new Set(['/', ...DOCS.flatMap((d) => DOC_LANGS.map((l) => docPath(d, l)))])
    for (const [href] of all(p.html, /href="(\/[^"]*)"/g)) {
      if (href.endsWith('.css') || href.endsWith('.png')) expect(fs.existsSync(path.join(PUBLIC, href))).toBe(true)
      else expect(known.has(href), href).toBe(true)
    }
  })

  it('the three language versions of a document have the same sections', () => {
    for (const doc of DOCS) {
      const sections = DOC_LANGS.map((l) => all(read(docFile(doc, l)), /<section id="([^"]+)"/g).map(([id]) => id).join())
      expect(new Set(sections).size, doc).toBe(1)
    }
  })

  it('filled pages have no placeholder left and link the bot', () => {
    for (const p of pages) {
      const out = fillPage(p.html, `${SITE}/`, BOT)
      expect(out).not.toContain(SITE_PLACEHOLDER)
      expect(out).not.toContain(BOT_URL_PLACEHOLDER)
      expect(out).not.toContain(BOT_NAME_PLACEHOLDER)
      expect(out).toContain(`<link rel="canonical" href="${SITE}${docPath(p.doc, p.lang)}"`)
      expect(out).toContain('<a href="https://t.me/GHTE_PR_BOT">@GHTE_PR_BOT</a>')
    }
    expect(fillPage(`<a href="${BOT_URL_PLACEHOLDER}">${BOT_NAME_PLACEHOLDER}</a>`, SITE, null)).toBe('<a href="https://telegram.org">Telegram</a>')
  })
})

describe('robots.txt and sitemap.xml', () => {
  it('robots allows everything and announces the sitemap', () => {
    expect(buildRobots(`${SITE}/`)).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`)
    expect(buildRobots(undefined)).toBe('User-agent: *\nAllow: /\n')
  })

  it('the sitemap lists the six pages, each with all its language versions and x-default', () => {
    const xml = buildSitemap(SITE, '2026-10-12')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(all(xml, /<loc>([^<]+)<\/loc>/g).map(([u]) => u)).toEqual([
      `${SITE}/terms`, `${SITE}/ru/terms`, `${SITE}/uk/terms`, `${SITE}/privacy`, `${SITE}/ru/privacy`, `${SITE}/uk/privacy`,
    ])
    expect(all(xml, /<xhtml:link /g)).toHaveLength(6 * 4)
    expect(all(xml, /<lastmod>2026-10-12<\/lastmod>/g)).toHaveLength(6)
    expect(xml).not.toContain(`<loc>${SITE}/</loc>`) // the Mini App itself is not a search landing page
  })

  it('the bot link comes from the Mini App URL', () => {
    expect(botLink('https://t.me/GHTE_PR_BOT')).toEqual(BOT)
    expect(botLink('https://t.me/GHTE_PR_BOT/app/')).toEqual(BOT)
    expect(botLink('https://evil.example.com/x')).toBeNull()
    expect(botLink(undefined)).toBeNull()
  })
})

describe('Settings links', () => {
  it('open the document in the reader\'s language (Russian, Ukrainian), English otherwise', () => {
    expect(legalDocPath('terms', 'ru')).toBe('/ru/terms')
    expect(legalDocPath('privacy', 'uk')).toBe('/uk/privacy')
    expect(legalDocPath('terms', 'de')).toBe('/terms')
    expect(legalDocPath('privacy', 'en')).toBe('/privacy')
  })
})
