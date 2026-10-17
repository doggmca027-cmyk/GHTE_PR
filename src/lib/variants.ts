// What the variant switches of a service card show: technical duplicates folded away, and a name per switch instead of numbers.
import { tr } from '@/i18n'
import type { ICatalogService } from '@/types/catalog'

/** Tags that only say which of the panel's servers delivers ("[server 2]", "[s3]", "[backup server]"): nothing the customer chooses. */
const TECHNICAL_TAG = /\[(?:(?:server|сервер|s)\s*:?\s*#?\d+|backup server|резервный сервер)\]/gi

/** The name without its technical tags, for comparing variants. */
export const withoutTechnicalTags = (name: string): string => name.replace(TECHNICAL_TAG, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Variants that differ only by a technical tag AND cost the same are one choice for the customer: one of them is kept (the one that
 * takes the widest range of quantities), in the place of the first. Variants that differ in anything else, or in price, all stay.
 */
export function collapseTechnicalDuplicates(variants: readonly ICatalogService[]): ICatalogService[] {
  const best = new Map<string, ICatalogService>()
  const order: string[] = []
  for (const v of variants) {
    const key = `${withoutTechnicalTags(v.name)}|${v.ratePer1000}`
    const kept = best.get(key)
    if (!kept) {
      best.set(key, v)
      order.push(key)
    } else if (v.maxQuantity > kept.maxQuantity || (v.maxQuantity === kept.maxQuantity && v.minQuantity < kept.minQuantity)) {
      best.set(key, v)
    }
  }
  return order.map((k) => best.get(k)!)
}

const ECONOMY = tr('Economy')
const PREMIUM = tr('Premium')
/** Steps between Economy and Premium, in rising order. */
const MIDDLE = [tr('Basic'), tr('Standard'), tr('Optimal'), tr('Advanced'), tr('Pro'), tr('Ultra'), tr('Elite'), tr('Max')]

/**
 * Switch labels (i18n keys), cheapest first: Economy, the steps between, Premium. Never a number: 2 -> Economy / Premium,
 * 3 -> Economy / Standard / Premium, 4 -> Economy / Basic / Standard / Premium ... up to 10 (the largest group the catalogue builds).
 */
export function variantLabels(total: number): string[] {
  if (total <= 1) return [ECONOMY]
  const middle = total - 2
  const steps = middle === 1 ? [MIDDLE[1]] : MIDDLE.slice(0, middle)
  // more steps than names (a group larger than the catalogue builds): the last name repeats rather than a number appearing
  while (steps.length < middle) steps.push(MIDDLE[MIDDLE.length - 1])
  return [ECONOMY, ...steps, PREMIUM]
}
