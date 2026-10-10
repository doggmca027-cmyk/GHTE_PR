import type { PriceContext, PriceOptions, PriceRule } from './types.ts'

// All arithmetic is done with BigInt on fixed-point integers, so results never
// carry binary floating-point artifacts (0.1 + 0.2 style errors).
const SCALE = 8 // provider rates / margins / fixed markups: 1e-8 units
const PERCENT_SCALE = 4 // percent markups: P / 10000 of the rate (value has 2 decimals => value * 100 / 10000)
/** Anti-loss floor: the price is never below cost + this, whatever the rules say (covers gateway / network fees on tiny orders). */
export const DEFAULT_MIN_MARGIN = 0.02

function toFixedPoint(n: number, decimals: number): bigint {
  if (!Number.isFinite(n)) throw new RangeError(`Not a finite number: ${n}`)
  const [int, frac = ''] = n.toFixed(decimals).split('.')
  return BigInt(int + frac)
}

function ceilDiv(num: bigint, den: bigint): bigint {
  return num <= 0n ? 0n : (num + den - 1n) / den
}

const hasKeywords = (rule: PriceRule): boolean => (rule.name_all?.length ?? 0) > 0 || (rule.name_any?.length ?? 0) > 0

/** service > category > keywords (within a platform or global) > platform > global. An explicit admin scope beats an automatic keyword rule. */
function specificity(rule: PriceRule): number {
  if (rule.service_id) return 4
  if (rule.category_id) return 3
  if (hasKeywords(rule)) return 2
  if (rule.platform) return 1
  return 0
}

const phraseCache = new Map<string, RegExp>()

/** Whole-word, case-insensitive phrase test: letters and digits on either side disqualify ("0% drop" is not inside "10% drop"). */
function containsPhrase(haystack: string, phrase: string): boolean {
  let re = phraseCache.get(phrase)
  if (!re) {
    const body = phrase.trim().toLowerCase().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u')
    phraseCache.set(phrase, re)
  }
  return re.test(haystack)
}

function keywordsMatch(rule: PriceRule, name: string | undefined): boolean {
  if (!hasKeywords(rule)) return true
  if (!name) return false
  const text = name.toLowerCase()
  const all = (rule.name_all ?? []).filter((p) => p.trim() !== '')
  const any = (rule.name_any ?? []).filter((p) => p.trim() !== '')
  return all.every((p) => containsPhrase(text, p)) && (any.length === 0 || any.some((p) => containsPhrase(text, p)))
}

function matches(rule: PriceRule, rate: number, ctx: PriceContext): boolean {
  if (rule.is_active === false) return false
  if (rule.service_id && rule.service_id !== ctx.serviceId) return false
  if (rule.category_id && rule.category_id !== ctx.categoryId) return false
  if (rule.platform && rule.platform !== ctx.platform) return false
  if (!keywordsMatch(rule, ctx.serviceName)) return false
  if (rule.type === 'tier') {
    if (rule.min_rate == null || rate < rule.min_rate) return false
    if (rule.max_rate != null && rate > rule.max_rate) return false
  }
  return true
}

/**
 * Picks the winning rule: most specific scope first (service > category >
 * keywords > platform > global), then highest `priority`, then lowest `id` for determinism.
 * Rules whose scope or tier range does not match are ignored, so a tier that
 * misses falls through to the next-most-specific rule.
 */
export function selectPriceRule(
  providerRate: number,
  rules: PriceRule[],
  context: PriceContext = {},
): PriceRule | null {
  let best: PriceRule | null = null
  for (const rule of rules) {
    if (!matches(rule, providerRate, context)) continue
    if (
      best === null ||
      specificity(rule) > specificity(best) ||
      (specificity(rule) === specificity(best) &&
        (rule.priority > best.priority || (rule.priority === best.priority && rule.id < best.id)))
    ) {
      best = rule
    }
  }
  return best
}

/**
 * Customer rate per 1000 units for a given provider rate.
 *
 * - percentage: rate * (1 + value/100)
 * - fixed:      rate + value
 * - tier:       percentage markup, only inside [min_rate, max_rate]
 * - no rule:    rate (then the margin floor applies)
 * The result is never below providerRate + minMargin, and is rounded UP to 4 decimals.
 */
export function calculateCustomerRate(
  providerRate: number,
  rules: PriceRule[],
  context: PriceContext = {},
  options: PriceOptions = {},
): number {
  if (!Number.isFinite(providerRate) || providerRate < 0) {
    throw new RangeError(`providerRate must be a non-negative finite number, got ${providerRate}`)
  }
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN
  if (!Number.isFinite(minMargin) || minMargin < 0) {
    throw new RangeError(`minMargin must be a non-negative finite number, got ${minMargin}`)
  }

  const rate = toFixedPoint(providerRate, SCALE)
  const rule = selectPriceRule(providerRate, rules, context)

  // Candidate price as a rational number: candidateNum / PERCENT_DEN (units of 1e-8).
  const PERCENT_DEN = 10n ** BigInt(PERCENT_SCALE)
  let candidateNum = rate * PERCENT_DEN
  if (rule) {
    if (!Number.isFinite(rule.value) || rule.value < 0) {
      throw new RangeError(`Rule ${rule.id} has an invalid value: ${rule.value}`)
    }
    if (rule.type === 'fixed') {
      candidateNum = (rate + toFixedPoint(rule.value, SCALE)) * PERCENT_DEN
    } else {
      // percentage / tier: value has 2 decimals -> hundredths of a percent
      const hundredths = toFixedPoint(rule.value, 2)
      candidateNum = rate * (PERCENT_DEN + hundredths)
    }
  }

  const floorNum = (rate + toFixedPoint(minMargin, SCALE)) * PERCENT_DEN
  const finalNum = candidateNum > floorNum ? candidateNum : floorNum

  // Round up to 4 decimals: 1e-4 = 1e4 units of 1e-8.
  const units4 = ceilDiv(finalNum, PERCENT_DEN * 10n ** BigInt(SCALE - 4))
  return Number(units4) / 10_000
}
