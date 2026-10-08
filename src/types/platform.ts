import type { Platform } from './catalog'

/** public.platforms.category: how platforms are grouped. */
export type PlatformCategory = 'social' | 'messaging' | 'video' | 'music' | 'community' | 'web' | 'other'

/**
 * A row of public.platforms, the canonical platform registry. Anyone can read active rows; admins also see inactive ones
 * and write through admin_upsert_platform().
 */
export interface IPlatform {
  id: string
  /** Unique, lower-case. The first seven equal the `Platform` enum values used by categories and price rules. */
  slug: string
  name: string
  /** Icon name or URL; null = the UI falls back to its own icon. */
  icon: string | null
  category: PlatformCategory
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** Slugs that are also values of the legacy `Platform` enum (categories.platform): safe to use as `Platform`. */
export const LEGACY_PLATFORM_SLUGS: readonly Platform[] = ['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'other']

export const isLegacyPlatform = (slug: string): slug is Platform => (LEGACY_PLATFORM_SLUGS as readonly string[]).includes(slug)

/** Columns of public.platforms as PostgREST returns them (snake_case). */
export interface PlatformRow {
  id: string
  slug: string
  name: string
  icon: string | null
  category: PlatformCategory
  active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export const platformFromRow = (r: PlatformRow): IPlatform => ({
  id: r.id, slug: r.slug, name: r.name, icon: r.icon, category: r.category, active: r.active,
  sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
})

/** Arguments of admin_upsert_platform(). */
export interface PlatformUpsertInput {
  slug: string
  name: string
  category: PlatformCategory
  icon?: string | null
  active?: boolean
  sortOrder?: number
}
