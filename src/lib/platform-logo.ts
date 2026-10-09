// Brand logos come from the SimpleIcons CDN at run time, so the app bundles none of them: https://cdn.simpleicons.org/<slug> answers
// with the logo in the brand's own colour (404 when SimpleIcons has no such brand; some brands, LinkedIn among them, were removed).
// Whatever goes wrong (offline, blocked, 404) the platform keeps its coloured tile with initials: see PlatformBadge.

export const LOGO_CDN = 'https://cdn.simpleicons.org'

/** Registry slugs whose SimpleIcons name is not "the name without spaces and punctuation". */
const SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  twitter: 'x',
  'apple-music': 'applemusic',
  'apple-podcasts': 'applepodcasts',
  'app-store': 'appstore',
  'google-maps': 'googlemaps',
  'truth-social': 'truthsocial',
  'yandex-zen': 'dzen',
  'yandex-music': 'yandexmusic',
  'yandex-maps': 'yandexmaps',
  odnoklassniki: 'odnoklassniki',
  xiaohongshu: 'xiaohongshu',
  vk: 'vk',
}

/** Platforms that are not a brand at all: asking the CDN for them is a guaranteed 404, so no request is made. */
const NO_LOGO: ReadonlySet<string> = new Set([
  'website', 'other', 'multiplatform', 'smm-tools', 'mobile-apps', 'app-installs', 'email-marketing', 'backlinks', 'crypto-nft',
])

/** "Apple Music" -> "applemusic", "VC.ru" -> "vcru": lower case, only letters and digits. */
export const logoSlugFromName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The logo URL of a platform, or null when there is nothing to ask for. */
export function logoUrl(slug: string, name: string): string | null {
  if (NO_LOGO.has(slug)) return null
  const id = SLUG_OVERRIDES[slug] ?? logoSlugFromName(name)
  return /^[a-z0-9]{1,40}$/.test(id) ? `${LOGO_CDN}/${id}` : null
}

/** Logos that failed to load in this session: not asked for again (a re-render or a new list must not retry a 404 or an offline CDN). */
const failed = new Set<string>()
export const logoFailed = (url: string): boolean => failed.has(url)
export const markLogoFailed = (url: string): void => void failed.add(url)
/** Logos that loaded: a row that is filtered out and shown again starts with its logo (the browser has it cached) instead of flashing the initials. */
const loaded = new Set<string>()
export const logoLoaded = (url: string): boolean => loaded.has(url)
export const markLogoLoaded = (url: string): void => void loaded.add(url)
/** For tests. */
export const resetLogoFailures = (): void => {
  failed.clear()
  loaded.clear()
}
