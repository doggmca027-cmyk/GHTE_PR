import { MOCK_CATALOG, MOCK_PLATFORMS } from '@/constants/dev'
import type { PlatformInfo } from '@/constants/platforms'
import type { PlatformCategory } from '@/types/platform'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalogService, ICategory, Platform, ServiceAttributes } from '@/types/catalog'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const REQUEST_TIMEOUT_MS = 10_000

/** categories row with its platform joined from the registry (platforms.slug). */
export interface CategoryRow {
  id: string
  platforms: { slug: Platform }
  name: string
  slug: string
  icon_url: string | null
  sort_order: number
  name_i18n?: Record<string, string> | null
  active_service_count?: number | null
}

interface ServiceRow {
  id: string
  category_id: string
  name: string
  description: string | null
  customer_rate_per_1000: number | string
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  sort_order: number
  name_i18n?: Record<string, string> | null
  attributes?: ServiceAttributes | null
}

/** The only columns of `services` the app reads (the database also hides the provider-service ids from customers). */
export const SERVICE_COLUMNS = ['id', 'category_id', 'name', 'description', 'customer_rate_per_1000', 'min_quantity', 'max_quantity', 'refill_supported', 'sort_order', 'name_i18n', 'attributes'] as const

/** Services shown at a time in a category: a category can hold hundreds, the customer asks for more. */
export const SERVICES_PAGE = 30

async function rest<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY!, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Catalog request failed (${res.status})`)
  return (await res.json()) as T
}

/**
 * Active categories. Row Level Security already limits the tables to is_active rows; provider tables are not reachable from the
 * client at all.
 */
export const categoryFromRow = (c: CategoryRow): ICategory => ({
  id: c.id, platform: c.platforms.slug, name: c.name, slug: c.slug, iconUrl: c.icon_url, sortOrder: c.sort_order,
  ...(c.name_i18n && Object.keys(c.name_i18n).length > 0 ? { nameI18n: c.name_i18n } : {}),
  ...(c.active_service_count != null ? { count: Number(c.active_service_count) } : {}),
})

export const serviceFromRow = (s: ServiceRow): ICatalogService => ({
  id: s.id,
  categoryId: s.category_id,
  name: s.name,
  description: s.description,
  ratePer1000: Number(s.customer_rate_per_1000),
  minQuantity: s.min_quantity,
  maxQuantity: s.max_quantity,
  refillSupported: s.refill_supported,
  sortOrder: s.sort_order,
  ...(s.name_i18n && Object.keys(s.name_i18n).length > 0 ? { nameI18n: s.name_i18n } : {}),
  ...(s.attributes && Object.keys(s.attributes).length > 0 ? { attributes: s.attributes } : {}),
})

/** The active platforms of the registry, in the admin's order. Anyone may read them (RLS: active rows only). */
export async function fetchPlatforms(session: AuthSession): Promise<PlatformInfo[]> {
  if (session.isMock) return MOCK_PLATFORMS
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')
  const rows = await rest<Array<{ slug: string; name: string; category: PlatformCategory; sort_order: number }>>(
    'platforms?select=slug,name,category,sort_order&active=eq.true&order=sort_order,name', session.token)
  return rows.map((r) => ({ slug: r.slug, name: r.name, category: r.category, sortOrder: r.sort_order }))
}

/**
 * The categories that hold at least one active service, with how many (a few hundred rows). The services themselves are not loaded
 * here: a platform can hold thousands, so they are fetched a page at a time when a category is opened (fetchCategoryServices).
 */
export async function fetchCategories(session: AuthSession): Promise<ICategory[]> {
  if (session.isMock) return MOCK_CATALOG.categories.map((c) => ({ ...c, count: MOCK_CATALOG.services.filter((s) => s.categoryId === c.id).length }))
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')
  const rows = await rest<CategoryRow[]>(
    'categories?select=id,name,slug,icon_url,sort_order,name_i18n,active_service_count,platforms!inner(slug)&is_active=eq.true&active_service_count=gt.0&platforms.active=eq.true&order=sort_order,name&limit=1000',
    session.token,
  )
  return rows.map(categoryFromRow)
}

/** One page of a category's active services cheapest first (a stable order, so pages never overlap). */
export async function fetchCategoryServices(session: AuthSession, categoryId: string, offset = 0, limit = SERVICES_PAGE): Promise<ICatalogService[]> {
  if (session.isMock) {
    const all = MOCK_CATALOG.services
      .filter((s) => s.categoryId === categoryId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.ratePer1000 - b.ratePer1000 || a.name.localeCompare(b.name))
    return all.slice(offset, offset + limit)
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')
  const rows = await rest<ServiceRow[]>(
    `services?select=${SERVICE_COLUMNS.join(',')}&category_id=eq.${encodeURIComponent(categoryId)}&is_active=eq.true&order=sort_order,customer_rate_per_1000,id&limit=${limit}&offset=${offset}`,
    session.token,
  )
  return rows.map(serviceFromRow)
}
