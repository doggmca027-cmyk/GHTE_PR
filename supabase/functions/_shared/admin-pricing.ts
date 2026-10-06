// Pure logic of the admin-pricing Edge Function: request parsing and re-pricing. No I/O here, so it is
// unit-testable; the price math itself stays in price-engine.ts (never duplicated in SQL or the UI).
import { calculateCustomerRate } from './price-engine.ts'
import type { Platform, PriceRule } from './types.ts'

const PLATFORMS: readonly Platform[] = ['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'other']
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

export type ParsedPricingRequest = { action: 'GET' } | ({ action: 'UPDATE_RULE' } & UpdateRuleInput)

/** Validates the request body. Returns an error message instead of throwing. */
export function parsePricingRequest(body: unknown): ParsedPricingRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'GET'
  if (action === 'GET') return { action: 'GET' }
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
  if (platform && !PLATFORMS.includes(platform as Platform)) return { error: 'Unknown platform.' }
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
  customer_rate_per_1000: number
  /** The primary provider service's rate: the same basis sync-catalog prices from. */
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
    const rate = calculateCustomerRate(s.provider_rate, rules, { serviceId: s.id, categoryId: s.category_id, platform: s.platform })
    if (r4(rate) !== r4(s.customer_rate_per_1000)) changes.push({ id: s.id, rate })
  }
  return changes
}
