// What the site can be found by: the public landing pages (programmatic SEO), their addresses and the languages they exist in.
// PURE and free of the app's `@/` alias, because three programs read it: the app (src/main.tsx), the Vercel Edge middleware (middleware.ts, for bots)
// and the build script (scripts/generate-sitemap.ts, under Node). It never asks the database: the pages are written from this table and from
// copy.ts, so a crawler or a customer who lands here costs Supabase nothing.
//
// ADDRESSES (like the legal pages, see scripts/lib/seo.ts, but with the language always in front, English included):
//   /<lang>/                          the app's home page in that language
//   /<lang>/buy-<platform>-<kind>     e.g. /es/buy-instagram-followers
//   /<lang>/buy-<platform>-<flavor>-<kind>   a flavour of it the catalogue really has: /ru/buy-telegram-premium-followers
//   /<lang>/<topic>                   a page that is not about one platform: /en/crypto-smm-panel

import { LANGUAGES, type LangCode } from '../i18n/languages.ts'

/** Every language of the app: the home page of each is a public page with its own title and description (copy.ts, HOME_META). */
export const SEO_LANGS: readonly LangCode[] = LANGUAGES.map((l) => l.code)
export const DEFAULT_SEO_LANG: LangCode = 'en'

/**
 * The languages the landing pages are WRITTEN in (copy.ts has a complete text for each: tests/seo-copy.test.ts checks it). A page in a language without a
 * text of its own is not published: the same English text under 14 addresses is duplicate content and a search engine punishes it. To add a language,
 * write its entry in copy.ts and put its code here: the sitemap, the hreflang tags and the middleware follow.
 */
export const LANDING_LANGS: readonly LangCode[] = ['en', 'ru', 'uk', 'es', 'ar']

export type ServiceKind = 'followers' | 'views' | 'likes' | 'comments' | 'reactions' | 'plays'
export const SERVICE_KINDS: readonly ServiceKind[] = ['followers', 'views', 'likes', 'comments', 'reactions', 'plays']

/** A variety of a service that the catalogue has as a labelled line (Premium cards, drip-feed auto views, cards named Real). */
export type Flavor = 'premium' | 'slow-auto' | 'real'

export interface SeoPlatform {
  slug: string
  name: string
  /** What is sold for this platform (a page exists only for these: nothing is advertised that the catalogue does not hold). */
  kinds: readonly ServiceKind[]
}

/** The platforms people search for by name. The slugs are those of the catalogue (src/constants/platforms.ts). */
export const SEO_PLATFORMS: readonly SeoPlatform[] = [
  { slug: 'telegram', name: 'Telegram', kinds: ['followers', 'views', 'reactions'] },
  { slug: 'instagram', name: 'Instagram', kinds: ['followers', 'likes', 'views', 'comments'] },
  { slug: 'tiktok', name: 'TikTok', kinds: ['followers', 'likes', 'views', 'comments'] },
  { slug: 'youtube', name: 'YouTube', kinds: ['followers', 'views', 'likes', 'comments'] },
  { slug: 'twitter', name: 'X (Twitter)', kinds: ['followers', 'likes', 'views'] },
  { slug: 'facebook', name: 'Facebook', kinds: ['followers', 'likes', 'views'] },
  { slug: 'spotify', name: 'Spotify', kinds: ['plays', 'followers'] },
  { slug: 'twitch', name: 'Twitch', kinds: ['followers', 'views'] },
  { slug: 'vk', name: 'VK', kinds: ['followers', 'likes', 'views'] },
]

/** The flavours there are a page for: only these (platform, kind) pairs, each with its own wording in copy.ts. */
export const FLAVORED: readonly { platform: string; flavor: Flavor; kind: ServiceKind }[] = [
  { platform: 'telegram', flavor: 'premium', kind: 'followers' },
  { platform: 'telegram', flavor: 'slow-auto', kind: 'views' },
  { platform: 'instagram', flavor: 'real', kind: 'followers' },
]

/** Pages that are not about one platform. */
export const TOPICS = ['crypto-smm-panel', 'smm-panel-for-agencies'] as const
export type Topic = (typeof TOPICS)[number]

/** What a page is about. */
export type Landing =
  | { type: 'home' }
  | { type: 'service'; platform: SeoPlatform; kind: ServiceKind; flavor: Flavor | null }
  | { type: 'topic'; topic: Topic }

export interface SeoRoute { lang: LangCode; landing: Landing }

const platformOf = (slug: string): SeoPlatform | undefined => SEO_PLATFORMS.find((p) => p.slug === slug)
export const isSeoLang = (v: string): v is LangCode => SEO_LANGS.includes(v as LangCode)

/** The slug of a page in its address: "buy-telegram-followers", "buy-telegram-slow-auto-views", "crypto-smm-panel"; "" for the home page. */
export function landingSlug(landing: Landing): string {
  if (landing.type === 'home') return ''
  if (landing.type === 'topic') return landing.topic
  return `buy-${landing.platform.slug}-${landing.flavor ? `${landing.flavor}-` : ''}${landing.kind}`
}

/**
 * The path of a page: "/es/buy-instagram-followers". The English home page is "/" (it is x-default and the address the app has always had), the home
 * pages of the other languages are "/<lang>/": "/en/" is not a second English home, its canonical is "/".
 */
export const landingPath = (lang: LangCode, landing: Landing): string =>
  landing.type === 'home' && lang === DEFAULT_SEO_LANG ? '/' : `/${lang}/${landingSlug(landing)}`

/** The page behind a slug, or null: a slug that is not in the table is not a page (so a made-up address is never served as one). */
export function parseLandingSlug(slug: string): Landing | null {
  if (slug === '') return { type: 'home' }
  const topic = TOPICS.find((t) => t === slug)
  if (topic) return { type: 'topic', topic }
  const m = /^buy-([a-z0-9]+)-(?:(premium|slow-auto|real)-)?(followers|views|likes|comments|reactions|plays)$/.exec(slug)
  if (!m) return null
  const platform = platformOf(m[1]!)
  const kind = m[3] as ServiceKind
  const flavor = (m[2] as Flavor | undefined) ?? null
  if (!platform || !platform.kinds.includes(kind)) return null
  if (flavor && !FLAVORED.some((f) => f.platform === platform.slug && f.flavor === flavor && f.kind === kind)) return null
  return { type: 'service', platform, kind, flavor }
}

/**
 * "/ru/buy-telegram-premium-followers" -> the language and the page; null when the path is not one of ours. A trailing slash is allowed.
 * The home page exists in every language; any other page only in the languages it is written in (LANDING_LANGS).
 */
export function parseSeoPath(pathname: string): SeoRoute | null {
  const m = /^\/([a-z]{2})(?:\/([a-z0-9-]*))?\/?$/.exec(pathname)
  if (!m || !isSeoLang(m[1]!)) return null
  const landing = parseLandingSlug(m[2] ?? '')
  if (!landing || (landing.type !== 'home' && !LANDING_LANGS.includes(m[1] as LangCode))) return null
  return { lang: m[1] as LangCode, landing }
}

/** Every page except the home page, before the languages: what the sitemap multiplies by LANDING_LANGS. */
export function allLandings(): Landing[] {
  const service = SEO_PLATFORMS.flatMap((platform) => [
    ...platform.kinds.map((kind): Landing => ({ type: 'service', platform, kind, flavor: null })),
    ...FLAVORED.filter((f) => f.platform === platform.slug).map((f): Landing => ({ type: 'service', platform, kind: f.kind, flavor: f.flavor })),
  ])
  return [...service, ...TOPICS.map((topic): Landing => ({ type: 'topic', topic }))]
}
