// Putting a provider's catalogue on the storefront: which platform a panel category belongs to, which services may be sold as they
// are, and the rows the database function publish_provider_services() takes. Pure: the sync (catalog-sync-run.ts) calls it with
// what it already has, and the database does the writing in one set-based statement per chunk.

import { stripDecor, translateCategory, translateService, type ServiceAttributes } from './service-text.ts'

/** What publishing needs to know about one provider service (a row of provider_services plus its type). */
export interface PublishCandidate {
  id: string
  name: string
  categoryRaw: string
  serviceType: string | null
  rate: number
  min: number
  max: number
  /** The panel's own text about the service, if it sent one. */
  description?: string | null
}

export interface PublishRow {
  /** provider_services.id */
  ps: string
  platform: string
  cat_key: string
  cat_name: string
  cat_name_ru: string
  cat_sort: number
  /** An existing storefront category to put the service in (canonical mapping); cat_key / cat_name are then not used. */
  cat_id?: string
  name: string
  name_ru: string
  attributes: ServiceAttributes
  /** The panel's text, shown on the service as it is. */
  description: string | null
}

interface PlatformRule {
  slug: string
  /** Matches the panel's category text. */
  test: RegExp
  /** How the platform is written inside names (moved to the front of the English title). */
  brands: readonly string[]
}

const rule = (slug: string, test: RegExp, brands: readonly string[] = []): PlatformRule => ({ slug, test, brands })

/**
 * First match wins, so the multi-platform and special categories come before the single brands. The panel names its categories
 * after the platform ("Просмотры постов Telegram [один пост]", "Twitter (X) Лайки", "SoundCloud"); a category that names two or more
 * of the big platforms is a multi-platform one.
 */
export const PLATFORM_RULES: readonly PlatformRule[] = [
  rule('multiplatform', /топ-услуги|для всех платформ|все платформы/i),
  rule('smm-tools', /smm.?инструмент|инструменты smm/i),
  rule('app-installs', /установки мобильных|установки приложен/i),
  rule('backlinks', /обратные ссылки|seo сайта/i),
  rule('website', /трафик на сайт/i),
  rule('google-maps', /услуги google|google maps|google карты/i),
  rule('crypto-nft', /крипто|opensea|dexscreener|nft/i),
  rule('trustpilot', /отзывы|trustpilot|yelp|tripadvisor/i),
  rule('twitter', /twitter|\bx\b твит|\(x\)/i, ['Twitter (X)', 'Twitter']),
  rule('telegram', /telegram|телеграм/i, ['Telegram']),
  rule('instagram', /instagram|инстаграм/i, ['Instagram']),
  rule('tiktok', /tiktok|тикток/i, ['TikTok']),
  rule('youtube', /youtube|ютуб/i, ['YouTube']),
  rule('facebook', /facebook|фейсбук/i, ['Facebook']),
  rule('spotify', /spotify/i, ['Spotify']),
  rule('kick', /\bkick\b/i, ['Kick']),
  rule('snapchat', /snapchat/i, ['Snapchat']),
  rule('twitch', /twitch/i, ['Twitch']),
  rule('soundcloud', /soundcloud/i, ['SoundCloud']),
  rule('discord', /discord/i, ['Discord']),
  rule('linkedin', /linkedin/i, ['LinkedIn']),
  rule('pinterest', /pinterest/i, ['Pinterest']),
  rule('reddit', /reddit/i, ['Reddit']),
  rule('likee', /likee/i, ['Likee']),
  rule('soop', /afreeca|soop/i, ['AfreecaTV']),
  rule('apple-music', /apple music/i, ['Apple Music']),
  rule('apple-podcasts', /apple podcast/i, ['Apple Podcast']),
  rule('audiomack', /audiomack/i, ['Audiomack']),
  rule('behance', /behance/i, ['Behance']),
  rule('binance-square', /binance/i, ['Binance Square']),
  rule('bluesky', /bluesky/i, ['Bluesky']),
  rule('boomplay', /boomplay/i, ['Boomplay']),
  rule('naver', /naver|chzzk/i, ['Naver']),
  rule('clubhouse', /clubhouse/i, ['Clubhouse']),
  rule('coinmarketcap', /coinmarketcap/i, ['CoinMarketCap']),
  rule('coub', /\bcoub\b/i, ['Coub']),
  rule('deezer', /deezer/i, ['Deezer']),
  rule('dribbble', /dribbble/i, ['Dribbble']),
  rule('github', /github/i, ['GitHub']),
  rule('jaco', /\bjaco\b/i, ['Jaco']),
  rule('kwai', /\bkwai\b/i, ['Kwai']),
  rule('line', /^line$/i, ['Line']),
  rule('medium', /^medium$/i, ['Medium']),
  rule('mentimeter', /mentimeter/i, ['Mentimeter']),
  rule('mixcloud', /mixcloud/i, ['MixCloud']),
  rule('odnoklassniki', /ok\.ru|одноклассники/i, ['Ok.ru']),
  rule('onlyfans', /onlyfans/i, ['OnlyFans']),
  rule('potato', /potato/i, ['Potato Chat', 'Potato']),
  rule('quora', /quora/i, ['Quora']),
  rule('reverbnation', /reverbnation/i, ['ReverbNation']),
  rule('rumble', /rumble/i, ['Rumble']),
  rule('rutube', /rutube/i, ['RuTube']),
  rule('shazam', /shazam/i, ['Shazam']),
  rule('shopee', /shopee/i, ['Shopee']),
  rule('snackvideo', /snackvideo/i, ['SnackVideo']),
  rule('spinnin-records', /spinnin/i, ['Spinnin Records']),
  rule('threads', /threads/i, ['Threads']),
  rule('tidal', /tidal/i, ['Tidal']),
  rule('trovo', /trovo/i, ['Trovo']),
  rule('truth-social', /truth social/i, ['Truth Social']),
  rule('tumblr', /tumblr/i, ['Tumblr']),
  rule('vimeo', /vimeo/i, ['Vimeo']),
  rule('vk', /vk\.com|вконтакте|\bvk\b/i, ['VK.com', 'VK']),
  rule('whatsapp', /whatsapp/i, ['WhatsApp']),
  rule('xiaohongshu', /xiaohongshu|rednote/i, ['Xiaohongshu (RedNote)', 'Xiaohongshu']),
  rule('yandex-zen', /zen|дзен/i, ['Yandex Zen (dzen.ru)', 'Yandex Zen']),
  rule('yandex-maps', /^yandex$|яндекс/i, ['Yandex']),
]

export const OTHER_PLATFORM = 'other'

export interface PlatformChoice {
  slug: string
  brands: readonly string[]
}

/** The platform of a panel category; unknown slugs (not in the registry) fall back to "other". */
export function detectPlatform(categoryRaw: string, knownSlugs: ReadonlySet<string>): PlatformChoice {
  const text = stripDecor(categoryRaw)
  for (const r of PLATFORM_RULES) {
    if (r.test.test(text)) return knownSlugs.has(r.slug) ? { slug: r.slug, brands: r.brands } : { slug: OTHER_PLATFORM, brands: r.brands }
  }
  return { slug: OTHER_PLATFORM, brands: [] }
}

/** A stable key for a panel category: lower case, decoration removed. The database derives the category slug from it. */
export const categoryKey = (categoryRaw: string): string => stripDecor(categoryRaw).toLowerCase()

/**
 * Can a customer order this as it is? The order form collects a link and a quantity, so only the panel's plain "Default" services
 * qualify (custom comments, subscriptions, packages and polls need other fields). Separators ("______", rate 0) and impossible
 * limits are out.
 */
export function isPublishable(c: PublishCandidate): boolean {
  return (
    (c.serviceType ?? 'Default').trim().toLowerCase() === 'default' &&
    c.rate > 0 &&
    Number.isInteger(c.min) && c.min > 0 &&
    Number.isInteger(c.max) && c.max >= c.min &&
    stripDecor(c.name).replace(/[^\p{L}]/gu, '').length >= 3
  )
}

export interface BuildResult {
  rows: PublishRow[]
  /** Services and categories whose English text could not be produced (kept in the original language). */
  untranslatedServices: number
  untranslatedCategories: number
  skipped: number
}

export function buildPublishRows(candidates: readonly PublishCandidate[], knownSlugs: ReadonlySet<string>): BuildResult {
  const categoryOrder = new Map<string, number>()
  const categoryCache = new Map<string, { platform: PlatformChoice; name: string; nameRu: string; translated: boolean }>()
  const result: BuildResult = { rows: [], untranslatedServices: 0, untranslatedCategories: 0, skipped: 0 }

  for (const c of candidates) {
    if (!isPublishable(c)) {
      result.skipped++
      continue
    }
    const key = categoryKey(c.categoryRaw)
    let cat = categoryCache.get(key)
    if (!cat) {
      const platform = detectPlatform(c.categoryRaw, knownSlugs)
      const t = translateCategory(c.categoryRaw, { brands: platform.brands, platformSlug: platform.slug })
      cat = { platform, name: t.name, nameRu: t.nameRu, translated: t.translated }
      categoryCache.set(key, cat)
      categoryOrder.set(key, categoryOrder.size)
      if (!t.translated) result.untranslatedCategories++
    }
    const t = translateService(c.name, { platformSlug: cat.platform.slug, brands: cat.platform.brands })
    if (!t.translated) result.untranslatedServices++
    result.rows.push({
      ps: c.id,
      platform: cat.platform.slug,
      cat_key: key,
      cat_name: cat.name,
      cat_name_ru: cat.nameRu,
      cat_sort: categoryOrder.get(key)!,
      name: t.name,
      name_ru: t.nameRu,
      attributes: t.attributes,
      description: c.description?.trim() || null,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Canonical categories (providers.publish_mapping = 'canonical')
// ---------------------------------------------------------------------------
// A donor panel names its categories in English and very finely ("Spotify Plays - Discover Weekly", "YouTube RAV-GS Video/Shorts Views -
// GEO Targeted": SMMFollows alone has 631). Published as they are, the storefront would fill up with near-duplicate categories. Here a
// service goes to the storefront category of its PLATFORM and ACTION (followers, likes, views...): an existing one when the storefront
// already has exactly that ("Instagram Likes", "Twitter (X) Followers"), otherwise one new category per platform and action, named in
// both languages. The service's own name keeps every detail (country, quality, guarantee).

export interface ExistingCategory {
  id: string
  /** platforms.slug */
  platform: string
  name: string
}

export interface Action {
  key: string
  test: RegExp
  en: string
  ru: string
  /** Storefront category names (brand removed, lower case) that mean exactly this action. */
  same: readonly string[]
}

/** First match wins: the specific actions come before the words they contain ("story views" before "views"). */
export const ACTIONS: readonly Action[] = [
  { key: 'live', test: /\blive\b|livestream|stream viewers|concurrent/i, en: 'Live Stream', ru: 'Прямой эфир', same: ['live stream', 'live stream viewers'] },
  { key: 'story', test: /\bstor(y|ies)\b/i, en: 'Story Views', ru: 'Просмотры историй', same: ['story views', 'stories'] },
  { key: 'comment-likes', test: /comments? (likes?|upvotes?)/i, en: 'Comment Likes', ru: 'Лайки на комментарии', same: ['comment likes'] },
  { key: 'comments', test: /comment|replies|mentions/i, en: 'Comments', ru: 'Комментарии', same: ['comments'] },
  { key: 'reactions', test: /reaction|emoji/i, en: 'Reactions', ru: 'Реакции', same: ['reactions'] },
  { key: 'members', test: /\bmembers?\b|\bjoins?\b/i, en: 'Members', ru: 'Участники', same: ['members', 'channel members', 'group members'] },
  { key: 'subscribers', test: /subscriber/i, en: 'Subscribers', ru: 'Подписчики', same: ['subscribers'] },
  { key: 'followers', test: /follower|\bfollow\b/i, en: 'Followers', ru: 'Подписчики', same: ['followers'] },
  { key: 'likes', test: /\blikes?\b|\bhearts?\b|favou?rites?|upvotes?/i, en: 'Likes', ru: 'Лайки', same: ['likes'] },
  { key: 'plays', test: /\bplays?\b|\bstreams?\b|listeners/i, en: 'Plays', ru: 'Прослушивания', same: ['plays', 'streams'] },
  { key: 'shares', test: /share|repost|retweet|forward|\bsaves?\b|bookmark/i, en: 'Shares and Saves', ru: 'Репосты и сохранения', same: ['shares', 'reposts', 'reposts and saves', 'social shares', 'shares and saves'] },
  { key: 'impressions', test: /impression|\breach\b|\bclicks?\b|profile visits/i, en: 'Impressions and Reach', ru: 'Показы и охват', same: ['impressions', 'impressions and reach', 'impressions and clicks'] },
  { key: 'views', test: /\bviews?\b|watch ?time|\bwatch\b/i, en: 'Views', ru: 'Просмотры', same: ['views', 'video views'] },
  { key: 'votes', test: /\bvotes?\b|\bpolls?\b/i, en: 'Votes', ru: 'Голоса', same: ['votes', 'polls'] },
  { key: 'traffic', test: /traffic|visitors|\bvisits?\b/i, en: 'Traffic', ru: 'Трафик', same: ['traffic', 'website traffic'] },
  { key: 'reviews', test: /review|rating/i, en: 'Reviews', ru: 'Отзывы', same: ['reviews'] },
]
export const OTHER_ACTION: Action = { key: 'other', test: /(?!)/, en: 'Other Services', ru: 'Другие услуги', same: ['other services'] }

/** How a platform without a brand in PLATFORM_RULES is named in a canonical category. */
const PLATFORM_LABEL: Readonly<Record<string, { en: string; ru: string }>> = {
  'crypto-nft': { en: 'Crypto', ru: 'Крипто' },
  'google-maps': { en: 'Google Maps', ru: 'Google Maps' },
  trustpilot: { en: 'Review sites', ru: 'Сайты отзывов' },
  website: { en: 'Website', ru: 'Сайт' },
  backlinks: { en: 'SEO', ru: 'SEO' },
  'app-installs': { en: 'App', ru: 'Приложения' },
  'smm-tools': { en: 'SMM tools', ru: 'SMM-инструменты' },
  multiplatform: { en: 'All platforms', ru: 'Все платформы' },
  [OTHER_PLATFORM]: { en: 'Other platforms', ru: 'Другие площадки' },
}

/** English words for platforms whose shared rules only know the Russian category names. */
const DONOR_PLATFORM_RULES: readonly PlatformRule[] = [
  rule('website', /website|web traffic|\bseo\b/i, ['Website']),
  rule('app-installs', /app install|play store|app store/i, ['App']),
  rule('google-maps', /google maps|google business|google reviews/i, ['Google']),
  rule('trustpilot', /trustpilot|tripadvisor|\byelp\b/i, ['Trustpilot']),
]

/** The action a donor service sells: from its category first, then from its name. */
export function detectAction(...texts: string[]): Action {
  for (const text of texts) {
    const t = stripDecor(text)
    for (const a of ACTIONS) if (a.test.test(t)) return a
  }
  return OTHER_ACTION
}

/** A storefront category name without the platform's brand: "Twitter (X) Followers" -> "followers". Null for a specific one ("[...]"). */
export function genericLabel(name: string, brands: readonly string[]): string | null {
  if (/[[\]]/.test(name) || /[а-яё]/i.test(name)) return null
  let n = ` ${name.toLowerCase().replace(/\(x\)/g, ' ')} `
  for (const b of [...brands].sort((x, y) => y.length - x.length)) n = n.split(` ${b.toLowerCase()} `).join(' ')
  n = n.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  return n === '' ? null : n
}

export function buildCanonicalPublishRows(
  candidates: readonly PublishCandidate[],
  knownSlugs: ReadonlySet<string>,
  existing: readonly ExistingCategory[],
): BuildResult {
  const result: BuildResult = { rows: [], untranslatedServices: 0, untranslatedCategories: 0, skipped: 0 }
  const order = new Map<string, number>()
  for (const c of candidates) {
    if (!isPublishable(c)) {
      result.skipped++
      continue
    }
    const text = `${c.categoryRaw} ${c.name}`
    let platform = detectPlatform(text, knownSlugs)
    if (platform.slug === OTHER_PLATFORM && platform.brands.length === 0) {
      const extra = DONOR_PLATFORM_RULES.find((r) => r.test.test(stripDecor(text)))
      if (extra && knownSlugs.has(extra.slug)) platform = { slug: extra.slug, brands: extra.brands }
    }
    const action = detectAction(c.categoryRaw, c.name)
    const brand = platform.brands[0]
    const label = brand ? null : (PLATFORM_LABEL[platform.slug] ?? PLATFORM_LABEL[OTHER_PLATFORM])
    const match = existing.find((e) => e.platform === platform.slug && action.same.includes(genericLabel(e.name, platform.brands) ?? ''))
    const key = `canonical:${platform.slug}:${action.key}`
    if (!order.has(key)) order.set(key, 1000 + order.size)
    const t = translateService(c.name, { platformSlug: platform.slug, brands: platform.brands })
    if (!t.translated) result.untranslatedServices++
    result.rows.push({
      ps: c.id,
      platform: platform.slug,
      cat_key: key,
      cat_name: label ? `${action.en} (${label.en})` : `${brand} ${action.en}`,
      cat_name_ru: label ? `${action.ru} (${label.ru})` : `${action.ru} ${brand}`,
      cat_sort: order.get(key)!,
      ...(match ? { cat_id: match.id } : {}),
      name: t.name,
      name_ru: t.nameRu,
      attributes: t.attributes,
      description: c.description?.trim() || null,
    })
  }
  return result
}
