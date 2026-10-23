// Search among the services of a platform or a category: by the words of the service (its English name, its original Russian name,
// its description) and by the COUNTRY the service targets.
//
// A query is split into words. A run of words that is a country's name ("germany", "united states", "сша", "deutschland") becomes a
// country term: it matches a service whose structured `attributes.geo` holds that country OR whose name says the country. Every
// other word is a plain term. ALL terms must match (the more words, the narrower the result).
//
// The same terms are used twice: as a PostgREST filter (serviceSearchFilter) so the database does the work over the whole catalogue,
// and as a function (serviceMatches) for the offline mock catalogue and for tests, so the two cannot drift apart.
import { normalizeQuery } from '@/lib/platform-search'

export interface SearchTerm {
  /** Normalised text looked for in the names and the description. */
  text: string
  /** ISO codes when the text is a country: the service's `geo` is checked for them too. */
  geo: string[]
}

export const MAX_TERMS = 5
const MAX_WORD = 40

/** Short and informal names that Intl's formal names do not contain. Already normalised (lower case, "е" for "ё"). */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  usa: 'US', us: 'US', america: 'US', сша: 'US', америка: 'US', 'u s a': 'US', штаты: 'US',
  uk: 'GB', england: 'GB', britain: 'GB', 'great britain': 'GB', англия: 'GB', британия: 'GB', великобритания: 'GB',
  uae: 'AE', эмираты: 'AE', оаэ: 'AE', dubai: 'AE', дубай: 'AE',
  korea: 'KR', корея: 'KR', holland: 'NL', голландия: 'NL', россия: 'RU', russia: 'RU', рф: 'RU',
  czechia: 'CZ', турция: 'TR', turkey: 'TR', turkiye: 'TR', ukraine: 'UA', украина: 'UA', belarus: 'BY', беларусь: 'BY', белоруссия: 'BY',
  kazakhstan: 'KZ', казахстан: 'KZ', uzbekistan: 'UZ', узбекистан: 'UZ',
}

const REGION_LOCALES = ['en', 'ru', 'uk', 'es', 'pt', 'de', 'fr', 'it', 'tr', 'id']
const FIRST = 'A'.charCodeAt(0)

let index: Map<string, string[]> | null = null

/** Country name (in ten languages) -> ISO code(s). Built once, from the browser's own data: nothing is shipped for it. */
function countryIndex(): Map<string, string[]> {
  if (index) return index
  const map = new Map<string, string[]>()
  const add = (name: string, iso: string) => {
    const key = normalizeQuery(name)
    if (key.length < 2) return
    const list = map.get(key)
    if (!list) map.set(key, [iso])
    else if (!list.includes(iso)) list.push(iso)
  }
  for (const locale of REGION_LOCALES) {
    let names: Intl.DisplayNames
    try { names = new Intl.DisplayNames([locale], { type: 'region' }) } catch { continue }
    for (let a = 0; a < 26; a++) {
      for (let b = 0; b < 26; b++) {
        const iso = String.fromCharCode(FIRST + a, FIRST + b)
        let name: string | undefined
        try { name = names.of(iso) } catch { name = undefined }
        if (name && name !== iso) add(name, iso)
      }
    }
  }
  for (const [alias, iso] of Object.entries(COUNTRY_ALIASES)) add(alias, iso)
  index = map
  return map
}

/** The country codes a name or a phrase stands for, or [] when it is not a country. */
export function countryCodes(text: string): string[] {
  return countryIndex().get(normalizeQuery(text)) ?? []
}

/**
 * Lower case, punctuation -> spaces, "ё" folded to "е". Unlike normalizeQuery, letters keep their marks: the database compares the
 * names as they are written, and stripping the breve turned "дней" into "днеи", which no name contains.
 */
function searchText(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}.]+/gu, ' ').trim()
}

/** Words -> terms. Up to three words in a row are tried as a country first ("south korea"), so they stay together. */
export function parseServiceQuery(raw: string): SearchTerm[] {
  const words = searchText(raw).split(' ').filter(Boolean).map((w) => w.slice(0, MAX_WORD))
  const terms: SearchTerm[] = []
  for (let i = 0; i < words.length && terms.length < MAX_TERMS;) {
    let taken = 0
    for (let n = Math.min(3, words.length - i); n >= 1 && taken === 0; n--) {
      const phrase = words.slice(i, i + n).join(' ')
      const geo = countryCodes(phrase)
      // a one-letter or two-letter word is a country only when it is an alias ("us", "uk"): "de" or "in" are far more often words
      if (geo.length > 0 && (phrase.length > 2 || phrase in COUNTRY_ALIASES)) {
        terms.push({ text: phrase, geo })
        taken = n
      }
    }
    if (taken === 0) { terms.push({ text: words[i]!, geo: [] }); taken = 1 }
    i += taken
  }
  return terms
}

/**
 * The value of PostgREST's `and=` parameter for these terms, or null when there is nothing to search for.
 * Terms only hold letters, digits, spaces and dots (searchText), so they cannot break the filter's syntax. An "е" becomes the
 * one-character wildcard `_`, so it also finds a name written with "ё" ("дешево" finds "дёшево").
 */
export function serviceSearchFilter(terms: readonly SearchTerm[]): string | null {
  if (terms.length === 0) return null
  const groups = terms.map((term) => {
    const like = `*${term.text.replace(/е/g, '_')}*`
    const parts = [`name.ilike.${like}`, `name_i18n->>ru.ilike.${like}`, `description.ilike.${like}`]
    for (const iso of term.geo) parts.push(`attributes->>geo.ilike.*"${iso}"*`)
    return `or(${parts.join(',')})`
  })
  return `(${groups.join(',')})`
}

interface Searchable {
  name: string
  description: string | null
  nameI18n?: Record<string, string>
  attributes?: { geo?: string[] }
}

const has = (haystack: string | null | undefined, needle: string) => !!haystack && searchText(haystack).includes(needle)

/** The same decision the filter makes, in memory. */
export function serviceMatches(service: Searchable, terms: readonly SearchTerm[]): boolean {
  return terms.every((term) =>
    has(service.name, term.text) || has(service.nameI18n?.ru, term.text) || has(service.description, term.text) ||
    term.geo.some((iso) => service.attributes?.geo?.includes(iso)))
}
