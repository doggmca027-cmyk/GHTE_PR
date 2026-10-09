export type LangCode = 'en' | 'ru' | 'uk' | 'es' | 'pt' | 'id' | 'tr' | 'ar' | 'hi' | 'fr' | 'de' | 'it' | 'vi' | 'zh' | 'ja'

export interface Language {
  code: LangCode
  /** The language's own name: what a speaker looks for in the list. */
  name: string
  /** English name, for people who landed on a language they cannot read. */
  english: string
  /** BCP 47 tag for dates and numbers. */
  locale: string
  dir: 'ltr' | 'rtl'
}

/** The 15 languages of the app. English is the source text of every message; the rest live in src/i18n/locales. */
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English', english: 'English', locale: 'en-US', dir: 'ltr' },
  { code: 'ru', name: 'Русский', english: 'Russian', locale: 'ru-RU', dir: 'ltr' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian', locale: 'uk-UA', dir: 'ltr' },
  { code: 'es', name: 'Español', english: 'Spanish', locale: 'es-ES', dir: 'ltr' },
  { code: 'pt', name: 'Português', english: 'Portuguese', locale: 'pt-BR', dir: 'ltr' },
  { code: 'id', name: 'Bahasa Indonesia', english: 'Indonesian', locale: 'id-ID', dir: 'ltr' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', locale: 'tr-TR', dir: 'ltr' },
  { code: 'ar', name: 'العربية', english: 'Arabic', locale: 'ar', dir: 'rtl' },
  { code: 'hi', name: 'हिन्दी', english: 'Hindi', locale: 'hi-IN', dir: 'ltr' },
  { code: 'fr', name: 'Français', english: 'French', locale: 'fr-FR', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', english: 'German', locale: 'de-DE', dir: 'ltr' },
  { code: 'it', name: 'Italiano', english: 'Italian', locale: 'it-IT', dir: 'ltr' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese', locale: 'vi-VN', dir: 'ltr' },
  { code: 'zh', name: '简体中文', english: 'Chinese (Simplified)', locale: 'zh-CN', dir: 'ltr' },
  { code: 'ja', name: '日本語', english: 'Japanese', locale: 'ja-JP', dir: 'ltr' },
]

export const DEFAULT_LANGUAGE: LangCode = 'en'

export const isLangCode = (v: unknown): v is LangCode => LANGUAGES.some((l) => l.code === v)

export const languageOf = (code: LangCode): Language => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]

// Codes Telegram and browsers use that are not one of ours verbatim.
const ALIASES: Record<string, LangCode> = { in: 'id' }

/** "pt-BR" -> pt, "zh-Hans" -> zh, "in" -> id, "xx" -> null. */
export function matchLanguage(raw: string | null | undefined): LangCode | null {
  if (!raw) return null
  const base = raw.toLowerCase().split(/[-_]/)[0]
  if (isLangCode(base)) return base
  return ALIASES[base] ?? null
}
