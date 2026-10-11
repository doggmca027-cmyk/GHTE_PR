// What the Home screen shows, worked out from data the app already loads (categories, platforms, orders). Pure, so it is tested.
import { isActiveStatus } from '@/lib/order-view'
import type { PlatformEntry } from '@/components/services/PlatformList'
import type { ICategory } from '@/types/catalog'
import type { IOrderView } from '@/types/orders'

/** Shown while the catalogue loads (and if it cannot be read): a floor of what the storefront sells, not a live count. */
export const SERVICES_FALLBACK = '7 300+'

/** Active services across every category. */
export const totalServices = (categories: ReadonlyArray<Pick<ICategory, 'count'>>): number =>
  categories.reduce((sum, c) => sum + (c.count ?? 0), 0)

/** The platforms people come for, in this order; any other busy platform fills the remaining tiles. */
const POPULAR = ['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'spotify', 'website']

/** Up to `max` tiles: the popular platforms that have services, then the busiest others. Never a platform without services. */
export function quickPlatforms(entries: readonly PlatformEntry[], max = 8): PlatformEntry[] {
  const withServices = entries.filter((e) => e.count > 0)
  const popular = POPULAR.map((slug) => withServices.find((e) => e.slug === slug)).filter((e): e is PlatformEntry => e !== undefined)
  const rest = withServices.filter((e) => !POPULAR.includes(e.slug)).sort((a, b) => b.count - a.count)
  return [...popular, ...rest].slice(0, max)
}

/** What a featured slot looks for: a category of this platform whose (English) name matches. */
interface FeaturedRule {
  platform: string
  match: RegExp
  /** Words that make a category something else (story views are not post views). */
  not?: RegExp
}

const FEATURED: FeaturedRule[] = [
  // the plain, everyday versions: targeted / premium / auto / ad variants are niche
  { platform: 'telegram', match: /view/i, not: /stor|reaction|comment|poll|vote|live|search|seo|premium|target|auto|\bads?\b|click/i },
  { platform: 'telegram', match: /member|subscriber/i, not: /premium|\bbots?\b|online|\bai\b|target/i },
  { platform: 'instagram', match: /like/i, not: /comment|story|live|reel|target|auto/i },
  { platform: 'tiktok', match: /view/i, not: /live|story|\bads?\b|target/i },
]

/**
 * One category per featured slot: the busiest category of that platform whose name matches (most services = the core of what is
 * sold). A slot with no match is left out, so the block never shows something unrelated.
 */
export function featuredCategories(categories: readonly ICategory[]): ICategory[] {
  const out: ICategory[] = []
  for (const rule of FEATURED) {
    const best = categories
      .filter((c) => c.platform === rule.platform && rule.match.test(c.name) && !(rule.not?.test(c.name)) && (c.count ?? 0) > 0 && !out.includes(c))
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.sortOrder - b.sortOrder)[0]
    if (best) out.push(best)
  }
  return out
}

export interface OrdersSummary {
  total: number
  active: number
  completed: number
}

export function ordersSummary(orders: readonly Pick<IOrderView, 'status'>[]): OrdersSummary {
  return {
    total: orders.length,
    active: orders.filter((o) => isActiveStatus(o.status)).length,
    completed: orders.filter((o) => o.status === 'completed').length,
  }
}

/**
 * The invite link: the Mini App link (VITE_TWA_RETURN_URL, https://t.me/<bot> or https://t.me/<bot>/<app>) with the start
 * parameter. Without a usable Mini App link there is no link, only the code.
 */
export function referralLink(appUrl: string | undefined, startParam: string): string | null {
  const base = appUrl?.trim().replace(/\/+$/, '')
  if (!base || !/^https:\/\/t\.me\/[A-Za-z0-9_]{3,}(\/[A-Za-z0-9_]+)?$/.test(base)) return null
  return `${base}?startapp=${encodeURIComponent(startParam)}`
}
