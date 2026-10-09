// Turns a panel's service name (Russian, decorated with emoji and [tags]) into what the storefront shows:
//   * an English name (the original is kept as name_ru),
//   * structured attributes (refill, start time, speed, countries, drops, real users) that the app describes in the customer's own
//     language, so the description does not need translating text: it is built from facts.
// Pure: no I/O. The glossary is service-glossary.ts; scripts/catalog-coverage.ts measures it on a saved copy of the real catalogue.

import { COUNTRIES, PHRASES } from './service-glossary.ts'

const compiled = PHRASES.map(([pattern, english]) => [new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}])`, 'giu'), english] as const)

const countryNames = Object.keys(COUNTRIES).sort((a, b) => b.length - a.length)
const countryRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${countryNames.map((c) => c.replace(/[-\s]/g, '[-\\s]')).join('|')})(?![\\p{L}])`, 'giu')

let regionNames: Intl.DisplayNames | null = null
const countryName = (iso: string): string => {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regionNames.of(iso) ?? iso
  } catch {
    return iso
  }
}

const DECOR = /[\p{Extended_Pictographic}️‍\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}♨♛♀♂=]+/gu
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/gu

export const hasCyrillic = (s: string): boolean => /[а-яё]/i.test(s)

/** Emoji and decoration removed, whitespace collapsed. */
export const stripDecor = (s: string): string => s.replace(DECOR, ' ').replace(/\s+/g, ' ').replace(/\[\s+/g, '[').replace(/\s+\]/g, ']').trim()

/** ISO codes of the flag emoji in a text: "🇺🇸 США" -> ["US"]. */
export function flagCodes(s: string): string[] {
  const out: string[] = []
  for (const f of s.match(FLAG) ?? []) {
    const [a, b] = [...f].map((c) => String.fromCodePoint(c.codePointAt(0)! - 0x1f1e6 + 65))
    out.push(a + b)
  }
  return out
}

/** Russian -> English by the glossary. Latin text and numbers pass through; leftover Cyrillic means "not fully translated". */
const cache = new Map<string, string>()

export function translateText(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const out = translateUncached(text)
  if (cache.size > 50_000) cache.clear()
  cache.set(text, out)
  return out
}

function translateUncached(text: string): string {
  let s = stripDecor(text)
  s = s.replace(countryRe, (m) => {
    const iso = COUNTRIES[m.toLowerCase().replace(/[-\s]+/g, ' ')] ?? COUNTRIES[m.toLowerCase()]
    return iso ? countryName(iso) : m
  })
  for (const [re, en] of compiled) s = s.replace(re, en)
  return s.replace(/\s+([,.:;)\]])/g, '$1').replace(/([(\[])\s+/g, '$1').replace(/\s+/g, ' ').trim()
}

const SMALL = new Set(['and', 'of', 'for', 'from', 'in', 'on', 'to', 'with', 'by', 'per', 'via', 'or', 'the', 'a', 'an'])

/** "post views from ads" -> "Post Views from Ads"; words that already have capitals (TikTok, SEO, AI) are left alone. */
export function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w, i) => {
      if (/[A-Z]/.test(w) || /^[^a-z]/.test(w)) return w
      return i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')
}

export interface ParsedName {
  /** Everything outside the [brackets], decoration removed. */
  titleRu: string
  /** The bracket groups, decoration removed, empty ones dropped. */
  tagsRu: string[]
}

export function parseServiceName(raw: string): ParsedName {
  const tags = (raw.match(/\[[^\]]*\]/g) ?? []).map((t) => t.slice(1, -1))
  const titleRu = stripDecor(raw.replace(/\[[^\]]*\]/g, ' '))
  return { titleRu, tagsRu: tags.filter((t) => stripDecor(t).replace(/[^\p{L}\p{N}]/gu, '') !== '' || flagCodes(t).length > 0) }
}

// ---------------------------------------------------------------------------
// Structured attributes
// ---------------------------------------------------------------------------

export interface ServiceAttributes {
  /** 'none' | 'lifetime' | the number of days. */
  refill?: 'none' | 'lifetime' | number
  /** Start time in minutes: the range the panel promises (0..0 is instant). */
  startMin?: number
  startMax?: number
  /** Delivery speed, units per day (the top of the range). */
  speed?: number
  /** ISO country codes the service targets. */
  geo?: string[]
  drop?: 'none' | 'low' | 'high'
  real?: boolean
}

const num = (s: string) => Number(s.replace(',', '.'))
const scale = (n: number, unit?: string) => (unit && /^тыс/i.test(unit) ? n * 1_000 : unit && /^млн/i.test(unit) ? n * 1_000_000 : n)

export function extractAttributes(tagsRu: string[]): ServiceAttributes {
  const a: ServiceAttributes = {}
  const geo = new Set<string>()
  for (const raw of tagsRu) {
    const t = stripDecor(raw).toLowerCase().replace(/ё/g, 'е')
    for (const code of flagCodes(raw)) geo.add(code)
    const country = COUNTRIES[t]
    if (country) geo.add(country)

    if (a.refill === undefined) {
      if (/^без восстановления/.test(t)) a.refill = 'none'
      else if (/восстановление:?\s*пожизненно/.test(t) || /восстановления:?.*пожизненн/.test(t)) a.refill = 'lifetime'
      else {
        const m = /восстановление:?\s*(?:\d+\s*-\s*)?(\d+)\s*(?:дн|день|дня)/.exec(t)
        if (m) a.refill = Number(m[1])
      }
    }
    if (a.startMax === undefined) {
      const m = /^время старта:?\s*(.*)$/.exec(t)
      if (m) {
        const v = m[1]
        if (/^(мгновенно|супермгновенно|сверхбыстро)/.test(v)) { a.startMin = 0; a.startMax = 0 }
        else {
          const r = /^(?:до\s*)?(\d+)(?:\s*-\s*(\d+))?\s*(час|мин)/.exec(v)
          if (r) {
            const k = r[3] === 'час' ? 60 : 1
            a.startMin = r[2] ? Number(r[1]) * k : /^до/.test(v) ? 0 : Number(r[1]) * k
            a.startMax = Number(r[2] ?? r[1]) * k
          }
        }
      }
    }
    if (a.speed === undefined) {
      const m = /^скорость:?\s*(?:до\s*|~)?(\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?\+?\s*(тыс\.?|млн)?\s*\/\s*(день|час)/.exec(t)
      if (m) a.speed = Math.round(scale(num(m[2] ?? m[1]), m[3]) * (m[4] === 'час' ? 24 : 1))
    }
    if (a.drop === undefined) {
      if (/^без списаний$/.test(t)) a.drop = 'none'
      else if (/высокие списания/.test(t)) a.drop = 'high'
      else if (/(низкий риск списаний|низкие списания|меньше списаний|списания:?\s*(очень )?низкие)/.test(t)) a.drop = 'low'
    }
    if (/реальн/.test(t)) a.real = true
  }
  if (geo.size > 0) a.geo = [...geo].sort()
  return a
}

// ---------------------------------------------------------------------------
// A whole service / category
// ---------------------------------------------------------------------------

export interface TranslatedService {
  /** English name; when the title could not be translated, the original. */
  name: string
  nameRu: string
  attributes: ServiceAttributes
  /** True when no Cyrillic is left in the English title (a dropped untranslated tag does not count against it). */
  translated: boolean
}

/** Moves the platform's own name to the front: "post views Telegram" -> "Telegram post views". */
export function brandFirst(title: string, brands: readonly string[]): string {
  for (const b of brands) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')
    const m = re.exec(title)
    if (!m) continue
    if (m.index === 0) return title
    const rest = (title.slice(0, m.index) + ' ' + title.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    return `${m[0]} ${rest}`.trim()
  }
  return title
}

/** Plural-sensitive details the glossary cannot know: subscribers on YouTube and Telegram, followers elsewhere. */
function platformWords(title: string, platformSlug: string): string {
  return platformSlug === 'youtube' || platformSlug === 'telegram' ? title.replace(/\bfollowers\b/gi, (m) => (m[0] === 'F' ? 'Subscribers' : 'subscribers')) : title
}

export function translateService(raw: string, opts: { platformSlug: string; brands: readonly string[] }): TranslatedService {
  const { titleRu, tagsRu } = parseServiceName(raw)
  const titleEn = platformWords(titleCase(brandFirst(translateText(titleRu), opts.brands)), opts.platformSlug)
  const translated = !hasCyrillic(titleEn)
  const tags = [...new Set(tagsRu.map((t) => translateText(t)).filter((t) => t !== '' && !hasCyrillic(t)))]
  const nameRu = [titleRu, ...tagsRu.map(stripDecor)].filter(Boolean).map((p, i) => (i === 0 ? p : `[${p}]`)).join(' ').replace(/\] \[/g, '] [')
  const name = translated ? [titleEn, ...tags.map((t) => `[${t}]`)].join(' ') : nameRu
  return { name: name.slice(0, 240), nameRu: nameRu.slice(0, 240), attributes: extractAttributes(tagsRu), translated }
}

export interface TranslatedCategory {
  name: string
  nameRu: string
  translated: boolean
}

export function translateCategory(raw: string, opts: { brands: readonly string[]; platformSlug?: string }): TranslatedCategory {
  const nameRu = stripDecor(raw)
  const { titleRu, tagsRu } = parseServiceName(raw)
  const title = platformWords(titleCase(brandFirst(translateText(titleRu), opts.brands)), opts.platformSlug ?? '')
  const tags = tagsRu.map((t) => translateText(t)).filter((t) => t !== '')
  const en = [title, ...tags.map((t) => `[${t}]`)].join(' ').trim()
  const translated = !hasCyrillic(en)
  return { name: (translated ? en : nameRu).slice(0, 120), nameRu: nameRu.slice(0, 120), translated }
}
