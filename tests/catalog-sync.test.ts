import { describe, expect, it } from 'vitest'
import {
  diffProviderServices,
  inferPlatform,
  isAuthorized,
  normalizeProviderServices,
  planService,
  resolveCategory,
  slugify,
  summarize,
  emptyProviderReport,
  type ExistingProviderService,
  type ExistingService,
} from '../supabase/functions/_shared/catalog-sync.ts'
import { calculateCustomerRate } from '../supabase/functions/_shared/price-engine.ts'
import { SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { decryptSecret, encryptSecret, providerKeyEnvName } from '../supabase/functions/_shared/secrets.ts'
import type { IProviderService, PriceRule } from '../supabase/functions/_shared/types.ts'

const NOW = '2026-10-07T00:00:00.000Z'
const incoming = (o: Partial<IProviderService> & { externalServiceId: string }): IProviderService => ({
  name: 'Service', type: 'Default', categoryRaw: 'Telegram Views', ratePer1000: 1, minQuantity: 10, maxQuantity: 1000,
  refillSupported: false, cancelSupported: false, ...o,
})
const existingPS = (o: Partial<ExistingProviderService> & { external_service_id: string }): ExistingProviderService => ({
  id: `ps-${o.external_service_id}`, name: 'Service', category_raw: 'Telegram Views', rate_per_1000: 1,
  min_quantity: 10, max_quantity: 1000, refill_supported: false, cancel_supported: false, is_active: true, ...o,
})
const globalRule = (value: number): PriceRule => ({ id: 'g', type: 'percentage', value, priority: 0, is_active: true })

describe('category resolution', () => {
  it('infers platforms from the category, then from the service name', () => {
    expect(inferPlatform('Telegram Views')).toBe('telegram')
    expect(inferPlatform('TikTok Likes')).toBe('tiktok')
    expect(inferPlatform('IG Followers')).toBe('instagram')
    expect(inferPlatform('Followers', 'YouTube Subscribers')).toBe('youtube')
    expect(inferPlatform('Random stuff')).toBe('other')
  })

  it('builds stable platform-prefixed slugs that match the seed', () => {
    expect(slugify('Telegram  Views!')).toBe('telegram-views')
    expect(resolveCategory('Telegram Views')).toEqual({ platform: 'telegram', name: 'Telegram Views', slug: 'telegram-views' })
    expect(resolveCategory('Followers', 'Instagram Followers [HQ]').slug).toBe('instagram-followers')
    expect(resolveCategory('   ').slug).toBe('other-uncategorized')
  })
})

describe('normalizeProviderServices', () => {
  it('drops invalid and duplicate rows and reports why', () => {
    const { valid, skipped } = normalizeProviderServices([
      incoming({ externalServiceId: '1' }),
      incoming({ externalServiceId: '1' }),
      incoming({ externalServiceId: '2', ratePer1000: Number.NaN }),
      incoming({ externalServiceId: '3', minQuantity: 0 }),
      incoming({ externalServiceId: '4', minQuantity: 100, maxQuantity: 10 }),
      incoming({ externalServiceId: '5', name: '  ' }),
    ])
    expect(valid.map((s) => s.externalServiceId)).toEqual(['1'])
    expect(skipped.map((s) => [s.externalServiceId, s.reason])).toEqual([
      ['1', 'duplicate service id'], ['2', 'invalid rate'], ['3', 'invalid min'], ['4', 'invalid max'], ['5', 'empty name'],
    ])
  })
})

describe('diffProviderServices', () => {
  it('classifies added / updated / unchanged / missing / reactivated', () => {
    const existing = [
      existingPS({ external_service_id: 'same' }),
      existingPS({ external_service_id: 'repriced', rate_per_1000: 1 }),
      existingPS({ external_service_id: 'gone' }),
      existingPS({ external_service_id: 'already-off', is_active: false }),
      existingPS({ external_service_id: 'back', is_active: false }),
    ]
    const diff = diffProviderServices('prov', existing, [
      incoming({ externalServiceId: 'same' }),
      incoming({ externalServiceId: 'repriced', ratePer1000: 1.5 }),
      incoming({ externalServiceId: 'new' }),
      incoming({ externalServiceId: 'back' }),
    ], NOW)

    expect(diff.added).toEqual(['new'])
    expect(diff.updated.sort()).toEqual(['back', 'repriced'])
    expect(diff.unchanged).toBe(1)
    expect(diff.missing.map((m) => m.external_service_id)).toEqual(['gone']) // 'already-off' is not re-reported
    expect([...diff.reactivated]).toEqual(['back'])
    expect(diff.rows).toHaveLength(4)
    expect(diff.rows.every((r) => r.is_active && r.last_synced_at === NOW && r.provider_id === 'prov')).toBe(true)
  })

  it('ignores sub-1e-4 rate noise', () => {
    const diff = diffProviderServices('p', [existingPS({ external_service_id: 'a', rate_per_1000: 1.00001 })], [incoming({ externalServiceId: 'a', ratePer1000: 1 })], NOW)
    expect(diff.updated).toEqual([])
  })
})

describe('planService', () => {
  const svc = (o: Partial<ExistingService> = {}): ExistingService => ({
    id: 's1', category_id: 'c1', name: 'Admin renamed', description: 'desc', primary_provider_service_id: 'ps1',
    fallback_provider_service_id: null, customer_rate_per_1000: 2.5, min_quantity: 10, max_quantity: 1000,
    is_active: true, sort_order: 5, refill_supported: false, ...o,
  })
  const base = { providerServiceId: 'ps1', categoryId: 'c1', platform: 'telegram' as const, rules: [globalRule(150)], providerServiceReactivated: false }

  it('creates a priced service for a new provider service', () => {
    const plan = planService({ ...base, provider: incoming({ externalServiceId: '1', name: ' Views ', ratePer1000: 0.08, refillSupported: true }) })
    expect(plan.action).toBe('create')
    expect(plan.row).toMatchObject({
      name: 'Views', category_id: 'c1', primary_provider_service_id: 'ps1', customer_rate_per_1000: 0.2,
      is_active: true, refill_supported: true, min_quantity: 10, max_quantity: 1000,
    })
  })

  it('does nothing when price and limits are already current', () => {
    expect(planService({ ...base, existing: svc(), provider: incoming({ externalServiceId: '1', ratePer1000: 1 }) }).action).toBe('none')
  })

  it('re-prices but keeps admin-owned fields (name, description, sort order)', () => {
    const plan = planService({ ...base, existing: svc(), provider: incoming({ externalServiceId: '1', ratePer1000: 2 }) })
    expect(plan.action).toBe('update')
    expect(plan.repriced).toBe(true)
    expect(plan.row).toMatchObject({ id: 's1', name: 'Admin renamed', description: 'desc', sort_order: 5, customer_rate_per_1000: 5 })
  })

  it('clamps limits to what the provider can deliver but keeps narrower admin limits', () => {
    const narrowed = planService({ ...base, existing: svc({ min_quantity: 50, max_quantity: 500 }), provider: incoming({ externalServiceId: '1', minQuantity: 10, maxQuantity: 1000 }) })
    expect(narrowed.action).toBe('none')
    const clamped = planService({ ...base, existing: svc({ min_quantity: 10, max_quantity: 1000 }), provider: incoming({ externalServiceId: '1', minQuantity: 100, maxQuantity: 800 }) })
    expect(clamped.row).toMatchObject({ min_quantity: 100, max_quantity: 800 })
  })

  it('reactivates only when the provider service came back and the service was off', () => {
    const off = svc({ is_active: false })
    expect(planService({ ...base, existing: off, provider: incoming({ externalServiceId: '1' }) }).action).toBe('none')
    const back = planService({ ...base, existing: off, providerServiceReactivated: true, provider: incoming({ externalServiceId: '1' }) })
    expect(back).toMatchObject({ action: 'update', reactivated: true })
    expect(back.row?.is_active).toBe(true)
  })

  it('applies service-specific rules to existing services', () => {
    const rule: PriceRule = { id: 'svc', type: 'fixed', value: 1, service_id: 's1', priority: 0 }
    const plan = planService({ ...base, rules: [globalRule(150), rule], existing: svc(), provider: incoming({ externalServiceId: '1', ratePer1000: 2 }) })
    expect(plan.row?.customer_rate_per_1000).toBe(3)
  })
})

describe('seed data stays consistent with the price engine', () => {
  // supabase/seed.sql: +150% default, +200% for Telegram.
  const rules: PriceRule[] = [
    { id: 'a', type: 'percentage', value: 150, priority: 0 },
    { id: 'b', type: 'percentage', value: 200, platform: 'telegram', priority: 0 },
  ]
  it.each([
    ['telegram', 0.08, 0.24], ['telegram', 1.8, 5.4], ['instagram', 2.4, 6], ['instagram', 1.2, 3], ['tiktok', 0.6, 1.5], ['tiktok', 1, 2.5],
  ])('%s %d -> %d', (platform, cost, retail) => {
    expect(calculateCustomerRate(cost, rules, { platform })).toBe(retail)
  })

  it('mock adapter catalogue maps onto the seeded categories', () => {
    return new SMMv2Adapter({ id: 'm', name: 'Mock', apiUrl: 'x' }).getServices().then((list) => {
      expect([...new Set(list.map((s) => resolveCategory(s.categoryRaw, s.name).slug))].sort()).toEqual([
        'instagram-followers', 'telegram-members', 'telegram-views', 'tiktok-likes',
      ])
    })
  })
})

describe('sync-catalog request authorisation', () => {
  const h = (init: Record<string, string>) => ({ get: (k: string) => init[k.toLowerCase()] ?? null })
  const secrets = { cronSecret: 'cron-123', serviceRoleKey: 'svc-key' }

  it('accepts the cron secret or the service-role bearer token', () => {
    expect(isAuthorized(h({ 'x-cron-secret': 'cron-123' }), secrets)).toBe(true)
    expect(isAuthorized(h({ authorization: 'Bearer svc-key' }), secrets)).toBe(true)
  })
  it('rejects wrong, missing and anon credentials', () => {
    expect(isAuthorized(h({}), secrets)).toBe(false)
    expect(isAuthorized(h({ 'x-cron-secret': 'cron-124' }), secrets)).toBe(false)
    expect(isAuthorized(h({ authorization: 'Bearer anon-key' }), secrets)).toBe(false)
    expect(isAuthorized(h({ 'x-cron-secret': 'cron-12' }), secrets)).toBe(false)
  })
  it('never matches an unconfigured secret (empty header must not pass)', () => {
    expect(isAuthorized(h({ 'x-cron-secret': '' }), { serviceRoleKey: 'svc-key' })).toBe(false)
    expect(isAuthorized(h({ 'x-cron-secret': '' }), { cronSecret: '' })).toBe(false)
    expect(isAuthorized(h({ authorization: 'Bearer ' }), { serviceRoleKey: '' })).toBe(false)
  })
})

describe('report + provider key helpers', () => {
  it('sums per-provider counters', () => {
    const a = { ...emptyProviderReport('a'), added: 2, updated: 1, deactivated: 0 }
    const b = { ...emptyProviderReport('b'), added: 1, updated: 4, deactivated: 3 }
    expect(summarize([a, b])).toMatchObject({ added: 3, updated: 5, deactivated: 3 })
  })

  it('derives env var names and round-trips AES-GCM secrets', async () => {
    expect(providerKeyEnvName('Secsers Mock')).toBe('PROVIDER_SECSERS_MOCK_API_KEY')
    const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
    const sealed = await encryptSecret('my-api-key', master)
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('my-api-key')
    expect(await decryptSecret(sealed, master)).toBe('my-api-key')
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
    await expect(decryptSecret(sealed, other)).rejects.toThrow()
    await expect(decryptSecret(sealed.slice(0, -4) + 'AAAA', master)).rejects.toThrow()
  })
})
