// npm run translate-names (pure parts, tested in tests/name-translations.test.ts). Keep to erasable syntax: the script runs without a build step.
//
// The translator sends the English names of services to Gemini and gets the same names in the 14 other languages of the app back. What comes
// back is untrusted text (it ends up on the storefront and in a SQL statement), so everything is checked here before it is used.

/** The languages of the app but English (src/i18n/languages.ts): the source text is the English name. */
export const TARGET_LANGUAGES: Readonly<Record<string, string>> = {
  ru: 'Russian', uk: 'Ukrainian', es: 'Spanish', pt: 'Portuguese (Brazil)', id: 'Indonesian', tr: 'Turkish', ar: 'Arabic',
  hi: 'Hindi', fr: 'French', de: 'German', it: 'Italian', vi: 'Vietnamese', zh: 'Chinese (Simplified)', ja: 'Japanese',
}

export const MAX_TRANSLATION_CHARS = 220

export interface ServiceName { id: string; name: string }

/** The instruction for one batch: names are numbered, the answer is a JSON array of {i, tr}. */
export function buildPrompt(names: readonly string[], langs: readonly string[]): string {
  const wanted = langs.map((l) => `${l} (${TARGET_LANGUAGES[l]})`).join(', ')
  return [
    'You translate the names of social-media marketing services (a storefront catalogue) from English.',
    `Translate each name into: ${wanted}.`,
    'Rules:',
    '- Keep numbers, units, percentages, quantities and anything in [brackets] meaningful: every number of the English name must appear unchanged in the translation.',
    '- Keep brand and platform names (Instagram, TikTok, YouTube, Telegram, Spotify, X, Google...) and technical tags (HQ, UHQ, R30, Refill, Non-Drop, Drip-feed, API) as they are, or in the form the language normally uses for them.',
    '- Translate the meaning (Followers, Views, Traffic, Likes, Real, Lifetime, Organic...) naturally for a customer who reads that language. No explanations, no added promises, nothing the English name does not say.',
    '- One line per name, no line breaks, no markdown, no quotes around it.',
    'Answer with JSON only: an array with one object per name, {"i": <the number of the name>, "tr": {"<language code>": "<translation>", ...}}.',
    '',
    'Names:',
    ...names.map((n, i) => `${i}. ${n.replace(/\s+/g, ' ').trim()}`),
  ].join('\n')
}

/** The writing systems a model may mix in by mistake (a Hindi name with Japanese letters in it), and which of them each language uses. Latin is always fine: brands and tags. */
const SCRIPTS: Readonly<Record<string, RegExp>> = {
  cyrillic: /[\u0400-\u04FF]/, arabic: /[\u0600-\u06FF\u0750-\u077F]/, devanagari: /[\u0900-\u097F]/, han: /[\u4E00-\u9FFF]/,
  kana: /[\u3040-\u30FF]/, hangul: /[\uAC00-\uD7AF]/, thai: /[\u0E00-\u0E7F]/, hebrew: /[\u0590-\u05FF]/,
}
const SCRIPTS_OF: Readonly<Record<string, readonly string[]>> = { ru: ['cyrillic'], uk: ['cyrillic'], ar: ['arabic'], hi: ['devanagari'], zh: ['han'], ja: ['han', 'kana'] }

/** A foreign writing system in a translation (one the language does not use and the English name does not have): the model slipped. */
const mixesScripts = (source: string, lang: string, text: string): boolean =>
  Object.entries(SCRIPTS).some(([script, re]) => re.test(text) && !re.test(source) && !(SCRIPTS_OF[lang] ?? []).includes(script))

const digitsOf = (s: string): string[] => s.match(/\d+/g) ?? []

/**
 * One translation, or null when it cannot be trusted: not text, empty, too long, markup, control characters, a `$tr$` that could end the SQL
 * literal, or a number of the English name that is missing from it (a translator that changes "100K" or "30 days" changes what is sold).
 */
export function cleanTranslation(source: string, value: unknown, lang?: string): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '' || text.length > MAX_TRANSLATION_CHARS) return null
  if (/[\u0000-\u001f\u007f<>`]|\$tr\$/.test(text)) return null
  const have = digitsOf(text)
  if (!digitsOf(source).every((d) => have.includes(d))) return null
  if (lang !== undefined && mixesScripts(source, lang, text)) return null
  return text
}

/** What Gemini answered for a batch, as {id -> {language -> translation}}: only the names and languages that were asked for, only clean text. */
export function parseBatch(raw: string, batch: readonly ServiceName[], langs: readonly string[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  let data: unknown
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    return out
  }
  if (!Array.isArray(data)) return out
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const { i, tr } = item as { i?: unknown; tr?: unknown }
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= batch.length || typeof tr !== 'object' || tr === null) continue
    const service = batch[i]!
    const clean: Record<string, string> = {}
    for (const lang of langs) {
      const text = cleanTranslation(service.name, (tr as Record<string, unknown>)[lang], lang)
      if (text !== null) clean[lang] = text
    }
    if (Object.keys(clean).length > 0) out.set(service.id, { ...(out.get(service.id) ?? {}), ...clean })
  }
  return out
}


/** The cards that have no translations yet: Premium first (the first run is for them only unless `all`), a stable order, one batch of them. */
export function selectUntranslatedSql(limit: number, all: boolean): string {
  return `select id, name from services
    where is_active ${all ? '' : 'and is_premium'} and name_translations = '{}'::jsonb and name <> ''
    order by is_premium desc, id limit ${Math.max(1, Math.min(2000, Math.trunc(limit)))};`
}

/**
 * The write: merges the new translations into the ones a card has, and only while the card still has the English name they were made from
 * (a rename in between clears them, so a stale answer is dropped). Nothing else on the card is touched. The JSON travels in one dollar-quoted
 * literal; cleanTranslation has refused anything that could end it.
 */
export function saveTranslationsSql(rows: readonly { id: string; name: string; tr: Record<string, string> }[]): string | null {
  if (rows.length === 0) return null
  const json = JSON.stringify(rows.map((r) => ({ id: r.id, n: r.name, t: r.tr })))
  if (json.includes('$tr$')) return null
  return `update services s set name_translations = s.name_translations || x.t
    from jsonb_to_recordset($tr$${json}$tr$::jsonb) as x(id uuid, n text, t jsonb)
    where s.id = x.id and s.name = x.n;`
}

