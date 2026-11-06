// The finished HTML of a public page for a crawler: the app's own index.html with the right <title>, description, canonical, Open Graph, hreflang for every
// language the page exists in, JSON-LD, and the text of the page inside #root (so a crawler that does not run JavaScript, like most AI crawlers, still reads
// it). PURE: given the template text it returns text. The Edge middleware (middleware.ts) calls it for bots; the app's own landing component shows the same
// words to people.

import { languageOf, type LangCode } from '../i18n/languages.ts'
import { copyFor, pageText } from './copy.ts'
import { allLandings, DEFAULT_SEO_LANG, LANDING_LANGS, SEO_LANGS, landingPath, type Landing, type SeoRoute } from './pages.ts'
import { ldScript, pageJsonLd } from './schema.ts'

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const OG_LOCALE: Partial<Record<LangCode, string>> = { en: 'en_US', ru: 'ru_RU', uk: 'uk_UA', es: 'es_ES', ar: 'ar_AR' }

/** The languages a page exists in: the home page in all of them, any other page in the languages it is written in. */
export const languagesOf = (landing: Landing): readonly LangCode[] => (landing.type === 'home' ? SEO_LANGS : LANDING_LANGS)

/** `<link rel="alternate" hreflang>` for every language of the page, reciprocal on every URL, plus x-default (English). */
export function hreflangLinks(site: string, landing: Landing): string[] {
  const origin = site.replace(/\/+$/, '')
  return [
    ...languagesOf(landing).map((l) => `<link rel="alternate" hreflang="${l}" href="${escapeHtml(origin + landingPath(l, landing))}" />`),
    `<link rel="alternate" hreflang="x-default" href="${escapeHtml(origin + landingPath(DEFAULT_SEO_LANG, landing))}" />`,
  ]
}

/** The head of a page: everything a search engine, a link preview and an AI crawler read before the body. */
export function headTags(site: string, route: SeoRoute, opts: { botUrl?: string | null; priceFromUsd?: number } = {}): string[] {
  const origin = site.replace(/\/+$/, '')
  const text = pageText(route.lang, route.landing)
  const url = origin + landingPath(route.lang, route.landing)
  return [
    `<title>${escapeHtml(text.title)}</title>`,
    `<meta name="description" content="${escapeHtml(text.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    ...hreflangLinks(origin, route.landing),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="GRAM Hub" />`,
    `<meta property="og:title" content="${escapeHtml(text.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(text.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(origin)}/tonconnect-icon.png" />`,
    `<meta property="og:locale" content="${OG_LOCALE[route.lang] ?? route.lang}" />`,
    ...languagesOf(route.landing).filter((l) => l !== route.lang).map((l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l] ?? l}" />`),
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(text.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(text.description)}" />`,
    ...pageJsonLd(origin, route.lang, route.landing, opts).map((d) => `<script type="application/ld+json">${ldScript(d)}</script>`),
  ]
}

/** The text of the page, as plain semantic HTML: heading, introduction, the four facts, the questions, the ways in, and links to the sibling pages. */
export function bodyHtml(site: string, route: SeoRoute, botUrl?: string | null): string {
  const origin = site.replace(/\/+$/, '')
  const { lang, landing } = route
  const copy = copyFor(lang)
  const text = pageText(lang, landing)
  const links = LANDING_LANGS.includes(lang)
    ? allLandings()
      .filter((l) => JSON.stringify(l) !== JSON.stringify(landing))
      .map((l) => `<li><a href="${escapeHtml(landingPath(lang, l))}">${escapeHtml(pageText(lang, l).h1)}</a></li>`)
    : []
  return [
    '<main>',
    `<h1>${escapeHtml(text.h1)}</h1>`,
    `<p>${escapeHtml(text.intro)}</p>`,
    ...(landing.type === 'home' ? [] : [
      `<h2>${escapeHtml(copy.factsHeading)}</h2>`,
      `<ul>${copy.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`,
      `<h2>${escapeHtml(copy.faqHeading)}</h2>`,
      `<dl>${copy.faq.map((f) => `<dt>${escapeHtml(f.q)}</dt><dd>${escapeHtml(f.a)}</dd>`).join('')}</dl>`,
    ]),
    `<p>${botUrl ? `<a href="${escapeHtml(botUrl)}">${escapeHtml(copy.ctaTelegram)}</a> · ` : ''}<a href="${escapeHtml(origin)}/">${escapeHtml(copy.ctaWeb)}</a></p>`,
    ...(links.length > 0 ? [`<nav><ul>${links.join('')}</ul></nav>`] : []),
    '</main>',
  ].join('')
}

/**
 * Turns the app's index.html into the page for this route. Removes what the template says about the page itself (title, description, canonical, hreflang,
 * Open Graph, Twitter) and writes the right set before </head>; sets <html lang dir>; puts the page's text inside #root (the app replaces it when it starts).
 * The template's other head content (the Telegram script, the bundles, the icons) is kept as it is.
 */
export function renderSeoHtml(template: string, site: string, route: SeoRoute, opts: { botUrl?: string | null; priceFromUsd?: number } = {}): string {
  const language = languageOf(route.lang)
  const head = headTags(site, route, opts).join('\n    ')
  // replacer FUNCTIONS, never replacement strings: the texts contain "$" ($0.10), which a replacement string would read as a pattern
  const htmlTag = `<html lang="${language.code}" dir="${language.dir}">`
  const root = `<div id="root">${bodyHtml(site, route, opts.botUrl)}</div>`
  return template
    .replace(/<html\b[^>]*>/i, () => htmlTag)
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="alternate"\s+hreflang="[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<\/head>/i, () => `    ${head}\n  </head>`)
    .replace(/<div id="root">\s*<\/div>/i, () => root)
}
