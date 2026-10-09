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
}

export interface PublishRow {
  /** provider_services.id */
  ps: string
  platform: string
  cat_key: string
  cat_name: string
  cat_name_ru: string
  cat_sort: number
  name: string
  name_ru: string
  attributes: ServiceAttributes
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
    })
  }
  return result
}
