// Pure logic of the admin-pricing Edge Function: request parsing and re-pricing. No I/O here, so it is
// unit-testable; the price math itself stays in price-engine.ts (never duplicated in SQL or the UI).
import { calculateCustomerRate } from './price-engine.ts'
import type { Platform, PriceRule } from './types.ts'

// any slug of the platform registry (98 platforms); the function looks it up in the database and answers "Unknown platform" for a slug that is not there
const PLATFORM_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RULE_VALUE = 100_000

export interface UpdateRuleInput {
  serviceId: string | null
  categoryId: string | null
  platform: Platform | null
  type: 'fixed' | 'percentage'
  /** Rounded to 2 decimals, like price_rules.value. */
  value: number
}

/** Which services the pricing grid shows, a page at a time (the catalogue has thousands). */
export interface PricingQuery {
  search: string
  platform: string | null
  categoryId: string | null
  offset: number
  limit: number
}

export const PRICING_PAGE_MAX = 100

export type ParsedPricingRequest = ({ action: 'GET' } & PricingQuery) | ({ action: 'UPDATE_RULE' } & UpdateRuleInput)

/** One row of get_admin_pricing_view, as far as the grid filter needs it. */
export interface PricingViewRow {
  name?: unknown
  category?: unknown
  category_id?: unknown
  platform?: unknown
}

/** Filters the pricing view by search text (every word must appear in the name or the category), platform and category, then cuts one page. */
export function pagePricingRows<T extends PricingViewRow>(rows: T[], q: PricingQuery): { rows: T[]; total: number } {
  const words = q.search.toLowerCase().split(/s+/).filter(Boolean)
  const hits = rows.filter((r) => {
    if (q.platform && r.platform !== q.platform) return false
    if (q.categoryId && r.category_id !== q.categoryId) return false
    if (words.length === 0) return true
    const hay = `${String(r.name ?? '')} ${String(r.category ?? '')}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  return { rows: hits.slice(q.offset, q.offset + q.limit), total: hits.length }
}

/** Validates the request body. Returns an error message instead of throwing. */
export function parsePricingRequest(body: unknown): ParsedPricingRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'GET'
  if (action === 'GET') {
    const search = typeof b.search === 'string' ? b.search.trim().slice(0, 80) : ''
    const platform = typeof b.platform === 'string' && b.platform !== '' ? b.platform : null
    if (platform && !PLATFORM_SLUG.test(platform)) return { error: 'Unknown platform.' }
    const categoryId = typeof b.categoryId === 'string' && b.categoryId !== '' ? b.categoryId : null
    if (categoryId && !UUID.test(categoryId)) return { error: 'Invalid scope id.' }
    const int = (v: unknown, fallback: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : fallback)
    return { action: 'GET', search, platform, categoryId, offset: int(b.offset, 0, 1_000_000), limit: Math.max(1, int(b.limit, 30, PRICING_PAGE_MAX)) }
  }
  if (action !== 'UPDATE_RULE') return { error: 'Unknown action.' }

  const scope = (key: string): string | null | undefined => {
    const v = b[key]
    if (v === undefined || v === null || v === '') return null
    return typeof v === 'string' ? v : undefined
  }
  const serviceId = scope('serviceId')
  const categoryId = scope('categoryId')
  const platform = scope('platform')
  if (serviceId === undefined || categoryId === undefined || platform === undefined) return { error: 'Invalid scope.' }
  if ((serviceId && !UUID.test(serviceId)) || (categoryId && !UUID.test(categoryId))) return { error: 'Invalid scope id.' }
  if (platform && !PLATFORM_SLUG.test(platform)) return { error: 'Unknown platform.' }
  if ([serviceId, categoryId, platform].filter(Boolean).length > 1) return { error: 'A rule targets at most one scope.' }

  if (b.type !== 'fixed' && b.type !== 'percentage') return { error: 'type must be "fixed" or "percentage".' }
  if (typeof b.value !== 'number' || !Number.isFinite(b.value) || b.value < 0 || b.value > MAX_RULE_VALUE) {
    return { error: `value must be a number from 0 to ${MAX_RULE_VALUE}.` }
  }
  return {
    action: 'UPDATE_RULE',
    serviceId, categoryId, platform: platform as Platform | null,
    type: b.type,
    value: Math.round(b.value * 100) / 100,
  }
}

/** A services row joined with its category platform and the provider rate price_rules are applied to. */
export interface RepriceService {
  id: string
  category_id: string
  platform: Platform
  /** Matched by keyword rules (name_all / name_any); without it only scope and tier rules apply. */
  name?: string
  customer_rate_per_1000: number
  /** The cheapest offer that can receive an order (service-cost.ts): the same basis sync-catalog prices from. */
  provider_rate: number
}

/** Services whose price the changed rule's scope can influence. */
export function affectedServices(services: RepriceService[], scope: Pick<UpdateRuleInput, 'serviceId' | 'categoryId' | 'platform'>): RepriceService[] {
  if (scope.serviceId) return services.filter((s) => s.id === scope.serviceId)
  if (scope.categoryId) return services.filter((s) => s.category_id === scope.categoryId)
  if (scope.platform) return services.filter((s) => s.platform === scope.platform)
  return services
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000

/** New customer rates (only for services whose rate actually changes), using the shared price engine. */
export function repriceServices(services: RepriceService[], rules: PriceRule[]): { id: string; rate: number }[] {
  const changes: { id: string; rate: number }[] = []
  for (const s of services) {
    const rate = calculateCustomerRate(s.provider_rate, rules, { serviceId: s.id, categoryId: s.category_id, platform: s.platform, serviceName: s.name })
    if (r4(rate) !== r4(s.customer_rate_per_1000)) changes.push({ id: s.id, rate })
  }
  return changes
}
