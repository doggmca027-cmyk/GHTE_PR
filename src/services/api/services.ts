import { MOCK_CATALOG } from '@/constants/dev'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalog, ICatalogService, ICategory, Platform } from '@/types/catalog'

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
}

async function rest<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY!, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Catalog request failed (${res.status})`)
  return (await res.json()) as T
}

/**
 * Active categories and services. Row Level Security already limits both tables to
 * is_active rows; provider tables are not reachable from the client at all.
 */
export const categoryFromRow = (c: CategoryRow): ICategory => ({
  id: c.id, platform: c.platforms.slug, name: c.name, slug: c.slug, iconUrl: c.icon_url, sortOrder: c.sort_order,
})

export async function fetchCatalog(session: AuthSession): Promise<ICatalog> {
  if (session.isMock) return MOCK_CATALOG
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')

  const [categories, services] = await Promise.all([
    rest<CategoryRow[]>('categories?select=id,name,slug,icon_url,sort_order,platforms!inner(slug)&is_active=eq.true&order=sort_order', session.token),
    rest<ServiceRow[]>(
      'services?select=id,category_id,name,description,customer_rate_per_1000,min_quantity,max_quantity,refill_supported,sort_order&is_active=eq.true&order=sort_order,customer_rate_per_1000',
      session.token,
    ),
  ])

  return {
    categories: categories.map((c): ICategory => ({
      ...categoryFromRow(c),
    })),
    services: services.map((s): ICatalogService => ({
      id: s.id,
      categoryId: s.category_id,
      name: s.name,
      description: s.description,
      ratePer1000: Number(s.customer_rate_per_1000),
      minQuantity: s.min_quantity,
      maxQuantity: s.max_quantity,
      refillSupported: s.refill_supported,
      sortOrder: s.sort_order,
    })),
  }
}
