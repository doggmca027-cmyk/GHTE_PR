// The finished HTML of a page for a crawler (src/seo/render.ts), the sitemap of the whole site (scripts/lib/sitemap.ts) and the text for AI crawlers
// (public/llm-context.txt). The template is the app's REAL index.html, with its placeholders filled the way the build fills them.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fillPage } from '../scripts/lib/seo'
import { MAX_SITEMAP_URLS, buildFullSitemap, sitemapEntries } from '../scripts/lib/sitemap'
import { LANDING_LANGS, SEO_LANGS, allLandings, landingPath, parseLandingSlug, type SeoRoute } from '../src/seo/pages'
import { bodyHtml, escapeHtml, hreflangLinks, renderSeoHtml } from '../src/seo/render'
import { catalogServiceLd, ldScript, pageJsonLd } from '../src/seo/schema'

const root = path.resolve(import.meta.dirname, '..')
const SITE = 'https://hub.example'
const template = fillPage(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), SITE, { url: 'https://t.me/GHTE_PR_BOT', name: '@GHTE_PR_BOT' })
const route = (lang: SeoRoute['lang'], slug: string): SeoRoute => ({ lang, landing: parseLandingSlug(slug)! })
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

describe('1. the page a crawler is given', () => {
  const html = renderSeoHtml(template, SITE, route('es', 'buy-instagram-real-followers'), { botUrl: 'https://t.me/GHTE_PR_BOT' })

  it('has ONE title, ONE description, ONE canonical: the ones of this page, not of the template', () => {
    expect(count(html, /<title>/g)).toBe(1)
    expect(count(html, /<meta name="description"/g)).toBe(1)
    expect(count(html, /<link rel="canonical"/g)).toBe(1)
    expect(html).toContain('<title>Comprar seguidores reales de Instagram con TON | GRAM Hub</title>')
    expect(html).toContain(`<link rel="canonical" href="${SITE}/es/buy-instagram-real-followers" />`)
    expect(html).not.toContain('social media promotion paid with TON</title>') // the template's own title is gone
    expect(html).not.toContain('__SITE_URL__')
  })

  it('says the language and its direction on <html>, and Open Graph / Twitter for the page', () => {
    expect(html).toMatch(/<html lang="es" dir="ltr">/)
    expect(renderSeoHtml(template, SITE, route('ar', 'buy-instagram-real-followers'))).toMatch(/<html lang="ar" dir="rtl">/)
    expect(html).toContain('<meta property="og:locale" content="es_ES" />')
    expect(html).toContain(`<meta property="og:url" content="${SITE}/es/buy-instagram-real-followers" />`)
    expect(count(html, /<meta property="og:title"/g)).toBe(1)
    expect(count(html, /<meta name="twitter:title"/g)).toBe(1)
  })

  it('lists every language of the page as an alternate, reciprocally, plus x-default (English): the set is the same on every language version', () => {
    const links = hreflangLinks(SITE, route('es', 'buy-instagram-real-followers').landing)
    expect(links).toHaveLength(LANDING_LANGS.length + 1)
    const sets = LANDING_LANGS.map((lang) => hreflangLinks(SITE, route(lang, 'buy-instagram-real-followers').landing).join('|'))
    expect(new Set(sets).size).toBe(1)
    expect(links.at(-1)).toBe(`<link rel="alternate" hreflang="x-default" href="${SITE}/en/buy-instagram-real-followers" />`)
    expect(count(html, /hreflang=/g)).toBe(LANDING_LANGS.length + 1) // the template's lonely x-default was replaced, not added to
  })

  it('the home page lists all 15 languages, English at "/"', () => {
    const home = renderSeoHtml(template, SITE, { lang: 'ru', landing: { type: 'home' } })
    expect(count(home, /hreflang=/g)).toBe(SEO_LANGS.length + 1)
    expect(home).toContain(`hreflang="en" href="${SITE}/"`)
    expect(home).toContain(`hreflang="ru" href="${SITE}/ru/"`)
    expect(home).toContain('<title>GRAM Hub — продвижение в соцсетях за TON</title>')
  })

  it('writes the text of the page inside #root, for a crawler that does not run JavaScript: heading, introduction, the facts, the questions, the ways in', () => {
    const body = html.slice(html.indexOf('<div id="root">'), html.indexOf('</div>', html.indexOf('<div id="root">')) + 6)
    expect(body).toContain('<h1>Comprar seguidores reales de Instagram con TON</h1>')
    expect(body).toContain('<li>Reembolso automático cuando un pedido no se puede entregar.</li>')
    expect(body).toContain('<dt>¿Puedo pagar con TON?</dt>')
    expect(body).toContain('href="https://t.me/GHTE_PR_BOT">Abrir en Telegram</a>')
    expect(body).toContain(`href="${SITE}/">Abrir la versión web</a>`)
    expect(body).toContain('href="/es/buy-telegram-followers"') // the sibling pages are linked (crawling and discovery)
    expect(body).not.toContain('href="/es/buy-instagram-real-followers"') // not to itself
  })

  it('keeps what is not about the page: the Telegram script, the icons, the bundles; and leaves the app\'s root for the app', () => {
    expect(html).toContain('telegram-web-app.js')
    expect(html).toContain('<script type="module"')
    expect(html).toContain('rel="icon"')
  })

  it('the dollar sign of "$0,10" arrives as it is written (a replacement string would have read it as a pattern)', () => {
    expect(html).toContain('pedidos desde $0,10')
    expect(html).toContain('el pedido mínimo es de $0,10')
  })

  it('every <, >, & and " of a text is escaped: nothing a text says can become markup', () => {
    expect(escapeHtml('<script>"a" & b</script>')).toBe('&lt;script&gt;&quot;a&quot; &amp; b&lt;/script&gt;')
    for (const slug of ['buy-telegram-followers', 'crypto-smm-panel']) {
      const page = renderSeoHtml(template, SITE, route('ru', slug))
      const root = page.slice(page.indexOf('<div id="root">'))
      expect(root.slice(0, root.indexOf('</main>'))).not.toMatch(/<script/i)
    }
  })

  it('a topic page has its own heading and the questions; the body of the home page has no facts list of its own', () => {
    expect(bodyHtml(SITE, route('en', 'crypto-smm-panel'))).toContain('<h1>SMM panel with crypto payments (TON)</h1>')
    expect(bodyHtml(SITE, { lang: 'en', landing: { type: 'home' } })).not.toContain('<dl>')
  })
})

describe('2. structured data (JSON-LD) and the "Product / Offer" of a service', () => {
  const blocks = (page: string) => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!))

  it('a service page carries Organization, Product and FAQPage as valid JSON; the Product has NO price (none is known, none is invented)', () => {
    const data = blocks(renderSeoHtml(template, SITE, route('en', 'buy-telegram-premium-followers'), { botUrl: 'https://t.me/GHTE_PR_BOT' }))
    expect(data.map((d) => d['@type'])).toEqual(['Organization', 'Product', 'FAQPage'])
    expect(data[0].sameAs).toEqual(['https://t.me/GHTE_PR_BOT'])
    expect(data[1]).toMatchObject({ name: 'Buy Telegram premium followers with TON', brand: { name: 'GRAM Hub' }, inLanguage: 'en' })
    expect(data[1].offers).toBeUndefined()
    expect(data[2].mainEntity).toHaveLength(3)
  })

  it('...and an Offer only when someone who knows the price gives it', () => {
    const [, product] = pageJsonLd(SITE, 'en', parseLandingSlug('buy-telegram-followers')!, { priceFromUsd: 0.5 })
    expect(product!.offers).toMatchObject({ '@type': 'Offer', priceCurrency: 'USD', price: '0.5', availability: 'https://schema.org/InStock' })
    expect((pageJsonLd(SITE, 'en', parseLandingSlug('buy-telegram-followers')!, { priceFromUsd: -1 })[1] as { offers?: unknown }).offers).toBeUndefined()
    expect((pageJsonLd(SITE, 'en', parseLandingSlug('buy-telegram-followers')!, { priceFromUsd: Number.NaN })[1] as { offers?: unknown }).offers).toBeUndefined()
  })

  it('a service of the catalogue is a Product with an Offer of its REAL price per 1,000 and its own limits', () => {
    const ld = catalogServiceLd({ name: 'Telegram Post Views', sku: 'TG-VIEW-STD-AB12CD', platformName: 'Telegram', ratePer1000: 0.12, minQuantity: 100, maxQuantity: 1_000_000 }) as {
      sku: string
      offers: { price: string; priceCurrency: string; eligibleQuantity: object; priceSpecification: { referenceQuantity: { value: number } } }
    }
    expect(ld.sku).toBe('TG-VIEW-STD-AB12CD')
    expect(ld.offers).toMatchObject({ price: '0.12', priceCurrency: 'USD', eligibleQuantity: { minValue: 100, maxValue: 1_000_000 } })
    expect(ld.offers.priceSpecification.referenceQuantity.value).toBe(1000)
  })

  it('what is written into a <script> cannot close it', () => {
    const s = ldScript({ name: '</script><script>alert(1)</script>', text: 'a b' })
    expect(s).not.toContain('</script>')
    expect(s).not.toContain('<')
    expect(s).not.toContain(' ')
    expect(JSON.parse(s).name).toBe('</script><script>alert(1)</script>')
  })
})

describe('3. sitemap.xml of the whole site', () => {
  const xmlOf = buildFullSitemap(SITE, '2026-11-06')
  const entries = sitemapEntries(SITE)

  it('lists the 15 home pages, every landing page in every language it is written in, and the legal pages: 181 URLs, far under the 50,000 of one file', () => {
    expect(entries).toHaveLength(SEO_LANGS.length + allLandings().length * LANDING_LANGS.length + 6)
    expect(entries).toHaveLength(181)
    expect(entries.length).toBeLessThan(MAX_SITEMAP_URLS)
    expect(new Set(entries.map((e) => e.loc)).size).toBe(entries.length) // no URL twice
    expect((xmlOf.match(/<url>/g) ?? []).length).toBe(181)
  })

  it('every URL is absolute, on the site, and lists ALL its language versions plus x-default; the list is the same on every version (reciprocal)', () => {
    for (const e of entries) {
      expect(e.loc.startsWith(`${SITE}/`)).toBe(true)
      expect(e.alternates.some((a) => a.href === e.loc)).toBe(true) // itself is in its own set
      expect(e.alternates.at(-1)!.hreflang).toBe('x-default')
    }
    const byGroup = new Map<string, string[]>()
    for (const e of entries) byGroup.set(e.alternates.map((a) => a.href).join('|'), [...(byGroup.get(e.alternates.map((a) => a.href).join('|')) ?? []), e.loc])
    for (const [set, members] of byGroup) for (const m of members) expect(set.split('|')).toContain(m)
  })

  it('the multiplication the brief asks for: platforms x services x languages (plus the flavours and the topics)', () => {
    const urls = entries.map((e) => e.loc)
    for (const lang of LANDING_LANGS) {
      expect(urls).toContain(`${SITE}${landingPath(lang, parseLandingSlug('buy-telegram-views')!)}`)
      expect(urls).toContain(`${SITE}${landingPath(lang, parseLandingSlug('buy-spotify-plays')!)}`)
      expect(urls).toContain(`${SITE}${landingPath(lang, parseLandingSlug('buy-telegram-premium-followers')!)}`)
      expect(urls).toContain(`${SITE}/${lang}/crypto-smm-panel`)
    }
    expect(urls).not.toContain(`${SITE}/de/buy-telegram-views`) // no German text: no German page
    expect(urls).toContain(`${SITE}/de/`) // but the German home page is there
  })

  it('is valid XML: the namespaces, the escaping, the date', () => {
    expect(xmlOf.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xmlOf).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(xmlOf).toContain('<lastmod>2026-11-06</lastmod>')
    expect(buildFullSitemap('https://a.example/?x=1&y=2', '2026-11-06')).toContain('&amp;')
    expect(xmlOf).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
  })
})

describe('4. llm-context.txt: the text for AI crawlers says what is true, and what is not offered', () => {
  const llm = fs.readFileSync(path.join(root, 'public/llm-context.txt'), 'utf8')

  it('leaves exactly the three placeholders the build fills (address, bot link, bot name is not used) and nothing else', () => {
    const found = new Set(llm.match(/__[A-Z_]+__/g))
    expect([...found].sort()).toEqual(['__BOT_URL__', '__SITE_URL__'])
    const filled = fillPage(llm, SITE, { url: 'https://t.me/GHTE_PR_BOT', name: '@GHTE_PR_BOT' })
    expect(filled).not.toMatch(/__[A-Z_]+__/)
    expect(filled).toContain(`${SITE}/en/crypto-smm-panel`)
    expect(filled).toContain('https://t.me/GHTE_PR_BOT')
  })

  it('the facts of the brief: TON, the prepaid USD balance, automatic refunds, the minimum order, Refill, drip-feed, 15 languages', () => {
    for (const fact of ['TON', 'prepaid USD balance', 'returned to the balance automatically', '$0.10', 'Refill:', 'Drip-feed:', 'Real, HQ', '15 languages', 'Premium']) expect(llm, fact).toContain(fact)
  })

  it('what is NOT promised is said as plainly: no immunity from the algorithms, no account safety, no position in a search, no API', () => {
    expect(llm).toContain('No immunity from the algorithms of social networks')
    expect(llm).toContain('No guarantee about the safety of an account')
    expect(llm).toContain('no promise about a position in a search engine')
    expect(llm).toContain('No public API for customers')
  })

  it('says nothing about who the suppliers are (the rule of the assistant\'s prompt: never), and every page it names is a page that exists', () => {
    expect(llm).not.toMatch(/Secsers|MoreThanPanel|RootPanel|\bJAP\b|SMMFollows|supplier|provider/i)
    const known = new Set(entries().map((e) => e.replace(SITE, '')))
    for (const m of llm.matchAll(/__SITE_URL__(\/[a-z0-9/.-]*)/g)) {
      const p = m[1]!.replace(/[.,]$/, '').replace(/\/$/, '') || '/'
      expect([...known, '/terms', '/privacy', '/sitemap.xml', '/'].includes(p) || p === '', p).toBe(true)
    }
  })

  function entries() {
    return sitemapEntries(SITE).map((e) => e.loc.replace(/\/$/, '') || '/')
  }
})
