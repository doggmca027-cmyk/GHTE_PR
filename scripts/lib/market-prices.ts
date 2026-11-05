// The pure parts of scripts/parse-tiktok-yt-prices.ts (tested in tests/market-prices.test.ts): reading the public price lists of retail competitors, telling what a
// line sells (platform, kind of product, our Standard / Premium level, modifiers such as country or watch-time), and the median per product across competitors.
// Keep to erasable syntax: the script runs without a build step. No network here.
import { isPremiumCard } from '../../supabase/functions/_shared/offer-quality.ts'

export type Currency = 'USD' | 'RUB' | 'UAH' | 'EUR' | 'INR'
/** cis: retail panels and storefronts of Russia, Ukraine and the CIS (the owner's reference); panel: open international panels (close to wholesale). */
export type Plane = 'cis' | 'panel'
export type Platform = 'tiktok' | 'youtube'
export type Level = 'standard' | 'premium'

/** One line of a competitor's list: the price is per 1000 units, in `currency`. */
export interface RawRow { source: string; plane: Plane; category: string; name: string; price: number; currency: Currency; min: number | null; max: number | null; id: string | null }

// ---- text and numbers ------------------------------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', dollar: '$' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

export const stripTags = (html: string): string => decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/[\s  ]+/g, ' ').trim()

/** "1 000", "24,00", "0.0010", "1,500", "1.000.000" -> a number; null when it is not one. A single comma followed by 1-2 digits, or a lone dot, is decimal. */
export function parseNumber(text: string): number | null {
  const t = text.replace(/[\s  ]/g, '')
  if (!/^\d[\d.,]*$/.test(t)) return null
  const dot = t.lastIndexOf('.')
  const comma = t.lastIndexOf(',')
  let s = t
  if (dot >= 0 && comma >= 0) s = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.')
  else if (comma >= 0) s = /^[1-9]\d{0,2}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.')
  else if (dot >= 0 && /^[1-9]\d{0,2}(\.\d{3}){2,}$/.test(t)) s = t.replace(/\./g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const SYMBOLS: Record<string, Currency> = { $: 'USD', '€': 'EUR', '₹': 'INR', '₽': 'RUB', '₴': 'UAH' }
const WORDS: Record<string, Currency> = { usd: 'USD', rub: 'RUB', руб: 'RUB', uah: 'UAH', грн: 'UAH', eur: 'EUR', inr: 'INR' }

/** "$0.70", "40000,00 ₽", "115 грн", "0.5" -> { value, currency } (currency null when the cell has only a number). */
export function parsePrice(raw: string): { value: number; currency: Currency | null } | null {
  const t = stripTags(raw)
  let m = /([$€₹₽₴])\s*(\d[\d\s.,]*)/.exec(t)
  if (m) { const v = parseNumber(m[2]!); return v === null ? null : { value: v, currency: SYMBOLS[m[1]!]! } }
  m = /(\d[\d\s.,]*?)\s*([$€₹₽₴]|грн|руб|usd|rub|uah|eur|inr)(?![a-zа-я])/i.exec(t)
  if (m) { const v = parseNumber(m[1]!); const c = SYMBOLS[m[2]!] ?? WORDS[m[2]!.toLowerCase()]; return v === null || !c ? null : { value: v, currency: c } }
  m = /^(\d[\d\s.,]*)$/.exec(t)
  if (m) { const v = parseNumber(m[1]!); return v === null ? null : { value: v, currency: null } }
  return null
}

// ---- the lists of the competitors ------------------------------------------------------------------------------------------------------------------

/**
 * The common "Perfect Panel" list (Followiz, SMMKings, SMMStone, SMMWiz, SMMCost, Soc-Proof, SMMLavka, SMMMain, BulkMedya ...): a row of the table per service,
 * `data-filter-table-service-id` on the id cell, `data-filter-table-service-name` on the name cell, then the price per 1000, the minimum and the maximum order;
 * a row without a service id is the heading of a category.
 */
export function parsePerfectPanel(html: string, source: string, plane: Plane, fallback: Currency): RawRow[] {
  const rows: RawRow[] = []
  const categories = new Map<string, string>()
  for (const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const attrs = m[1]!
    const inner = m[2]!
    const category = /data-filter-table-category-id="([^"]*)"/.exec(attrs)?.[1] ?? ''
    if (!/data-filter-table-service-id/.test(inner) && !/data-filter-table-service-id/.test(attrs)) {
      if (category) categories.set(category, stripTags(inner))
      continue
    }
    const tds = [...inner.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map((t) => ({ attrs: t[1]!, text: stripTags(t[2]!) }))
    const nameAt = tds.findIndex((t) => /data-filter-table-service-name/.test(t.attrs))
    if (nameAt < 0) continue
    let priceAt = -1
    for (let i = nameAt + 1; i < Math.min(tds.length, nameAt + 4); i++) { if (parsePrice(tds[i]!.text)?.currency) { priceAt = i; break } }
    if (priceAt < 0) priceAt = nameAt + 1
    const price = tds[priceAt] ? parsePrice(tds[priceAt]!.text) : null
    if (!price || price.value <= 0) continue
    const min = tds[priceAt + 1] ? parseNumber(tds[priceAt + 1]!.text) : null
    const max = tds[priceAt + 2] ? parseNumber(tds[priceAt + 2]!.text) : null
    rows.push({ source, plane, category: categories.get(category) ?? '', name: tds[nameAt]!.text, price: price.value, currency: price.currency ?? fallback, min, max, id: tds[0]?.text.replace(/\D/g, '') || null })
  }
  return rows
}

/** SMMPrime: a div per service with data-sp-* attributes (rate per 1000 in roubles). */
export function parseSmmPrime(html: string, source: string, plane: Plane, currency: Currency): RawRow[] {
  const rows: RawRow[] = []
  for (const m of html.matchAll(/<div\b[^>]*\bclass="[^"]*\bsp-service-row\b[^"]*"[^>]*>/gi)) {
    const a: Record<string, string> = {}
    for (const x of m[0].matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) a[x[1]!] = decodeEntities(x[2]!)
    const rate = parseNumber(a['sp-rate'] ?? '')
    if (rate === null || rate <= 0 || !a['sp-name']) continue
    rows.push({ source, plane, category: a['category'] ?? '', name: a['sp-name'].replace(/^\d+\.\s*/, ''), price: rate, currency, min: parseNumber(a['sp-min'] ?? ''), max: parseNumber(a['sp-max'] ?? ''), id: a['sp-service-id'] ?? null })
  }
  return rows
}

/**
 * SMMLEVEL (smmlevel.com.ua): a page per product with ONE price, "Мінімальна кількість: 250 — 30 000 115 грн за 250 шт" (the price of the smallest pack), and
 * the promise "Гарантія від списань" (guarantee against drops) on every page, which is why its rows are read as Premium.
 */
export function parseSmmLevel(html: string, slug: string): RawRow[] {
  const text = stripTags(html)
  const m = /Мінімальна кількість:\s*(\d[\d\s]*?)\s*[—–-]\s*(\d[\d\s]*?)\s*грн\s+за\s+(\d[\d\s]*?)\s*шт/i.exec(text)
  if (!m) return []
  // "30 000 115": the maximum order and the price run together; the groups of three digits that follow the first one belong to the maximum while one group is left for the price
  const tail = m[2]!.trim().split(/\s+/)
  let at = 1
  while (at < tail.length - 1 && /^\d{3}$/.test(tail[at]!)) at++
  const [min, max, price, qty] = [parseNumber(m[1]!), parseNumber(tail.slice(0, at).join('')), parseNumber(tail.slice(at).join('')), parseNumber(m[3]!)]
  if (price === null || qty === null || qty <= 0 || price <= 0) return []
  const h1 = stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '')
  const guarantee = /Гарантія від списань/i.test(text) ? ' [guarantee]' : ''
  return [{ source: 'smmlevel', plane: 'cis', category: slug, name: `${h1} (${slug})${guarantee}`, price: (price / qty) * 1000, currency: 'UAH', min, max, id: slug }]
}

// ---- what a line sells ---------------------------------------------------------------------------------------------------------------------------------

const SMALL_CAPS: Record<string, string> = { ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ǫ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z' }
/** Fancy letters (small caps, mathematical bold), emoji and box characters out; lower case; one space between words. */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/g, (c) => SMALL_CAPS[c] ?? c).toLowerCase()
    .replace(/[^\p{L}\p{N}\[\](){}|/:.,+%&'-]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

const TIKTOK = /tik[\s-]?tok|тик[\s-]?ток|тікток|(?<![\p{L}\p{N}])tt(?![\p{L}\p{N}])/u
const YOUTUBE = /you[\s-]?tube|ютуб|ютьюб|(?<![\p{L}\p{N}])yt(?![\p{L}\p{N}])/u
const W = (words: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'u')
const KINDS: [string, RegExp][] = [
  ['followers', W('followers?|subscribers?|subs|members?|подписчик\\p{L}*|подписк\\p{L}*|підписник\\p{L}*|підписк\\p{L}*')],
  ['likes', W('likes?|hearts?|reactions?|лайк\\p{L}*|вподобайк\\p{L}*')],
  ['views', W('views?|impressions?|просмотр\\p{L}*|перегляд\\p{L}*')],
  ['comments', W('comments?|коммент\\p{L}*|коментар\\p{L}*')],
  ['shares', W('shares?|reposts?|saves?|репост\\p{L}*|сохранени\\p{L}*|збережен\\p{L}*|поделит\\p{L}*')],
]
const LIVE = W('live|livestream|live[\\s-]?stream|стрим\\p{L}*|эфир\\p{L}*|ефір\\p{L}*|трансляц\\p{L}*|live\\d{2,3}')
const WATCH_TIME = /watch[\s-]*(?:time|hours?)|watchtime|часы просмотра|годин\p{L}* перегляд/u
const COMMENT_LIKES = /comments?\s*(?:likes?|upvotes?)|likes?\s*(?:on|for)\s*comments?|upvotes?|лайк\p{L}*\s*(?:на|для)\s*коммент\p{L}*|лайк\p{L}*\s*коммент\p{L}*|лайк\p{L}*\s*комент\p{L}*/u
const UNWANTED = /(?<![\p{L}\p{N}])(?:ban|report|reports|strike|dislikes?|downvotes?|hack|бан|жалоб\p{L}*|дизлайк\p{L}*|взлом\p{L}*)(?![\p{L}\p{N}])|complaint/u

const COUNTRIES = /(?<![\p{L}\p{N}])(?:usa|us|uk|united states|united kingdom|america|germany|france|italy|spain|brazil|india|turkey|russia|ukraine|poland|arab|saudi|uae|egypt|mexico|japan|korea|indonesia|vietnam|philippines|nigeria|pakistan|bangladesh|thailand|canada|australia|europe|eu|tier\s*1|top countries|сша|россия|рф|украина|германия|франция|италия|испания|бразилия|индия|турция|польша|казахстан|снг|сша|європа)(?![\p{L}\p{N}])|\[(?:us|uk|ru|ua|de|fr|it|es|br|in|tr)\]|🇺🇸/u
const WORLDWIDE = /worldwide|world[\s-]?wide|global|(?<![\p{L}\p{N}])mix(?:ed)?(?![\p{L}\p{N}])|all countries|весь мир|микс|мікс|любые страны|будь-які країни/u
const RETENTION = /retention|удержан\p{L}*|утримання|watch[\s-]*time|watchtime|(?<![\p{L}\p{N}])\d+\s*(?:-|–|to)?\s*\d*\s*(?:min|mins|minutes|мин|хв)(?![\p{L}\p{N}])|full video/u
const SHORTS = /(?<![\p{L}\p{N}])shorts?(?![\p{L}\p{N}])|шортс/u
const SOURCE = /(?<![\p{L}\p{N}])(?:ads|adwords|google ads|direct|suggested|browse|external|embedded|playlist|search|for you|fyp|foryou|реклама|рекомендац\p{L}*)(?![\p{L}\p{N}])/u

const RU_PREMIUM = /гарант|рефил|докрут|пожизнен|реальн|живые|живых|живі|премиум|преміум|без списан|без списань|не списыва|восстановлен|відновлен|качествен|якісн/u
const RU_NO_GUARANTEE = /без\s*гарант|без\s*докрут|без\s*рефил|нет\s*гарант|немає\s*гарант|(?<![\p{L}\p{N}])боты?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])боти?(?![\p{L}\p{N}])/u

export interface Classified {
  platform: Platform | null
  /** followers | likes | views | comments | shares | live | watch_time; null when the line is not one clear product */
  action: string | null
  level: Level
  /** the guarantee in days (365 = lifetime), null when none is stated */
  refillDays: number | null
  /** country, retention, shorts, source: what makes a price of the same product differ */
  modifiers: string[]
  skip: 'unwanted' | 'platform' | 'ambiguous' | 'no_action' | 'comment_likes' | null
}

/** The guarantee a name states, in days: 365 for lifetime, null for none, for "no refill" and for a refill with no term. */
export function refillDays(text: string): number | null {
  if (/no[\s-]?refill|non[\s-]?refill|refill\s*[:=-]?\s*(?:no|none|0)(?![\p{L}\p{N}])|без\s*(?:гарант|докрут|рефил)|нет\s*гарант/u.test(text)) return null
  if (/lifetime|life[\s-]?time|пожизнен|навсегда|довічн|forever|365\s*(?:d|days?|дн)|1\s*year|(?<![\p{L}\p{N}])год(?![\p{L}\p{N}])/u.test(text)) return 365
  const near = /(?:refill|guarantee|warranty|гарант\p{L}*|восстановл\p{L}*|відновл\p{L}*|докрут\p{L}*)[^\d]{0,18}(\d{1,3})(?![\d])/u.exec(text)
    ?? /(?<![\p{L}\p{N}])r\s?(\d{2,3})(?![\p{L}\p{N}])/u.exec(text)
    ?? /(\d{1,3})\s*(?:d|days?|дн\p{L}*|д)(?![\p{L}\p{N}])[^\d]{0,12}(?:refill|guarantee|гарант\p{L}*|восстановл\p{L}*)/u.exec(text)
  if (near) { const d = Number(near[1]); if (d > 0 && d <= 400) return d }
  return null // a refill without a term states no number of days: none is made up
}

export function classify(rawName: string, rawCategory = ''): Classified {
  const text = normalizeName(`${rawName} ${rawCategory}`)
  const out: Classified = { platform: null, action: null, level: 'standard', refillDays: null, modifiers: [], skip: null }
  if (UNWANTED.test(text)) { out.skip = 'unwanted'; return out }
  const tt = TIKTOK.test(text)
  const yt = YOUTUBE.test(text)
  if (tt === yt) { out.skip = 'platform'; return out }
  out.platform = tt ? 'tiktok' : 'youtube'
  if (COMMENT_LIKES.test(text)) { out.skip = 'comment_likes'; return out }
  const noGuarantee = RU_NO_GUARANTEE.test(text)
  out.refillDays = refillDays(text)
  // a stated term (R30, "30 days refill") is a guarantee even when the name has no other quality word
  out.level = !noGuarantee && (isPremiumCard(text) || RU_PREMIUM.test(text) || out.refillDays !== null) ? 'premium' : 'standard'
  if (LIVE.test(text)) out.action = 'live'
  else if (WATCH_TIME.test(text)) out.action = 'watch_time'
  else {
    const kinds = KINDS.filter(([, re]) => re.test(text)).map(([id]) => id)
    if (kinds.length > 1) { out.skip = 'ambiguous'; return out }
    if (kinds.length === 0) { out.skip = 'no_action'; return out }
    out.action = kinds[0]!
  }
  if (COUNTRIES.test(text) && !WORLDWIDE.test(text)) out.modifiers.push('geo')
  if (RETENTION.test(text)) out.modifiers.push('retention')
  if (SHORTS.test(text)) out.modifiers.push('shorts')
  if (SOURCE.test(text)) out.modifiers.push('source')
  return out
}

// ---- the median per product ----------------------------------------------------------------------------------------------------------------------

export interface PricedRow { source: string; plane: Plane; platform: Platform; action: string; level: Level; modifiers: string[]; usd: number; name: string }

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export interface PlaneStats { median: number; low: number; high: number; n: number; rows: number; sources: { source: string; median: number; rows: number }[] }
export interface GroupStats { platform: Platform; action: string; level: Level; slice: 'plain' | 'all'; cis: PlaneStats | null; panel: PlaneStats | null }

/** Each competitor counts once: the median of its own lines, then the median, the lowest and the highest of those across the competitors of the plane. */
function planeStats(rows: PricedRow[]): PlaneStats | null {
  const bySource = new Map<string, number[]>()
  for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r.usd])
  const sources = [...bySource.entries()].map(([source, v]) => ({ source, median: median(v)!, rows: v.length })).sort((a, b) => a.median - b.median)
  if (sources.length === 0) return null
  const medians = sources.map((s) => s.median)
  return { median: median(medians)!, low: Math.min(...medians), high: Math.max(...medians), n: sources.length, rows: rows.length, sources }
}

export function aggregate(rows: PricedRow[]): GroupStats[] {
  const keys = new Set(rows.map((r) => `${r.platform}|${r.action}|${r.level}`))
  const out: GroupStats[] = []
  for (const key of [...keys].sort()) {
    const [platform, action, level] = key.split('|') as [Platform, string, Level]
    const group = rows.filter((r) => r.platform === platform && r.action === action && r.level === level)
    for (const slice of ['plain', 'all'] as const) {
      const part = slice === 'plain' ? group.filter((r) => r.modifiers.length === 0) : group
      out.push({ platform, action, level, slice, cis: planeStats(part.filter((r) => r.plane === 'cis')), panel: planeStats(part.filter((r) => r.plane === 'panel')) })
    }
  }
  return out
}

/** How far to trust a retail-storefront (plane cis) median: high = at least three storefronts and more than half of them within a factor of 2 of the median; medium = two that agree within 2x, or SMMLEVEL alone; low = the rest. */
export function confidenceOf(stats: PlaneStats | null): 'high' | 'medium' | 'low' {
  if (!stats) return 'low'
  const near = stats.sources.filter((s) => s.median <= stats.median * 2 && s.median >= stats.median / 2).length
  if (stats.n >= 3 && near * 2 > stats.n) return 'high'
  if (stats.n >= 2 && near >= 2) return 'medium'
  if (stats.n === 1 && stats.sources[0]!.source === 'smmlevel') return 'medium'
  return 'low'
}

// ---- politeness ----------------------------------------------------------------------------------------------------------------------------------

/** robots.txt, the group of `User-agent: *`: is the path allowed (the longest matching rule wins, Allow wins a tie). */
export function robotsAllows(robots: string, path: string): boolean {
  let applies = false
  let inGroup = false
  const disallow: string[] = []
  const allow: string[] = []
  for (const line of robots.split(/\r?\n/)) {
    const l = line.replace(/#.*$/, '').trim()
    if (!l) continue
    const at = l.indexOf(':')
    if (at < 0) continue
    const key = l.slice(0, at).trim().toLowerCase()
    const value = l.slice(at + 1).trim()
    if (key === 'user-agent') { if (!inGroup) applies = false; inGroup = true; if (value === '*') applies = true; continue }
    inGroup = false
    if (!applies || !value) continue
    if (key === 'disallow') disallow.push(value)
    if (key === 'allow') allow.push(value)
  }
  const longest = (rules: string[]) => Math.max(-1, ...rules.map((r) => r.replace(/[*$]+$/, '')).filter((r) => path.startsWith(r)).map((r) => r.length))
  const d = longest(disallow)
  return d < 0 || longest(allow) >= d
}
