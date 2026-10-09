// Instant, in-memory search of the platform list. No request is made: the list is already on the device.
//
// A query matches a platform by its name, its slug or one of its ALIASES: the short forms and the other-language spellings people
// actually type ("tg", "телега", "ig", "инста", "вк", "ютуб" ...). Results are ranked: an exact hit first, then names that start
// with the query, then names that contain it, then a one-letter typo ("instgram"). Ties keep the list's own order.

export interface Searchable {
  slug: string
  name: string
}

/** Alternative names per platform slug, already lower case. Cyrillic is written with "е" (the query's "ё" is folded to it). */
export const PLATFORM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  telegram: ['tg', 'tele', 'tlg', 'телега', 'телеграм', 'телеграмм', 'тг', 'телек'],
  instagram: ['ig', 'insta', 'inst', 'инста', 'инстаграм', 'инстаграмм', 'инст', 'иг'],
  vk: ['vkontakte', 'vk.com', 'вк', 'вконтакте', 'вконтакт', 'контакт'],
  youtube: ['yt', 'you tube', 'ютуб', 'ютьюб', 'ютюб', 'ют'],
  tiktok: ['tt', 'tik tok', 'tik-tok', 'тикток', 'тик ток', 'тик-ток', 'тт'],
  twitter: ['x', 'twitter', 'tw', 'твиттер', 'твитер', 'икс'],
  facebook: ['fb', 'face', 'фб', 'фейсбук', 'фэйсбук', 'фейс'],
  whatsapp: ['wa', 'whats app', 'wapp', 'ватсап', 'вотсап', 'вацап', 'ватсапп', 'воцап'],
  snapchat: ['snap', 'sc', 'снапчат', 'снэпчат', 'снап'],
  discord: ['ds', 'disc', 'дискорд', 'дс'],
  twitch: ['tv', 'твич', 'твитч'],
  spotify: ['spot', 'спотифай', 'спотик'],
  linkedin: ['li', 'линкедин', 'линкед', 'линкдин'],
  pinterest: ['pin', 'pint', 'пинтерест', 'пин'],
  reddit: ['rdt', 'реддит', 'редит'],
  threads: ['thr', 'тредс', 'трэдс'],
  odnoklassniki: ['ok', 'ok.ru', 'ok ru', 'одноклассники', 'одноклассник', 'одни', 'ок'],
  'apple-music': ['apple', 'am', 'эппл', 'эпл', 'эппл мьюзик', 'яблоко'],
  'apple-podcasts': ['podcasts', 'podcast', 'подкасты', 'эппл подкасты'],
  'yandex-music': ['ym', 'яндекс музыка', 'яндекс.музыка', 'ям', 'музыка'],
  'yandex-zen': ['zen', 'dzen', 'дзен', 'яндекс дзен'],
  'yandex-maps': ['яндекс карты', 'яндекс.карты', 'ya maps'],
  'google-maps': ['gmaps', 'google', 'гугл карты', 'гугл мапс', 'гугл'],
  soundcloud: ['sc', 'саундклауд', 'саундклауд', 'саунд'],
  rutube: ['рутуб', 'рутьюб'],
  kick: ['кик'],
  trustpilot: ['tp', 'трастпилот'],
  tripadvisor: ['ta', 'трипадвайзор', 'трипадвизор'],
  website: ['web', 'site', 'traffic', 'трафик', 'сайт', 'сайты', 'веб'],
  'crypto-nft': ['crypto', 'nft', 'крипта', 'крипто', 'нфт'],
  'mobile-apps': ['apps', 'app', 'приложения', 'приложение', 'аппы'],
  'app-installs': ['installs', 'install', 'установки', 'инсталлы'],
  'email-marketing': ['email', 'e-mail', 'mail', 'почта', 'рассылка', 'имейл'],
  backlinks: ['backlink', 'seo', 'ссылки', 'бэклинки'],
  'truth-social': ['truth', 'трут'],
  xiaohongshu: ['red', 'xhs', 'rednote', 'сяохуншу', 'сяохуньшу'],
  roblox: ['рблх', 'роблокс', 'роблох'],
  steam: ['стим'],
  vimeo: ['вимео'],
  dailymotion: ['dm', 'дейлимоушн'],
  deezer: ['дизер', 'дизэр'],
  tumblr: ['тамблер', 'тумблр'],
  quora: ['квора'],
  github: ['gh', 'гитхаб', 'гитхуб', 'git'],
  bluesky: ['bsky', 'блюскай', 'блюски'],
  line: ['лайн'],
  clubhouse: ['клабхаус', 'клубхаус'],
  medium: ['медиум'],
  shopee: ['шопи'],
  avito: ['авито'],
  max: ['макс', 'мах'],
  likee: ['лайки', 'лайк'],
  kwai: ['квай'],
  kuaishou: ['куайшоу'],
  coub: ['кауб', 'коуб'],
  naver: ['навер'],
  potato: ['потейто', 'картошка'],
  coinmarketcap: ['cmc', 'coin market cap', 'коинмаркеткап'],
  fiverr: ['фиверр', 'файверр'],
  imdb: ['имдб', 'кинопоиск'],
  'app-store': ['appstore', 'app store', 'апп стор', 'аппстор'],
  multiplatform: ['multi', 'мульти', 'все'],
  'smm-tools': ['smm', 'tools', 'инструменты', 'смм'],
  other: ['другое', 'прочее', 'остальное', 'misc'],
}

/** Lower case, "ё" -> "е", accents and punctuation folded to spaces, whitespace collapsed. */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim()
}

/** Edit distance (insert, delete, replace, swap two neighbours), stopping early once it is certainly above `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let beforePrev: number[] | null = null
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (beforePrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, beforePrev[j - 2] + 1)
      row.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1
    beforePrev = prev
    prev = row
  }
  return prev[b.length]
}

const words = (s: string) => s.split(' ').filter(Boolean)

/** How well `query` (normalised) matches one platform: 0 is best, null is no match. */
export function matchScore(query: string, p: Searchable): number | null {
  const names = [normalizeQuery(p.name), normalizeQuery(p.slug.replace(/-/g, ' '))]
  const aliases = (PLATFORM_ALIASES[p.slug] ?? []).map(normalizeQuery)
  const all = [...names, ...aliases]

  if (all.includes(query)) return 0
  if (all.some((c) => c.startsWith(query))) return 1
  // a word of the name starts with it: "music" finds "Apple Music"
  if (names.some((n) => words(n).some((w) => w.startsWith(query)))) return 2
  if (query.length >= 3 && names.some((n) => n.includes(query))) return 3
  // one wrong, missing or extra letter, for words long enough that this is not a coincidence
  if (query.length >= 4) {
    for (const c of all) for (const w of [c, ...words(c)]) if (w.length >= 4 && distance(query, w, 1) <= 1) return 4
  }
  return null
}

/** The platforms matching `rawQuery`, best first; the list's own order breaks ties. An empty query returns everything. */
export function searchPlatforms<T extends Searchable>(list: readonly T[], rawQuery: string): T[] {
  const query = normalizeQuery(rawQuery)
  if (query === '') return [...list]
  const scored: Array<{ p: T; score: number; index: number }> = []
  list.forEach((p, index) => {
    const score = matchScore(query, p)
    if (score !== null) scored.push({ p, score, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.p)
}
