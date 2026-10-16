// Public, indexable pages of the site (the legal documents) and what search engines need to find them: robots.txt, sitemap.xml
// with language alternates, and absolute URLs in the pages themselves. The committed pages carry placeholders; postbuild fills them
// with the real origin and bot link (the same way it publishes the TON Connect manifest), so nothing tracked is modified.

export const SITE_PLACEHOLDER = '__SITE_URL__'
export const BOT_URL_PLACEHOLDER = '__BOT_URL__'
export const BOT_NAME_PLACEHOLDER = '__BOT_NAME__'

export type DocLang = 'en' | 'ru' | 'uk'
export const DOC_LANGS: readonly DocLang[] = ['en', 'ru', 'uk']
export const DOCS = ['terms', 'privacy'] as const
export type Doc = (typeof DOCS)[number]

/** Where a document lives: English at the root (it is also x-default), the others under /<lang>/. */
export const docPath = (doc: Doc, lang: DocLang): string => (lang === 'en' ? `/${doc}` : `/${lang}/${doc}`)
/** The file in public/ (and dist/) behind docPath (Vercel cleanUrls serves /terms from terms.html). */
export const docFile = (doc: Doc, lang: DocLang): string => `${docPath(doc, lang).slice(1)}.html`

/** The bot's public link from VITE_TWA_RETURN_URL (https://t.me/<bot>[/<app>]): https://t.me/<bot> and "@<bot>", or null. */
export function botLink(twaReturnUrl: string | undefined): { url: string; name: string } | null {
  const m = /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})(?:\/[A-Za-z0-9_]+)?\/?$/.exec(twaReturnUrl?.trim() ?? '')
  return m ? { url: `https://t.me/${m[1]}`, name: `@${m[1]}` } : null
}

/** Fills the placeholders of a committed page. Without a known bot the link points to Telegram itself. */
export function fillPage(html: string, site: string, bot: { url: string; name: string } | null): string {
  return html
    .replaceAll(SITE_PLACEHOLDER, site.replace(/\/+$/, ''))
    .replaceAll(BOT_URL_PLACEHOLDER, bot?.url ?? 'https://telegram.org')
    .replaceAll(BOT_NAME_PLACEHOLDER, bot?.name ?? 'Telegram')
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * sitemap.xml: every document in every language, each listing all its language versions plus x-default (Google's hreflang rules:
 * the set is complete and reciprocal on every URL). The app itself (/) is a Telegram Mini App and is left out.
 */
export function buildSitemap(site: string, lastmod: string): string {
  const origin = site.replace(/\/+$/, '')
  const urls = DOCS.flatMap((doc) => DOC_LANGS.map((lang) => {
    const alternates = [
      ...DOC_LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${xml(origin + docPath(doc, l))}"/>`),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(origin + docPath(doc, 'en'))}"/>`,
    ]
    return [
      '  <url>',
      `    <loc>${xml(origin + docPath(doc, lang))}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      ...alternates,
      '  </url>',
    ].join('\n')
  }))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

/** robots.txt: everything may be crawled (CSS and scripts too, Google renders pages with them); the sitemap is announced. */
export function buildRobots(site: string | undefined): string {
  return ['User-agent: *', 'Allow: /', ...(site ? ['', `Sitemap: ${site.replace(/\/+$/, '')}/sitemap.xml`] : []), ''].join('\n')
}
