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

export type FactKind = 'refill' | 'start' | 'speed' | 'drop' | 'real' | 'geo'

export interface ServiceFact {
  kind: FactKind
  text: string
}

/** One short line per fact the service states, with the kind of fact (the screen picks an icon for it). Empty when there are none. */
export function describeServiceFacts(a: ServiceAttributes | undefined, locale: string): ServiceFact[] {
  if (!a) return []
  const facts: ServiceFact[] = []
  const add = (kind: FactKind, text: string) => facts.push({ kind, text })
  if (a.refill === 'none') add('refill', t('No refill guarantee'))
  else if (a.refill === 'lifetime') add('refill', t('Lifetime refill guarantee'))
  else if (typeof a.refill === 'number') add('refill', t('Refill guarantee: {time}', { time: unit(a.refill, 'day', locale) }))
  if (a.startMax !== undefined) add('start', a.startMax === 0 ? t('Starts instantly') : t('Starts within {time}', { time: duration(a.startMax, locale) }))
  if (a.speed !== undefined) add('speed', t('Speed: up to {n} per day', { n: compact(a.speed, locale) }))
  if (a.drop === 'none') add('drop', t('No drops'))
  else if (a.drop === 'low') add('drop', t('Low drop rate'))
  else if (a.drop === 'high') add('drop', t('High drop rate'))
  if (a.real) add('real', t('Real accounts'))
  if (a.geo && a.geo.length > 0) add('geo', t('Countries: {list}', { list: countries(a.geo, locale) }))
  return facts
}

/** The same facts as plain lines. */
export function describeService(a: ServiceAttributes | undefined, locale: string): string[] {
  return describeServiceFacts(a, locale).map((f) => f.text)
}

export type DetailKind = 'refill' | 'guarantee' | 'start' | 'speed' | 'quality' | 'geo'

export interface ServiceDetail {
  kind: DetailKind
  /** A full sentence: the label, the value and what it means for the customer. */
  text: string
}

/**
 * The description a customer reads before ordering: one explained row per fact, in the order the panels themselves use (recovery,
 * guarantee, start time, speed, quality, countries). Only facts the service states are listed, nothing is assumed.
 */
export function describeServiceDetails(a: ServiceAttributes | undefined, locale: string): ServiceDetail[] {
  if (!a) return []
  const rows: ServiceDetail[] = []
  const add = (kind: DetailKind, text: string) => rows.push({ kind, text })
  if (a.refill === 'none') {
    add('refill', t('Recovery: none — the amount is not restored after completion.'))
    add('guarantee', t('Guarantee: no'))
  } else if (a.refill === 'lifetime') {
    add('refill', t('Recovery: lifetime — if the amount drops after completion, it is restored automatically. If the automatic recovery did not work, create a support ticket with the order number and we will do it manually.'))
    add('guarantee', t('Guarantee: yes — lifetime'))
  } else if (typeof a.refill === 'number') {
    const time = unit(a.refill, 'day', locale)
    add('refill', t('Recovery: {time} — if the amount drops after completion, it is restored automatically within this period; after it there is no guarantee. If the automatic recovery did not work, create a support ticket with the order number and we will do it manually.', { time }))
    add('guarantee', t('Guarantee: yes — against drops within {time}', { time }))
  }
  if (a.startMax !== undefined) {
    add('start', a.startMax === 0
      ? t('Start time: instant — this is an approximate time; if the order has not started within a reasonable time, create a support ticket with the order ID.')
      : t('Start time: up to {time} — this is an approximate time; if the order has not started within a reasonable time, create a support ticket with the order ID.', { time: duration(a.startMax, locale) }))
  }
  if (a.speed !== undefined) {
    add('speed', t('Average speed: up to {n} per day — this is an average value; the actual speed may vary with the server load at the time of the order.', { n: compact(a.speed, locale) }))
  }
  const quality: string[] = []
  if (a.real) quality.push(t('Real accounts'))
  if (a.drop === 'none') quality.push(t('No drops'))
  else if (a.drop === 'low') quality.push(t('Low drop rate'))
  else if (a.drop === 'high') quality.push(t('High drop rate'))
  if (quality.length > 0) add('quality', t('Quality: {text}', { text: quality.join(', ') }))
  if (a.geo && a.geo.length > 0) add('geo', t('Countries: {list}', { list: countries(a.geo, locale) }))
  return rows
}

/** The countries a service targets, for a short badge: the first few names, "…" when there are more. Empty when it has none. */
export function serviceCountries(a: ServiceAttributes | undefined, locale: string, max = 2): string {
  const geo = a?.geo
  if (!geo || geo.length === 0) return ''
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region' })
    const shown = geo.slice(0, max).map((c) => names.of(c) ?? c)
    return geo.length > max ? shown.join(', ') + '…' : shown.join(', ')
  } catch {
    return geo.slice(0, max).join(', ')
  }
}
