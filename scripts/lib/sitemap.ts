// sitemap.xml of the whole site (npm run generate-sitemap, and the postbuild hook of every build): the home page in every language, every landing page in
// every language it is written in, and the legal documents. Every URL lists all its language versions plus x-default (Google's hreflang rules: the set is
// complete and reciprocal on every URL). Pure, so it is tested without a build. Keep to erasable syntax: it runs under Node without a build step.

import { DEFAULT_SEO_LANG, LANDING_LANGS, SEO_LANGS, allLandings, landingPath, type Landing } from '../../src/seo/pages.ts'
import { languagesOf } from '../../src/seo/render.ts'
import { DOCS, DOC_LANGS, docPath } from './seo.ts'

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** The sitemap protocol allows 50,000 URLs in one file; past that the file must become an index (the script refuses rather than write an invalid one). */
export const MAX_SITEMAP_URLS = 50_000

interface Entry { loc: string; alternates: { hreflang: string; href: string }[] }

/** Every URL of the site with its alternates. */
export function sitemapEntries(site: string): Entry[] {
  const origin = site.replace(/\/+$/, '')
  const entries: Entry[] = []
  const pushLanding = (landing: Landing) => {
    const langs = languagesOf(landing)
    const alternates = [
      ...langs.map((l) => ({ hreflang: l, href: origin + landingPath(l, landing) })),
      { hreflang: 'x-default', href: origin + landingPath(DEFAULT_SEO_LANG, landing) },
    ]
    for (const lang of langs) entries.push({ loc: origin + landingPath(lang, landing), alternates })
  }
  pushLanding({ type: 'home' })
  for (const landing of allLandings()) pushLanding(landing)
  for (const doc of DOCS) {
    const alternates = [
      ...DOC_LANGS.map((l) => ({ hreflang: l, href: origin + docPath(doc, l) })),
      { hreflang: 'x-default', href: origin + docPath(doc, 'en') },
    ]
    for (const lang of DOC_LANGS) entries.push({ loc: origin + docPath(doc, lang), alternates })
  }
  return entries
}

export function buildFullSitemap(site: string, lastmod: string): string {
  const entries = sitemapEntries(site)
  if (entries.length > MAX_SITEMAP_URLS) throw new Error(`sitemap has ${entries.length} URLs, the limit of one file is ${MAX_SITEMAP_URLS}: split it into an index`)
  const urls = entries.map((e) => [
    '  <url>',
    `    <loc>${xml(e.loc)}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    ...e.alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${xml(a.href)}"/>`),
    '  </url>',
  ].join('\n'))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

/** What the sitemap is made of, for the build log: pages x languages. */
export function sitemapSummary(site: string): string {
  const n = sitemapEntries(site).length
  return `${n} URLs: ${SEO_LANGS.length} home pages, ${allLandings().length} landing pages x ${LANDING_LANGS.length} languages, ${DOCS.length * DOC_LANGS.length} legal pages`
}
