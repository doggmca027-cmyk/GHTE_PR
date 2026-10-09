import type { PlatformCategory } from '@/types/platform'

/** What the storefront needs to list a platform (a row of public.platforms, minus the admin fields). */
export interface PlatformInfo {
  slug: string
  name: string
  category: PlatformCategory
  sortOrder: number
}

/** Used only when the registry cannot be read (offline dev, a failed request): the platforms the app has always had. */
export const FALLBACK_PLATFORMS: readonly PlatformInfo[] = [
  { slug: 'telegram', name: 'Telegram', category: 'messaging', sortOrder: 10 },
  { slug: 'instagram', name: 'Instagram', category: 'social', sortOrder: 20 },
  { slug: 'tiktok', name: 'TikTok', category: 'video', sortOrder: 30 },
  { slug: 'youtube', name: 'YouTube', category: 'video', sortOrder: 40 },
  { slug: 'twitter', name: 'X (Twitter)', category: 'social', sortOrder: 50 },
  { slug: 'facebook', name: 'Facebook', category: 'social', sortOrder: 60 },
  { slug: 'other', name: 'Other', category: 'other', sortOrder: 1000 },
]

/** Brand colours of the platforms people recognise by colour. Everything else gets a stable colour from PALETTE. */
export const BRAND_COLORS: Record<string, string> = {
  telegram: '#229ED9', instagram: '#E4405F', tiktok: '#161823', youtube: '#FF0000', twitter: '#111111', facebook: '#1877F2',
  spotify: '#1DB954', discord: '#5865F2', reddit: '#FF4500', website: '#0EA5A4', whatsapp: '#25D366', snapchat: '#F5B800',
  linkedin: '#0A66C2', pinterest: '#E60023', threads: '#101010', twitch: '#9146FF', vk: '#0077FF', line: '#06C755',
  quora: '#B92B27', tumblr: '#36465D', soundcloud: '#FF5500', 'apple-music': '#FA243C', deezer: '#A238FF', audiomack: '#FFA200',
  shazam: '#0088FF', kick: '#3BB510', rumble: '#5BA02E', trovo: '#19D66B', likee: '#E21A59', kwai: '#FF6A00', kuaishou: '#FF4906',
  snackvideo: '#F5A300', bluesky: '#0085FF', 'truth-social': '#5448EE', clubhouse: '#E8A600', xiaohongshu: '#FF2442',
  odnoklassniki: '#EE8208', medium: '#121212', steam: '#1B2838', rutube: '#14172B', vimeo: '#1AB7EA', dailymotion: '#0066DC',
  '9gag': '#161616', 'yandex-zen': '#161616', 'yandex-music': '#FC3F1D', 'yandex-maps': '#FC3F1D', github: '#24292F',
  'google-maps': '#34A853', trustpilot: '#00B67A', tripadvisor: '#00AF87', shopee: '#EE4D2D', fiverr: '#1DBF73', imdb: '#D4A800',
  'app-store': '#0D84FF', 'apple-podcasts': '#9933CC', tidal: '#111111', roblox: '#E2231A', naver: '#03C75A', max: '#7B3FF2',
  potato: '#D8861B', dribbble: '#EA4C89', coinmarketcap: '#3861FB', 'crypto-nft': '#F7931A', avito: '#0AF', triller: '#E52E71',
}

const PALETTE = ['#0098EA', '#6C5CE7', '#00A8A8', '#E17055', '#2D9CDB', '#8E6BBF', '#E0784A', '#3F8F6B', '#C2548B', '#5B7DB1']

/** The tile colour of a platform: its brand colour, or a stable one derived from the slug. */
export function platformColor(slug: string): string {
  if (BRAND_COLORS[slug]) return BRAND_COLORS[slug]
  let h = 0
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/** "Apple Music" -> "AM", "Twitch" -> "TW", "X (Twitter)" -> "X". */
export function platformInitials(name: string): string {
  const words = name.replace(/\(.*?\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2)
  return letters.toUpperCase()
}
