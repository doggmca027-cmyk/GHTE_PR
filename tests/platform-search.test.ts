import { describe, expect, it } from 'vitest'
import { LOGO_CDN, logoSlugFromName, logoUrl, logoFailed, markLogoFailed, resetLogoFailures } from '../src/lib/platform-logo'
import { PLATFORM_ALIASES, normalizeQuery, searchPlatforms } from '../src/lib/platform-search'

const P = (slug: string, name: string) => ({ slug, name })
const LIST = [
  P('telegram', 'Telegram'), P('instagram', 'Instagram'), P('whatsapp', 'WhatsApp'), P('tiktok', 'TikTok'), P('youtube', 'YouTube'),
  P('twitter', 'X (Twitter)'), P('facebook', 'Facebook'), P('vk', 'VK'), P('twitch', 'Twitch'), P('snapchat', 'Snapchat'),
  P('soundcloud', 'SoundCloud'), P('apple-music', 'Apple Music'), P('yandex-music', 'Yandex Music'), P('odnoklassniki', 'Odnoklassniki'),
  P('xiaohongshu', 'Xiaohongshu (RED)'), P('website', 'Website Traffic'), P('discord', 'Discord'), P('spotify', 'Spotify'),
  P('linkedin', 'LinkedIn'), P('reddit', 'Reddit'), P('trustpilot', 'Trustpilot'), P('other', 'Other'),
]
const find = (q: string) => searchPlatforms(LIST, q).map((p) => p.slug)

describe('search', () => {
  it.each([
    ['tg', 'telegram'], ['телега', 'telegram'], ['Телеграм', 'telegram'],
    ['ig', 'instagram'], ['инста', 'instagram'], ['инстаграм', 'instagram'],
    ['vk', 'vk'], ['вк', 'vk'], ['вконтакте', 'vk'], ['vkontakte', 'vk'],
    ['yt', 'youtube'], ['ютуб', 'youtube'],
    ['tt', 'tiktok'], ['тикток', 'tiktok'], ['тик ток', 'tiktok'],
    ['fb', 'facebook'], ['фейсбук', 'facebook'], ['ватсап', 'whatsapp'], ['wa', 'whatsapp'], ['твич', 'twitch'],
    ['ок', 'odnoklassniki'], ['одноклассники', 'odnoklassniki'], ['снапчат', 'snapchat'], ['дискорд', 'discord'],
    ['сайт', 'website'], ['трафик', 'website'], ['red', 'xiaohongshu'], ['икс', 'twitter'], ['x', 'twitter'],
  ])('"%s" finds %s first', (query, slug) => {
    expect(find(query)[0]).toBe(slug)
  })

  it('is case-insensitive, ignores surrounding space, punctuation and accents, and folds ё to е', () => {
    expect(find('  TG  ')).toEqual(find('tg'))
    expect(find('Tele-gram')[0]).toBe('telegram')
    expect(find('ЁЖ')).toEqual(find('еж'))
    expect(normalizeQuery(' Café—Müller! ')).toBe('cafe muller')
  })

  it('an empty query returns the whole list in its own order; nothing is mutated', () => {
    const before = [...LIST]
    expect(searchPlatforms(LIST, '')).toEqual(LIST)
    expect(searchPlatforms(LIST, '   ')).toEqual(LIST)
    expect(LIST).toEqual(before)
  })

  it('ranks an exact hit above a prefix above a word above a substring, and keeps the list order for ties', () => {
    expect(find('x')[0]).toBe('twitter') // alias "x" is exact; Xiaohongshu only starts with it
    expect(find('x')).toContain('xiaohongshu')
    expect(find('music')).toEqual(['apple-music', 'yandex-music']) // a word of the name, then list order
    expect(find('tele')[0]).toBe('telegram')
    const sub = find('hub') // only a substring of one name
    expect(sub).toEqual([])
    expect(find('pot')).toEqual(['spotify']) // "pot" is inside Spotify, not at its start: substring rank
  })

  it('tolerates one typo in a word of four letters or more, but not in short queries', () => {
    expect(find('instgram')).toContain('instagram')
    expect(find('youtub')).toContain('youtube')
    expect(find('discrod')).toContain('discord')
    expect(find('tgx')).toEqual([]) // short: no guessing
    expect(find('zzzzzz')).toEqual([])
  })

  it('matches by the slug too', () => {
    expect(find('apple-music')[0]).toBe('apple-music')
    expect(find('apple music')[0]).toBe('apple-music')
  })

  it('an alias found in two platforms returns both (sc: Snapchat and SoundCloud)', () => {
    expect(find('sc').slice(0, 2).sort()).toEqual(['snapchat', 'soundcloud'])
  })

  it('every alias belongs to a platform of the registry and is written in lower case', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261112000000_more_platforms.sql'), 'utf8') +
      fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261029000000_platforms_registry.sql'), 'utf8')
    for (const [slug, aliases] of Object.entries(PLATFORM_ALIASES)) {
      expect(sql, slug).toContain(`'${slug}'`)
      for (const a of aliases) expect(a, `${slug}: ${a}`).toBe(a.toLowerCase())
    }
  })

  it('is fast enough to run on every keystroke over a long list', () => {
    const big = Array.from({ length: 2000 }, (_, i) => P(`platform-${i}`, `Platform Number ${i}`))
    const t0 = performance.now()
    for (const q of ['p', 'pla', 'platfrm', 'tg', 'number 19']) searchPlatforms(big, q)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe('logo addresses', () => {
  it('are built from the name without spaces and punctuation, on the SimpleIcons CDN', () => {
    expect(logoSlugFromName('Apple Music')).toBe('applemusic')
    expect(logoSlugFromName('VC.ru')).toBe('vcru')
    expect(logoUrl('twitch', 'Twitch')).toBe(`${LOGO_CDN}/twitch`)
    expect(logoUrl('tiktok', 'TikTok')).toBe('https://cdn.simpleicons.org/tiktok')
    expect(logoUrl('apple-music', 'Apple Music')).toBe('https://cdn.simpleicons.org/applemusic')
  })

  it('known mismatches use SimpleIcons\' own name (X, not "xtwitter")', () => {
    expect(logoUrl('twitter', 'X (Twitter)')).toBe('https://cdn.simpleicons.org/x')
    expect(logoUrl('google-maps', 'Google Maps')).toBe('https://cdn.simpleicons.org/googlemaps')
  })

  it('generic platforms and names with no latin letters make no request at all', () => {
    for (const slug of ['website', 'other', 'multiplatform', 'smm-tools', 'mobile-apps', 'crypto-nft']) expect(logoUrl(slug, 'Anything'), slug).toBeNull()
    expect(logoUrl('yandex-x', 'Яндекс')).toBeNull()
    expect(logoUrl('weird', '   ')).toBeNull()
  })

  it('a failed logo is remembered for the session', () => {
    resetLogoFailures()
    const url = logoUrl('linkedin', 'LinkedIn')!
    expect(logoFailed(url)).toBe(false)
    markLogoFailed(url)
    expect(logoFailed(url)).toBe(true)
    resetLogoFailures()
    expect(logoFailed(url)).toBe(false)
  })
})
