// Pure catalog-sync logic (no I/O) so it can be unit-tested. The sync-catalog Edge
// Function loads rows, calls these functions, and writes the resulting plan.

import { calculateCustomerRate } from './price-engine.ts'
import { timingSafeEqual } from './telegram.ts'
import type { IProviderService, Platform, PriceRule } from './types.ts'

// ---------------------------------------------------------------------------
// Request authorisation
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
const safeEq = (a: string, b: string) => timingSafeEqual(enc.encode(a), enc.encode(b))

/**
 * Accepts either `x-cron-secret: <CRON_SECRET>` or `Authorization: Bearer <service role key>`.
 * Both comparisons are constant-time. Unconfigured secrets never match.
 */
export function isAuthorized(
  headers: { get(name: string): string | null },
  secrets: { cronSecret?: string; serviceRoleKey?: string },
): boolean {
  let ok = false
  const cron = headers.get('x-cron-secret')
  if (secrets.cronSecret && cron !== null) ok = safeEq(cron, secrets.cronSecret) || ok
  const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1]
  if (secrets.serviceRoleKey && bearer) ok = safeEq(bearer, secrets.serviceRoleKey) || ok
  return ok
}

// ---------------------------------------------------------------------------
// Category resolution
// ---------------------------------------------------------------------------

const PLATFORM_KEYWORDS: [Platform, RegExp][] = [
  ['telegram', /telegram|\btg\b|t\.me/i],
  ['instagram', /instagram|\big\b|insta\b/i],
  ['tiktok', /tik\s?tok/i],
  ['youtube', /youtube|\byt\b/i],
  ['twitter', /twitter|\bx\.com\b|\btweet/i],
  ['facebook', /facebook|\bfb\b/i],
]

export function inferPlatform(categoryRaw: string, name = ''): Platform {
  for (const [platform, re] of PLATFORM_KEYWORDS) if (re.test(categoryRaw)) return platform
  for (const [platform, re] of PLATFORM_KEYWORDS) if (re.test(name)) return platform
  return 'other'
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export interface ResolvedCategory {
  platform: Platform
  name: string
  slug: string
}

/** "Telegram Views" -> telegram / telegram-views;  "Followers" (name mentions IG) -> instagram-followers. */
export function resolveCategory(categoryRaw: string, serviceName = ''): ResolvedCategory {
  const name = categoryRaw.trim() || 'Uncategorized'
  const platform = inferPlatform(name, serviceName)
  let slug = slugify(name) || 'uncategorized'
  if (!slug.startsWith(platform)) slug = `${platform}-${slug}`
  return { platform, name, slug }
}

// ---------------------------------------------------------------------------
// Provider-service normalisation and diff
// ---------------------------------------------------------------------------

export interface SkippedService {
  externalServiceId: string
  reason: string
}

export function normalizeProviderServices(list: IProviderService[]): {
  valid: IProviderService[]
  skipped: SkippedService[]
} {
  const valid: IProviderService[] = []
  const skipped: SkippedService[] = []
  const seen = new Set<string>()
  for (const s of list) {
    const id = s.externalServiceId
    const reason = !id || id === 'undefined'
      ? 'missing service id'
      : seen.has(id)
        ? 'duplicate service id'
        : !s.name.trim()
          ? 'empty name'
          : !Number.isFinite(s.ratePer1000) || s.ratePer1000 < 0
            ? 'invalid rate'
            : !Number.isInteger(s.minQuantity) || s.minQuantity <= 0
              ? 'invalid min'
              : !Number.isInteger(s.maxQuantity) || s.maxQuantity < s.minQuantity
                ? 'invalid max'
                : null
    if (reason) skipped.push({ externalServiceId: id, reason })
    else {
      seen.add(id)
      valid.push(s)
    }
  }
  return { valid, skipped }
}

export interface ExistingProviderService {
  id: string
  external_service_id: string
  name: string
  category_raw: string | null
  rate_per_1000: number
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  cancel_supported: boolean
  is_active: boolean
}

export interface ProviderServiceRow {
  provider_id: string
  external_service_id: string
  name: string
  category_raw: string
  rate_per_1000: number
  min_quantity: number
  max_quantity: number
  refill_supported: boolean
  cancel_supported: boolean
  is_active: true
  last_synced_at: string
}

export interface ProviderServiceDiff {
  /** Every incoming row (also refreshes last_synced_at). */
  rows: ProviderServiceRow[]
  added: string[]
  updated: string[]
  unchanged: number
  /** Active rows the provider no longer lists: to be deactivated, never deleted. */
  missing: ExistingProviderService[]
  /** External ids that were inactive and are listed again. */
  reactivated: Set<string>
}

const r4 = (n: number) => Math.round(Number(n) * 10_000)

export function diffProviderServices(
  providerId: string,
  existing: ExistingProviderService[],
  incoming: IProviderService[],
  nowIso: string,
): ProviderServiceDiff {
  const byExt = new Map(existing.map((e) => [e.external_service_id, e]))
  const incomingIds = new Set(incoming.map((s) => s.externalServiceId))
  const diff: ProviderServiceDiff = {
    rows: [], added: [], updated: [], unchanged: 0, missing: [], reactivated: new Set(),
  }

  for (const s of incoming) {
    const row: ProviderServiceRow = {
      provider_id: providerId,
      external_service_id: s.externalServiceId,
      name: s.name.trim(),
      category_raw: s.categoryRaw.trim(),
      rate_per_1000: s.ratePer1000,
      min_quantity: s.minQuantity,
      max_quantity: s.maxQuantity,
      refill_supported: s.refillSupported,
      cancel_supported: s.cancelSupported,
      is_active: true,
      last_synced_at: nowIso,
    }
    diff.rows.push(row)

    const prev = byExt.get(s.externalServiceId)
    if (!prev) {
      diff.added.push(s.externalServiceId)
      continue
    }
    if (!prev.is_active) diff.reactivated.add(s.externalServiceId)
    const changed =
      !prev.is_active ||
      prev.name !== row.name ||
      (prev.category_raw ?? '') !== row.category_raw ||
      r4(prev.rate_per_1000) !== r4(row.rate_per_1000) ||
      prev.min_quantity !== row.min_quantity ||
      prev.max_quantity !== row.max_quantity ||
      prev.refill_supported !== row.refill_supported ||
      prev.cancel_supported !== row.cancel_supported
    if (changed) diff.updated.push(s.externalServiceId)
    else diff.unchanged++
  }

  diff.missing = existing.filter((e) => e.is_active && !incomingIds.has(e.external_service_id))
  return diff
}

// ---------------------------------------------------------------------------
// Poisoned catalog protection
// ---------------------------------------------------------------------------

/** A price move larger than this (either way) is not applied automatically. */
export const MAX_PRICE_CHANGE = 0.3

export interface CatalogAnomaly {
  externalServiceId: string
  /** provider_services.id of the service we already know. */
  providerServiceId: string
  reason: string
  /** What the provider reported and we refused to apply (null when its data could not be read at all). */
  observed: { rate: number; min: number; max: number } | null
}

const INVALID_REASONS = new Set(['invalid rate', 'invalid min', 'invalid max'])

/**
 * Services we already sell whose new data must not be applied:
 *   * the price moved more than MAX_PRICE_CHANGE (30%) up or down from what we have, or
 *   * the provider now reports impossible data (negative / non-numeric price, min <= 0, max < min).
 * New services are not checked here: invalid ones are already dropped by normalizeProviderServices, and a brand-new
 * price has nothing to be compared with.
 */
export function detectCatalogAnomalies(
  existing: ExistingProviderService[],
  valid: IProviderService[],
  skipped: SkippedService[],
  maxChange: number = MAX_PRICE_CHANGE,
): CatalogAnomaly[] {
  const byExt = new Map(existing.map((e) => [e.external_service_id, e]))
  const out: CatalogAnomaly[] = []
  for (const s of valid) {
    const prev = byExt.get(s.externalServiceId)
    if (!prev) continue
    const old = Number(prev.rate_per_1000)
    if (!(old > 0)) continue
    const change = (s.ratePer1000 - old) / old
    // compared in whole basis points, so exactly 30% is not pushed over the limit by float error (1.3 / 1 - 1 = 0.30000000000000004)
    if (Math.abs(Math.round(change * 10_000)) > Math.round(maxChange * 10_000)) {
      out.push({
        externalServiceId: s.externalServiceId,
        providerServiceId: prev.id,
        reason: `price ${change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(change) * 100)}% (${old} -> ${s.ratePer1000} per 1000), above the ${Math.round(maxChange * 100)}% limit`,
        observed: { rate: s.ratePer1000, min: s.minQuantity, max: s.maxQuantity },
      })
    }
  }
  for (const k of skipped) {
    const prev = byExt.get(k.externalServiceId)
    if (prev && INVALID_REASONS.has(k.reason)) {
      out.push({ externalServiceId: k.externalServiceId, providerServiceId: prev.id, reason: `provider reports ${k.reason}`, observed: null })
    }
  }
  return out
}

/**
 * Takes anomalous services out of this sync run: their provider_services row is not overwritten (the bridge trigger
 * would carry the bad price to every offer), they are not re-priced, and they are not treated as "missing" either.
 */
export function withoutAnomalies(diff: ProviderServiceDiff, valid: IProviderService[], anomalies: CatalogAnomaly[]) {
  const ext = new Set(anomalies.map((a) => a.externalServiceId))
  return {
    diff: {
      ...diff,
      rows: diff.rows.filter((r) => !ext.has(r.external_service_id)),
      updated: diff.updated.filter((id) => !ext.has(id)),
      missing: diff.missing.filter((m) => !ext.has(m.external_service_id)),
    },
    valid: valid.filter((s) => !ext.has(s.externalServiceId)),
  }
}

// ---------------------------------------------------------------------------
// Public service planning
// ---------------------------------------------------------------------------

export interface ExistingService {
  id: string
  category_id: string
  name: string
  description: string | null
  primary_provider_service_id: string
  fallback_provider_service_id: string | null
  customer_rate_per_1000: number
  min_quantity: number
  max_quantity: number
  is_active: boolean
  sort_order: number
  refill_supported: boolean
}

export interface ServiceRow {
  id?: string
  category_id: string
  name: string
  description: string | null
  primary_provider_service_id: string
  fallback_provider_service_id: string | null
  customer_rate_per_1000: number
  min_quantity: number
  max_quantity: number
  is_active: boolean
  sort_order: number
  refill_supported: boolean
}

export interface ServicePlan {
  action: 'create' | 'update' | 'none'
  row?: ServiceRow
  repriced: boolean
  reactivated: boolean
}

export interface PlanServiceInput {
  existing?: ExistingService
  providerServiceId: string
  provider: IProviderService
  categoryId: string
  platform: Platform
  rules: PriceRule[]
  /** True when the provider service was inactive and is listed again. */
  providerServiceReactivated: boolean
  minMargin?: number
}

export function planService(input: PlanServiceInput): ServicePlan {
  const { existing, provider: p } = input
  const rate = calculateCustomerRate(
    p.ratePer1000,
    input.rules,
    { serviceId: existing?.id, categoryId: input.categoryId, platform: input.platform },
    { minMargin: input.minMargin },
  )

  if (!existing) {
    return {
      action: 'create',
      repriced: false,
      reactivated: false,
      row: {
        category_id: input.categoryId,
        name: p.name.trim(),
        description: null,
        primary_provider_service_id: input.providerServiceId,
        fallback_provider_service_id: null,
        customer_rate_per_1000: rate,
        min_quantity: p.minQuantity,
        max_quantity: p.maxQuantity,
        is_active: true,
        sort_order: 0,
        refill_supported: p.refillSupported,
      },
    }
  }

  // Keep admin-narrowed limits, but never exceed what the provider can actually deliver.
  let min = Math.max(existing.min_quantity, p.minQuantity)
  let max = Math.min(existing.max_quantity, p.maxQuantity)
  if (min > max) {
    min = p.minQuantity
    max = p.maxQuantity
  }
  const reactivated = input.providerServiceReactivated && !existing.is_active
  const repriced = r4(existing.customer_rate_per_1000) !== r4(rate)

  const changed =
    repriced ||
    reactivated ||
    min !== existing.min_quantity ||
    max !== existing.max_quantity ||
    existing.refill_supported !== p.refillSupported
  if (!changed) return { action: 'none', repriced: false, reactivated: false }

  return {
    action: 'update',
    repriced,
    reactivated,
    row: {
      id: existing.id,
      category_id: existing.category_id,
      name: existing.name,
      description: existing.description,
      primary_provider_service_id: existing.primary_provider_service_id,
      fallback_provider_service_id: existing.fallback_provider_service_id,
      customer_rate_per_1000: rate,
      min_quantity: min,
      max_quantity: max,
      is_active: reactivated ? true : existing.is_active,
      sort_order: existing.sort_order,
      refill_supported: p.refillSupported,
    },
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ProviderSyncReport {
  /** Services held back because of a suspicious price move or impossible data (their offers are suspended). */
  anomalies?: number
  provider: string
  status: 'ok' | 'skipped' | 'failed'
  error?: string
  warning?: string
  added: number
  updated: number
  deactivated: number
  services: { created: number; repriced: number; updated: number; deactivated: number; reactivated: number }
  categoriesCreated: number
  skippedInvalid: number
}

export interface SyncReport {
  added: number
  updated: number
  deactivated: number
  providers: ProviderSyncReport[]
}

export function emptyProviderReport(provider: string): ProviderSyncReport {
  return {
    provider, status: 'ok', added: 0, updated: 0, deactivated: 0,
    services: { created: 0, repriced: 0, updated: 0, deactivated: 0, reactivated: 0 },
    categoriesCreated: 0, skippedInvalid: 0,
  }
}

export function summarize(providers: ProviderSyncReport[]): SyncReport {
  return {
    added: providers.reduce((n, p) => n + p.added, 0),
    updated: providers.reduce((n, p) => n + p.updated, 0),
    deactivated: providers.reduce((n, p) => n + p.deactivated, 0),
    providers,
  }
}
