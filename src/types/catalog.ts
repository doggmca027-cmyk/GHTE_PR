import type { ServiceAttributes } from '../../supabase/functions/_shared/service-text.ts'

export type { ServiceAttributes }

/** A platform slug from the registry (public.platforms.slug): 'telegram', 'twitch', 'apple-music', ... */
export type Platform = string

/** Active row of public.categories. */
export interface ICategory {
  id: string
  platform: Platform
  name: string
  slug: string
  iconUrl: string | null
  sortOrder: number
  /** The name in other languages ({ ru: "..." }): the English `name` is the default. */
  nameI18n?: Record<string, string>
  /** Active services in the category (kept by the database). */
  count?: number
}

/** Active row of public.services as exposed to customers (no provider data). */
export interface ICatalogService {
  id: string
  categoryId: string
  name: string
  description: string | null
  ratePer1000: number
  minQuantity: number
  maxQuantity: number
  refillSupported: boolean
  sortOrder: number
  /** The original name of a service the sync published ({ ru: "..." }). */
  nameI18n?: Record<string, string>
  /** What the service promises, as facts the app describes in the customer's language. */
  attributes?: ServiceAttributes
  /**
   * Other variants of the same service (quality / speed / guarantee), cheapest first: the card shows switches. Only on the main
   * service of a group (the cheapest), in a category listing.
   */
  variants?: ICatalogService[]
  /** The order form offers gradual delivery (drip-feed): at least one routable offer of this service can do it. */
  dripfeedAvailable?: boolean
}

export interface ICatalog {
  categories: ICategory[]
  services: ICatalogService[]
}
