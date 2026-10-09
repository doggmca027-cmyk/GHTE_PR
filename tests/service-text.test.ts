import { describe, expect, it } from 'vitest'
import {
  OTHER_PLATFORM, PLATFORM_RULES, buildPublishRows, categoryKey, detectPlatform, isPublishable, type PublishCandidate,
} from '../supabase/functions/_shared/catalog-publish'
import { COUNTRIES, PHRASES } from '../supabase/functions/_shared/service-glossary'
import {
  brandFirst, extractAttributes, flagCodes, hasCyrillic, parseServiceName, stripDecor, titleCase, translateCategory, translateService, translateText,
} from '../supabase/functions/_shared/service-text'

const KNOWN = new Set(['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'spotify', 'vk', 'website', 'multiplatform', 'crypto-nft', 'other', 'kick', 'soundcloud', 'trustpilot', 'backlinks', 'app-installs', 'google-maps'])
const TG = { platformSlug: 'telegram', brands: ['Telegram'] }

describe('the glossary', () => {
  it('every pattern is a valid regular expression and every entry has an English text', () => {
    for (const [pattern, english] of PHRASES) {
      expect(() => new RegExp(pattern, 'giu'), pattern).not.toThrow()
      expect(english.length, pattern).toBeGreaterThan(0)
      expect(hasCyrillic(english), `${pattern} -> ${english}`).toBe(false)
    }
  })

  it('country names map to two-letter ISO codes', () => {
    for (const [name, iso] of Object.entries(COUNTRIES)) {
      expect(iso, name).toMatch(/^[A-Z]{2}$/)
      expect(name, name).toBe(name.toLowerCase())
    }
  })
})

describe('text helpers', () => {
  it('stripDecor removes emoji, flags and symbols but keeps letters, digits and punctuation', () => {
    expect(stripDecor('Реакции 🔥 Telegram ❤️ [❌ Без восстановления]')).toBe('Реакции Telegram [ Без восстановления]'.replace('[ ', '['))
    expect(stripDecor('🇺🇸 США')).toBe('США')
    expect(stripDecor('♛ Социальные = репосты')).toBe('Социальные репосты')
  })

  it('flagCodes reads the country out of a flag emoji', () => {
    expect(flagCodes('🇺🇸 США')).toEqual(['US'])
    expect(flagCodes('🇦🇪🇸🇦 Арабские страны')).toEqual(['AE', 'SA'])
    expect(flagCodes('no flags')).toEqual([])
  })

  it('titleCase capitalises words but leaves brands and small words alone', () => {
    expect(titleCase('post views from ads')).toBe('Post Views from Ads')
    expect(titleCase('TikTok likes and shares')).toBe('TikTok Likes and Shares')
  })

  it('brandFirst moves the platform to the front, once', () => {
    expect(brandFirst('post views Telegram', ['Telegram'])).toBe('Telegram post views')
    expect(brandFirst('Telegram post views', ['Telegram'])).toBe('Telegram post views')
    expect(brandFirst('followers Twitter (X)', ['Twitter (X)', 'Twitter'])).toBe('Twitter (X) followers')
    expect(brandFirst('post views', ['Telegram'])).toBe('post views')
  })

  it('parseServiceName splits the title from the [tags], dropping empty tags', () => {
    expect(parseServiceName('Просмотры постов Telegram [❌ Без восстановления] [Сервер 2] [🏻] [ ]')).toEqual({
      titleRu: 'Просмотры постов Telegram', tagsRu: ['❌ Без восстановления', 'Сервер 2'],
    })
  })
})

describe('translation', () => {
  it.each([
    ['Просмотры постов Telegram', 'Telegram Post Views'],
    ['Лайки Instagram', 'Instagram Likes'],
    ['Зрители прямого эфира TikTok', 'TikTok Live Stream Viewers'],
    ['Участники Telegram', 'Telegram Members'],
    ['Прослушивания плейлиста Spotify', 'Spotify Playlist Plays'],
    ['Автореакции Telegram', 'Telegram Auto Reactions'],
    ['Комментарии YouTube', 'YouTube Comments'],
  ])('%s -> %s', (ru, en) => {
    const platform = /Telegram/.test(ru) ? 'telegram' : /Instagram/.test(ru) ? 'instagram' : /TikTok/.test(ru) ? 'tiktok' : /Spotify/.test(ru) ? 'spotify' : 'youtube'
    const brand = ru.match(/Telegram|Instagram|TikTok|Spotify|YouTube/)![0]
    expect(translateService(ru, { platformSlug: platform, brands: [brand] }).name).toBe(en)
  })

  it('followers are subscribers on YouTube and Telegram, followers elsewhere', () => {
    expect(translateService('Подписчики YouTube', { platformSlug: 'youtube', brands: ['YouTube'] }).name).toBe('YouTube Subscribers')
    expect(translateService('Подписчики Instagram', { platformSlug: 'instagram', brands: ['Instagram'] }).name).toBe('Instagram Followers')
  })

  it('tags with numbers keep their numbers; the English reads naturally', () => {
    expect(translateText('Восстановление: 30 дней')).toBe('refill: 30 days')
    expect(translateText('Время старта: 0-1 час')).toBe('start: 0-1 hour')
    expect(translateText('Скорость: до 50 тыс./день')).toBe('speed: up to 50 K/day')
    expect(translateText('Макс.: 100 тыс.')).toBe('max: 100 K')
    expect(translateText('Последние 500 постов')).toBe('last 500 posts')
    expect(translateText('Бонус 5%')).toBe('bonus 5%')
  })

  it('country names become English country names', () => {
    expect(translateText('США')).toBe('United States')
    expect(translateText('Южная Корея')).toBe('South Korea')
    expect(translateText('Трафик из Вьетнама')).toMatch(/traffic from Vietnam/i)
  })

  it('a full real-looking name becomes an English name with the tags kept, and the original is kept as name_ru', () => {
    const r = translateService('Просмотры постов Telegram [❌ Без восстановления] [⏳ Время старта: Мгновенно] [Без списаний] [Рекомендуем]', TG)
    expect(r.name).toBe('Telegram Post Views [no refill] [start: instant] [no drops] [recommended]')
    expect(r.nameRu).toBe('Просмотры постов Telegram [Без восстановления] [Время старта: Мгновенно] [Без списаний] [Рекомендуем]')
    expect(r.translated).toBe(true)
    expect(hasCyrillic(r.name)).toBe(false)
  })

  it('a tag the glossary does not know is dropped from the English name instead of leaving Russian in it', () => {
    const r = translateService('Лайки YouTube [Невероятнейшая штука]', { platformSlug: 'youtube', brands: ['YouTube'] })
    expect(r.name).toBe('YouTube Likes')
    expect(r.translated).toBe(true)
  })

  it('a title the glossary cannot translate keeps the original name and says so', () => {
    const r = translateService('Невероятнейшая штука Telegram [Без восстановления]', TG)
    expect(r.translated).toBe(false)
    expect(r.name).toBe(r.nameRu)
    expect(hasCyrillic(r.name)).toBe(true)
  })

  it('names are cut to a sane length', () => {
    const long = `Просмотры постов Telegram ${'[Без списаний] '.repeat(60)}`
    const r = translateService(long, TG)
    expect(r.name.length).toBeLessThanOrEqual(240)
    expect(r.nameRu.length).toBeLessThanOrEqual(240)
  })

  it('categories are translated the same way, flag tags included', () => {
    expect(translateCategory('Просмотры постов Telegram [один пост]', { brands: ['Telegram'] })).toEqual({ name: 'Telegram Post Views [single post]', nameRu: 'Просмотры постов Telegram [один пост]', translated: true })
    expect(translateCategory('Telegram [🇨🇳 Китай]', { brands: ['Telegram'] }).name).toBe('Telegram [China]')
    expect(translateCategory('Самые дешёвые услуги Telegram 🔥', { brands: ['Telegram'] }).name).toBe('Telegram Cheapest Services')
  })
})

describe('attributes: the facts of a service, from its tags', () => {
  const a = (...tags: string[]) => extractAttributes(tags)

  it('refill', () => {
    expect(a('❌ Без восстановления')).toEqual({ refill: 'none' })
    expect(a('♻️ Восстановление: Пожизненно')).toEqual({ refill: 'lifetime' })
    expect(a('♻️ Восстановление: 30 дней')).toEqual({ refill: 30 })
    expect(a('Восстановление: 7-30 дней')).toEqual({ refill: 30 })
  })

  it('start time, in minutes', () => {
    expect(a('⏳ Время старта: Мгновенно')).toEqual({ startMin: 0, startMax: 0 })
    expect(a('⏳ Время старта: 0-1 час')).toEqual({ startMin: 0, startMax: 60 })
    expect(a('⏳ Время старта: 0-6 часов')).toEqual({ startMin: 0, startMax: 360 })
    expect(a('⏳ Время старта: 15-30 минут')).toEqual({ startMin: 15, startMax: 30 })
    expect(a('Время старта: до 12 часов')).toEqual({ startMin: 0, startMax: 720 })
  })

  it('speed, per day', () => {
    expect(a('⚡ Скорость: 100 тыс./день')).toEqual({ speed: 100_000 })
    expect(a('⚡ Скорость: до 50 тыс./день')).toEqual({ speed: 50_000 })
    expect(a('Скорость: 5000/день')).toEqual({ speed: 5_000 })
    expect(a('Скорость: 1000/час')).toEqual({ speed: 24_000 })
    expect(a('Скорость: 2 млн/день')).toEqual({ speed: 2_000_000 })
  })

  it('drops, real accounts and countries (from the flag or from the name)', () => {
    expect(a('Без списаний')).toEqual({ drop: 'none' })
    expect(a('Низкий риск списаний')).toEqual({ drop: 'low' })
    expect(a('Высокие списания')).toEqual({ drop: 'high' })
    expect(a('💎 Реальные')).toEqual({ real: true })
    expect(a('🇺🇸 США', 'Индия')).toEqual({ geo: ['IN', 'US'] })
  })

  it('says nothing about what it cannot read', () => {
    expect(a('Дёшево', 'Сервер 2')).toEqual({})
  })
})

describe('which platform a category belongs to', () => {
  it.each([
    ['Просмотры постов Telegram [один пост]', 'telegram'],
    ['Twitter (X) Подписчики 🔥', 'twitter'],
    ['Лайки Instagram [с таргетингом]', 'instagram'],
    ['Подписчики TikTok', 'tiktok'],
    ['VK.com', 'vk'],
    ['Трафик на сайт [🇰🇷 Южная Корея]', 'website'],
    ['SEO сайта и обратные ссылки', 'backlinks'],
    ['Установки мобильных приложений', 'app-installs'],
    ['Отзывы [Trustpilot / Yelp / BBB / Tripadvisor]', 'trustpilot'],
    ['Услуги Google [Карты / Бизнес / посетители]', 'google-maps'],
    ['Криптоуслуги [OpenSea, Dexscreener и другие]', 'crypto-nft'],
    ['Топ-услуги (Instagram, TikTok, Facebook, YouTube и X)', 'multiplatform'],
    ['Комментарии для всех платформ [🇰🇷 Корейский]', 'multiplatform'],
    ['Подписчики и просмотры видео Kick', 'kick'],
    ['SoundCloud', 'soundcloud'],
  ])('%s -> %s', (category, slug) => {
    expect(detectPlatform(category, KNOWN).slug).toBe(slug)
  })

  it('a platform that is not in the registry, or a category nobody recognises, goes to "other"', () => {
    expect(detectPlatform('Behance', new Set(['telegram', 'other'])).slug).toBe(OTHER_PLATFORM)
    expect(detectPlatform('Социальные сигналы', KNOWN).slug).toBe(OTHER_PLATFORM)
    expect(detectPlatform('', KNOWN).slug).toBe(OTHER_PLATFORM)
  })

  it('the multi-platform categories are tested before the single brands (first match wins)', () => {
    const order = PLATFORM_RULES.map((r) => r.slug)
    expect(order.indexOf('multiplatform')).toBeLessThan(order.indexOf('instagram'))
    expect(order.indexOf('multiplatform')).toBeLessThan(order.indexOf('telegram'))
  })

  it('the category key ignores decoration and case', () => {
    expect(categoryKey('Лайки Instagram 🔥')).toBe(categoryKey('лайки instagram'))
  })
})

describe('what may be put on sale', () => {
  const c = (over: Partial<PublishCandidate> = {}): PublishCandidate => ({ id: 'ps', name: 'Просмотры постов Telegram', categoryRaw: 'Просмотры постов Telegram', serviceType: 'Default', rate: 0.5, min: 10, max: 1000, ...over })

  it('a plain Default service with a real price and sane limits qualifies', () => {
    expect(isPublishable(c())).toBe(true)
    expect(isPublishable(c({ serviceType: null }))).toBe(true)
    expect(isPublishable(c({ serviceType: ' default ' }))).toBe(true)
  })

  it.each([
    ['custom comments', { serviceType: 'Custom Comments' }],
    ['a package', { serviceType: 'Package' }],
    ['a subscription', { serviceType: 'Subscriptions' }],
    ['a poll', { serviceType: 'Poll' }],
    ['a separator (rate 0)', { rate: 0, min: 1, max: 1 }],
    ['a separator (underscores)', { name: '__________________' }],
    ['an empty name', { name: '   ' }],
    ['min 0', { min: 0 }],
    ['max below min', { min: 100, max: 10 }],
    ['a fractional limit', { min: 1.5 }],
  ] as const)('%s does not', (_label, over) => {
    expect(isPublishable(c(over as Partial<PublishCandidate>))).toBe(false)
  })
})

describe('buildPublishRows', () => {
  const list: PublishCandidate[] = [
    { id: 'a', name: 'Просмотры постов Telegram [Без восстановления]', categoryRaw: 'Просмотры постов Telegram [один пост]', serviceType: 'Default', rate: 0.006, min: 10, max: 300000 },
    { id: 'b', name: 'Просмотры постов Telegram [Мгновенно]', categoryRaw: 'Просмотры постов Telegram [один пост]', serviceType: 'Default', rate: 0.01, min: 10, max: 300000 },
    { id: 'c', name: 'Лайки Instagram', categoryRaw: 'Лайки Instagram', serviceType: 'Default', rate: 1, min: 10, max: 5000 },
    { id: 'd', name: 'Комментарии Instagram', categoryRaw: 'Комментарии Instagram', serviceType: 'Custom Comments', rate: 1, min: 10, max: 5000 },
    { id: 'e', name: '______', categoryRaw: 'Лайки Instagram', serviceType: 'Default', rate: 0, min: 1, max: 1 },
  ]
  const built = buildPublishRows(list, KNOWN)

  it('builds one row per sellable service and counts the rest as skipped', () => {
    expect(built.rows.map((r) => r.ps)).toEqual(['a', 'b', 'c'])
    expect(built.skipped).toBe(2)
    expect(built.untranslatedServices).toBe(0)
  })

  it('services of one panel category share one category key, name and sort position; a new category gets the next position', () => {
    expect(built.rows[0].cat_key).toBe(built.rows[1].cat_key)
    expect(built.rows[0]).toMatchObject({ platform: 'telegram', cat_name: 'Telegram Post Views [single post]', cat_sort: 0 })
    expect(built.rows[2]).toMatchObject({ platform: 'instagram', cat_sort: 1 })
  })

  it('carries the English name, the original and the facts', () => {
    expect(built.rows[0]).toMatchObject({ name: 'Telegram Post Views [no refill]', name_ru: 'Просмотры постов Telegram [Без восстановления]', attributes: { refill: 'none' } })
    expect(built.rows[1].attributes).toEqual({ })
  })

  it('is fast on a large list (the cache makes repeated tags free)', () => {
    const big = Array.from({ length: 5000 }, (_, i): PublishCandidate => ({ ...list[0], id: `x${i}`, name: `${list[0].name} [Сервер ${i % 7}]` }))
    const t0 = performance.now()
    expect(buildPublishRows(big, KNOWN).rows).toHaveLength(5000)
    expect(performance.now() - t0).toBeLessThan(5000)
  })
})
