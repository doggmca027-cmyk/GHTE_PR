// How a service and its category are shown: the name in the customer's language, and a description built from the service's FACTS
// (refill, start time, speed, drops, countries). The facts are language-free, so the description is available in all 15 languages
// without translating any text of the provider's.
import { t } from '@/i18n'
import type { ServiceAttributes } from '@/types/catalog'

// Names the panel wrote in Russian are kept as name_i18n.ru. Russian and Ukrainian readers get that one; everybody else the English.
const RUSSIAN_READERS = new Set(['ru', 'uk'])

/** The name to show: the original Russian for ru / uk when there is one, the English name otherwise. */
export function localizedName(name: string, nameI18n: Record<string, string> | undefined, lang: string): string {
  const original = nameI18n?.ru
  return RUSSIAN_READERS.has(lang) && original ? original : name
}

function unit(n: number, u: 'day' | 'hour' | 'minute', locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'long', maximumFractionDigits: 1 }).format(n)
  } catch {
    return `${n} ${u}${n === 1 ? '' : 's'}`
  }
}

const compact = (n: number, locale: string): string => {
  try {
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  } catch {
    return String(n)
  }
}

function duration(minutes: number, locale: string): string {
  if (minutes < 60) return unit(Math.max(1, minutes), 'minute', locale)
  if (minutes < 60 * 48) return unit(Math.round(minutes / 60), 'hour', locale)
  return unit(Math.round(minutes / 1440), 'day', locale)
}

function countries(codes: string[], locale: string): string {
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region' })
    const shown = codes.slice(0, 6).map((c) => names.of(c) ?? c)
    return codes.length > 6 ? `${shown.join(', ')}…` : shown.join(', ')
  } catch {
    return codes.join(', ')
  }
}

/** One short line per fact the service states. Empty when the panel gave no facts. */
export function describeService(a: ServiceAttributes | undefined, locale: string): string[] {
  if (!a) return []
  const lines: string[] = []
  if (a.refill === 'none') lines.push(t('No refill guarantee'))
  else if (a.refill === 'lifetime') lines.push(t('Lifetime refill guarantee'))
  else if (typeof a.refill === 'number') lines.push(t('Refill guarantee: {time}', { time: unit(a.refill, 'day', locale) }))
  if (a.startMax !== undefined) lines.push(a.startMax === 0 ? t('Starts instantly') : t('Starts within {time}', { time: duration(a.startMax, locale) }))
  if (a.speed !== undefined) lines.push(t('Speed: up to {n} per day', { n: compact(a.speed, locale) }))
  if (a.drop === 'none') lines.push(t('No drops'))
  else if (a.drop === 'low') lines.push(t('Low drop rate'))
  else if (a.drop === 'high') lines.push(t('High drop rate'))
  if (a.real) lines.push(t('Real accounts'))
  if (a.geo && a.geo.length > 0) lines.push(t('Countries: {list}', { list: countries(a.geo, locale) }))
  return lines
}
