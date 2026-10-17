// What the variant switches of a service card show: technical duplicates folded away, and on each switch what really sets that variant
// apart from the others of its group (the guarantee, the quality, the speed...), never a made-up grade like "Economy" or "Premium".
import { t } from '@/i18n'
import type { ICatalogService } from '@/types/catalog'
import { reactionOf } from './reactions'
import { localizedName } from './service-view'

/** Tags that only say which of the panel's servers delivers ("[server 2]", "[s3]", "[backup server]"): nothing the customer chooses. */
const TECHNICAL_TAG = /\[(?:(?:server|сервер|s)\s*:?\s*#?\d+|backup server|резервный сервер)\]/gi
const TECHNICAL_PART = /^(?:(?:server|сервер|s)\s*:?\s*#?\d+|backup server|резервный сервер)$/i

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
    // the original name too: a translation may have lost what tells two services apart ("[Ха-ха]" / "[Сочувствую]")
    const key = `${withoutTechnicalTags(v.name)}|${withoutTechnicalTags(v.nameI18n?.ru ?? '')}|${v.ratePer1000}`
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

const fmt = (locale: string, n: number, o: Intl.NumberFormatOptions): string => {
  try {
    return new Intl.NumberFormat(locale, o).format(n)
  } catch {
    return String(n)
  }
}
const compact = (n: number, locale: string) => fmt(locale, n, { notation: 'compact', maximumFractionDigits: 1 })
/** "30 дн." / "30 days": short enough for a switch. */
export const shortDays = (n: number, locale: string) => fmt(locale, n, { style: 'unit', unit: 'day', unitDisplay: 'short', maximumFractionDigits: 0 })

/** The parts of the bracketed tags of a name: "W.TV Views [HQ | 1 Hour]" -> ["HQ", "1 Hour"] (technical server tags left out). */
export function nameTags(name: string): string[] {
  return [...name.matchAll(/\[([^\]]+)\]/g)]
    .flatMap((m) => m[1].split('|'))
    .map((s) => s.trim())
    .filter((s) => s !== '' && !TECHNICAL_PART.test(s))
}

interface Ctx {
  locale: string
  lang: string
  /** Lower-cased name tags shared by every variant of the group (they set nothing apart). */
  common: Set<string>
}

/** One property of a variant, as a short label, or null when the variant does not state it. In the order a customer weighs them. */
type Feature = (v: ICatalogService, ctx: Ctx) => string | null

const FEATURES: Feature[] = [
  // the reaction it delivers ("😆 Haha" / "😡 Angry"): the very thing a reaction group is about
  (v) => {
    const r = reactionOf(v.name, v.nameI18n)
    return r ? `${r.emoji} ${t(r.label)}` : null
  },
  // the guarantee
  (v, { locale }) => {
    const r = v.attributes?.refill
    if (r === 'none') return t('No refill')
    if (r === 'lifetime') return `♻️ ${t('Lifetime')}`
    if (typeof r === 'number') return `♻️ ${shortDays(r, locale)}`
    return null
  },
  // the quality
  (v) => {
    if (v.attributes?.real || /\b(real|живые|реальные)\b/i.test(v.name)) return t('Real')
    if (/\bhq\b|high quality|высокое качество/i.test(v.name)) return 'HQ'
    if (/\bbots?\b|боты/i.test(v.name)) return t('Bots')
    return null
  },
  // drops
  (v) => (v.attributes?.drop === 'none' ? t('No drops') : v.attributes?.drop === 'low' ? t('Low drop') : v.attributes?.drop === 'high' ? t('High drop') : null),
  // speed
  (v, { locale }) => (v.attributes?.speed ? t('{n}/day', { n: compact(v.attributes.speed, locale) }) : null),
  // start
  (v) => (v.attributes?.startMax === 0 ? t('Instant') : null),
  // countries
  (v) => (v.attributes?.geo?.length ? v.attributes.geo.slice(0, 2).join('/') + (v.attributes.geo.length > 2 ? '…' : '') : null),
  // the largest order
  (v, { locale }) => t('up to {n}', { n: compact(v.maxQuantity, locale) }),
  // what is left: a tag of its own name the other variants do not have ("1 Hour" / "2 Hours")
  (v, { lang, common }) => {
    const own = nameTags(localizedName(v.name, v.nameI18n, lang)).find((tag) => !common.has(tag.toLowerCase()))
    return own ? (own.length > 22 ? `${own.slice(0, 21)}…` : own) : null
  },
]

/**
 * The label of each variant's switch (the price is shown under it): the first property in which the variants differ ("No refill",
 * "♻️ 30 days", "♻️ 365 days"); when that leaves two variants alike, a second property that tells them apart ("No refill · 10K/day").
 * At most two properties; a variant that does not state the chosen property gets an empty label (its price still tells it apart).
 */
export function variantDiffLabels(variants: readonly ICatalogService[], lang: string, locale: string): string[] {
  if (variants.length <= 1) return variants.map(() => '')
  const tagSets = variants.map((v) => new Set(nameTags(localizedName(v.name, v.nameI18n, lang)).map((x) => x.toLowerCase())))
  const common = new Set([...tagSets[0]].filter((x) => tagSets.every((s) => s.has(x))))
  const ctx: Ctx = { locale, lang, common }
  const chosen: (string | null)[][] = []
  const labelsSoFar = () => variants.map((_, i) => chosen.map((vals) => vals[i]).filter(Boolean).join(' · '))
  for (const feature of FEATURES) {
    if (chosen.length === 2) break
    const vals = variants.map((v) => feature(v, ctx))
    if (vals.every((x) => x === null) || new Set(vals).size < 2) continue
    if (chosen.length === 0) {
      chosen.push(vals)
      continue
    }
    // a second property only where it tells apart variants the first one left alike, and only on those variants
    const now = labelsSoFar()
    const alike = (i: number) => now.some((m, j) => j !== i && m === now[i])
    const splits = now.some((l, i) => now.some((m, j) => j > i && m === l && vals[i] !== vals[j]))
    if (splits) chosen.push(vals.map((x, i) => (alike(i) ? x : null)))
  }
  return labelsSoFar()
}
