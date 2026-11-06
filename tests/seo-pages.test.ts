// The public pages (programmatic SEO): what exists, at which address, in which language, and what the words are allowed to say.
// Why a table and not a pattern: a page exists only for a (platform, service) pair the catalogue sells and only in a language it is written in, so an address
// that is not in the table is not a page (it answers 404, never a thin duplicate). The texts are checked against the promises the platform does not make.
import { describe, expect, it } from 'vitest'
import { LANGUAGES } from '../src/i18n/languages'
import { COPY, HOME_META, copyFor, pageText } from '../src/seo/copy'
import {
  FLAVORED, LANDING_LANGS, PREPARED_FLAVORED, SEO_LANGS, SEO_PLATFORMS, TOPICS, allLandings, landingPath, landingSlug, parseLandingSlug, parseSeoPath, type Landing,
} from '../src/seo/pages'

describe('1. the pages: one per (platform, service), a few flavours, two topics; the address says which', () => {
  it('every page has its address and the address finds the same page again', () => {
    for (const lang of LANDING_LANGS) {
      for (const landing of allLandings()) {
        const path = landingPath(lang, landing)
        expect(parseSeoPath(path), path).toEqual({ lang, landing })
        expect(parseSeoPath(`${path}/`), `${path}/`).toEqual({ lang, landing }) // a trailing slash is the same page
      }
    }
  })

  it('the addresses are the ones the brief names: /<lang>/buy-<platform>-<kind>, with a flavour between them where the catalogue has one', () => {
    const slugs = allLandings().map(landingSlug)
    expect(slugs).toContain('buy-telegram-followers')
    expect(slugs).toContain('buy-telegram-premium-followers') // "buy telegram premium followers with ton"
    expect(slugs).toContain('buy-instagram-real-followers') // "comprar seguidores instagram reales"
    expect(slugs).toHaveLength(32)
    expect(slugs).toContain('crypto-smm-panel')
    expect(slugs).toContain('smm-panel-for-agencies')
    expect(landingPath('es', parseLandingSlug('buy-instagram-followers')!)).toBe('/es/buy-instagram-followers')
    expect(new Set(slugs).size).toBe(slugs.length) // no two pages share an address
  })

  it('the English home page is "/" (x-default, as it always was); the home pages of the other languages are "/<lang>/"', () => {
    expect(landingPath('en', { type: 'home' })).toBe('/')
    expect(landingPath('ru', { type: 'home' })).toBe('/ru/')
    expect(parseSeoPath('/')).toBeNull() // "/" is the app itself; /en/ is its alias
    expect(parseSeoPath('/en/')).toEqual({ lang: 'en', landing: { type: 'home' } })
    expect(parseSeoPath('/ja')).toEqual({ lang: 'ja', landing: { type: 'home' } })
  })

  it.each([
    '/en/buy-telegram-likes', // Telegram has no likes
    '/en/buy-spotify-views', // Spotify sells plays
    '/en/buy-telegram-real-followers', // "real" exists for Instagram only
    '/en/buy-instagram-slow-auto-views', // the slow auto flavour is Telegram's, and not published at all
    '/en/buy-telegram-slow-auto-views', // prepared, not published: the storefront has no slow auto-views service yet (PREPARED_FLAVORED)
    '/en/buy-nowhere-followers', '/xx/buy-telegram-followers', '/en/buy-telegram-followers/extra', '/en/random', '/buy-telegram-followers', '/en/../etc/passwd',
    '/de/buy-telegram-followers', // German has no text of its own yet: not a page
  ])('"%s" is not a page', (path) => {
    expect(parseSeoPath(path)).toBeNull()
  })

  it('a flavour is only a page where the catalogue has the flavoured line (checked 2026-11-06: Telegram Premium followers 119, Instagram followers named Real 107)', () => {
    expect(FLAVORED.map((f) => `${f.platform}/${f.flavor}/${f.kind}`).sort()).toEqual(['instagram/real/followers', 'telegram/premium/followers'])
  })

  it('the slow auto views of Telegram are prepared but NOT published: no storefront service is both automatic and slow yet; the text is ready in every language', () => {
    expect(PREPARED_FLAVORED.map((f) => `${f.platform}/${f.flavor}/${f.kind}`)).toEqual(['telegram/slow-auto/views'])
    expect(allLandings().map(landingSlug)).not.toContain('buy-telegram-slow-auto-views')
    expect(parseLandingSlug('buy-telegram-slow-auto-views')).toBeNull()
    const telegram = SEO_PLATFORMS.find((p) => p.slug === 'telegram')!
    const prepared: Landing = { type: 'service', platform: telegram, kind: 'views', flavor: 'slow-auto' }
    expect(pageText('en', prepared).h1).toBe('Buy Telegram slow auto views with TON')
    expect(pageText('es', prepared).h1).toContain('vistas automáticas')
    expect(pageText('ru', prepared).h1).toContain('автопросмотры')
    expect(pageText('uk', prepared).h1).toContain('автоперегляди')
    expect(pageText('ar', prepared).h1).toContain('مشاهدات تلقائية')
    for (const lang of LANDING_LANGS) for (const s of Object.values(pageText(lang, prepared))) expect(s, lang).not.toMatch(/\{\w+\}/)
  })

  it('every page of the table is sold: its platform lists the kind', () => {
    for (const l of allLandings()) {
      if (l.type === 'service') expect(l.platform.kinds).toContain(l.kind)
    }
    expect(SEO_PLATFORMS.map((p) => p.slug)).toEqual(expect.arrayContaining(['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'spotify']))
  })
})

describe('2. the texts: complete in every language a page is written in, and true', () => {
  const all = Object.entries(COPY) as [keyof typeof COPY, NonNullable<(typeof COPY)[keyof typeof COPY]>][]

  it('a page is published only in a language that has its text, and every such language has one', () => {
    expect(Object.keys(COPY).sort()).toEqual([...LANDING_LANGS].sort())
    expect(LANDING_LANGS).toEqual(expect.arrayContaining(['en', 'es', 'ru', 'uk', 'ar'])) // the languages of the keyword matrix
  })

  it('the home page has a title and a description in all 15 languages of the app, none of them the English one in disguise', () => {
    expect(Object.keys(HOME_META).sort()).toEqual(LANGUAGES.map((l) => l.code).sort())
    expect(SEO_LANGS).toHaveLength(15)
    for (const lang of SEO_LANGS) {
      const m = HOME_META[lang]
      expect(m.title.length, lang).toBeGreaterThan(10)
      expect(m.title.length, lang).toBeLessThanOrEqual(70)
      expect(m.description.length, lang).toBeGreaterThan(80)
      expect(m.description.length, lang).toBeLessThanOrEqual(330)
      if (lang !== 'en') expect(m.title, lang).not.toBe(HOME_META.en.title)
      expect(m.title, lang).toContain('GRAM Hub')
      expect(m.title + m.description, lang).toContain('TON')
    }
  })

  it.each(LANDING_LANGS)('%s: every template and noun is there, and no placeholder is left unfilled on any page', (lang) => {
    const copy = copyFor(lang)
    expect(Object.values(copy.kinds).every((s) => s.length > 1)).toBe(true)
    expect(Object.keys(copy.flavored).sort()).toEqual(['premium-followers', 'real-followers', 'slow-auto-views'])
    expect(copy.facts).toHaveLength(4)
    expect(copy.faq).toHaveLength(3)
    for (const landing of allLandings()) {
      const t = pageText(lang, landing)
      for (const [field, s] of Object.entries(t)) {
        expect(s, `${lang} ${landingSlug(landing)} ${field}`).not.toMatch(/\{\w+\}/)
        expect(s.length, `${lang} ${landingSlug(landing)} ${field}`).toBeGreaterThan(8)
      }
      expect(t.title.length, `${lang} ${landingSlug(landing)} title`).toBeLessThanOrEqual(110)
    }
  })

  it('the pages of the brief say what the brief asks in the language of its keyword', () => {
    const page = (lang: 'en' | 'es' | 'ru' | 'uk' | 'ar', slug: string) => pageText(lang, parseLandingSlug(slug)!)
    expect(page('en', 'buy-telegram-premium-followers').h1).toBe('Buy Telegram premium followers with TON')
    expect(page('es', 'buy-instagram-real-followers').h1).toBe('Comprar seguidores reales de Instagram con TON')
    expect(page('ru', 'buy-telegram-premium-followers').h1).toBe('Купить премиум подписчиков Telegram за TON')
    expect(page('uk', 'buy-instagram-followers').h1).toBe('Купити підписників Instagram за TON')
    expect(page('ar', 'buy-instagram-real-followers').h1).toBe('شراء متابعين حقيقيين انستقرام بعملة TON') // "buy real Instagram followers"
    expect(page('en', 'crypto-smm-panel').h1).toContain('crypto')
    expect(page('en', 'smm-panel-for-agencies').h1).toContain('agencies')
  })

  it('Telegram sells subscribers: its "followers" page says so in every language', () => {
    expect(pageText('en', parseLandingSlug('buy-telegram-followers')!).h1).toBe('Buy Telegram subscribers with TON')
    expect(pageText('en', parseLandingSlug('buy-instagram-followers')!).h1).toBe('Buy Instagram followers with TON')
  })

  it('NOTHING the platform does not promise is promised: no safety, no guarantee against drops, no "cheapest", no API, no "100%", no position in a search', () => {
    const text = JSON.stringify(all.map(([, c]) => c)).toLowerCase()
    const banned: [RegExp, string][] = [
      [/безопасн|безпечн|\bsafe\b|\bsecure\b|seguro|آمن/, 'safety'],
      [/гарантированно|guaranteed|garantizado|مضمون/, 'a guarantee that is not given'],
      [/без списани|без падени|sin caída|sin caida|no drop|без зникан/, 'no drops'],
      [/cheapest|самый дешев|найдешевш|más barato|الأرخص|أرخص/, 'cheapest'],
      [/\bapi\b/, 'an API (there is none for customers)'],
      [/100\s?%/, '100 %'],
      [/живых|живих|органичн|organic growth/, 'live / organic people'],
      [/топ поиска|top of (the )?search|first page|primera página|выведет в топ/, 'a position in a search'],
    ]
    for (const [re, what] of banned) expect(text, what).not.toMatch(re)
  })

  it('what is said about Refill and drip-feed is conditional on the service, and the missing immunity is said out loud, in every language', () => {
    for (const [lang, c] of all) {
      const faq = c.faq[1].a
      expect(faq, lang).toMatch(/algorithm|алгоритм|algoritmo|خوارزميات/i)
      expect(c.facts[2], lang).toMatch(/refill/i)
      expect(c.facts[2], lang).toMatch(/drip-feed/i)
      expect(c.intro, lang).toMatch(/Real|HQ/) // the labels are explained as labels of a service
      expect(c.facts[3], lang).toMatch(/0[.,]10/) // the minimum order of the platform
    }
  })

  it('the topic pages and the landing pages describe TON as the way to pay, and nothing else about payments', () => {
    for (const lang of LANDING_LANGS) {
      for (const landing of allLandings()) expect(pageText(lang, landing).description + pageText(lang, landing).h1, `${lang} ${landingSlug(landing)}`).toContain('TON')
    }
  })

  it('a landing that is a Landing type of "home" has no body copy of its own (it is the app)', () => {
    const home: Landing = { type: 'home' }
    expect(pageText('ru', home).title).toBe(HOME_META.ru.title)
    expect(TOPICS).toHaveLength(2)
  })
})
