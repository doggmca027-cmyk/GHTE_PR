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
}

export interface ICatalog {
  categories: ICategory[]
  services: ICatalogService[]
}
