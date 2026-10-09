// Translations without a provider: the ENGLISH TEXT is the key. `t('Top Up Balance')` returns the current language's version of
// it, or the English text itself when there is none (a missing translation can never blank out the screen). A message may carry
// `{name}` placeholders: t('Order #{id}', { id }).
//
//   t(text, params?)   translates now. Use it where the text is shown or built.
//   tr(text)           marks a text that is translated LATER (labels kept in constants); returns it unchanged.
//   useT()               the hook components call: it re-renders them when the language changes and returns `t`.
//
// The state lives in this module (not in a React context), so pure helpers such as lib/order-view.ts can call `t` and a screen
// rendered without any provider (every test) simply shows English. tests/i18n.test.ts reads the source, collects every literal
// handed to t() / tr() and fails if one of the 15 languages is missing it, has a stale entry, or loses a placeholder.

import { useSyncExternalStore } from 'react'
import { DEFAULT_LANGUAGE, isLangCode, languageOf, matchLanguage, type LangCode } from './languages'

export { LANGUAGES, languageOf, matchLanguage, isLangCode, type LangCode, type Language } from './languages'

export type Dictionary = Readonly<Record<string, string>>

/** Loaded on demand: a customer downloads their own language only. English needs no dictionary. */
const LOADERS: Record<Exclude<LangCode, 'en'>, () => Promise<{ default: Dictionary }>> = {
  ru: () => import('./locales/ru'),
  uk: () => import('./locales/uk'),
  es: () => import('./locales/es'),
  pt: () => import('./locales/pt'),
  id: () => import('./locales/id'),
  tr: () => import('./locales/tr'),
  ar: () => import('./locales/ar'),
  hi: () => import('./locales/hi'),
  fr: () => import('./locales/fr'),
  de: () => import('./locales/de'),
  it: () => import('./locales/it'),
  vi: () => import('./locales/vi'),
  zh: () => import('./locales/zh'),
  ja: () => import('./locales/ja'),
}

export const STORAGE_KEY = 'lang'

interface State {
  lang: LangCode
  dict: Dictionary
}

let state: State = { lang: DEFAULT_LANGUAGE, dict: {} }
const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
const snapshot = () => state

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole))
}

/** Translates `text` (English) into the current language and fills its `{placeholders}`. */
export function t(text: string, params?: Record<string, string | number>): string {
  return interpolate(state.dict[text] ?? text, params)
}

/** Marks an English text for translation without translating it yet. Returns it unchanged. */
export const tr = <T extends string>(text: T): T => text

export const currentLanguage = (): LangCode => state.lang
/** BCP 47 tag of the current language, for toLocaleString and friends. */
export const currentLocale = (): string => languageOf(state.lang).locale

/** Component hook: subscribes to language changes and returns `t`. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return t
}

/** The current language and a way to change it (the Settings screen). */
export function useLanguage(): { lang: LangCode; setLanguage: (code: LangCode) => Promise<void> } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)
  return { lang: s.lang, setLanguage }
}

function apply(lang: LangCode) {
  if (typeof document === 'undefined') return
  const { dir, code } = languageOf(lang)
  document.documentElement.lang = code
  document.documentElement.dir = dir
}

function remember(lang: LangCode) {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch { /* private mode: the choice lasts for this session only */ }
}

/** Switches the app's language: loads its dictionary, re-renders every screen, remembers the choice. */
export async function setLanguage(code: LangCode, opts: { persist?: boolean } = {}): Promise<void> {
  if (!isLangCode(code)) return
  const dict = code === 'en' ? {} : (await LOADERS[code]()).default
  state = { lang: code, dict }
  apply(code)
  if (opts.persist !== false) remember(code)
  for (const fn of listeners) fn()
}

/** What the customer chose before, if anything. */
export function storedLanguage(): LangCode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isLangCode(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The language to start in: the customer's own choice, else Telegram's language_code, else the browser's, else English.
 * Only an explicit choice is stored: until then the app keeps following Telegram.
 */
export function pickInitialLanguage(telegramLanguage?: string | null, browserLanguages: readonly string[] = []): LangCode {
  return storedLanguage() ?? matchLanguage(telegramLanguage) ?? browserLanguages.map(matchLanguage).find((l) => l !== null) ?? DEFAULT_LANGUAGE
}

/** Call once at startup, before the first render. Never throws: a failed download leaves English. */
export async function initLanguage(telegramLanguage?: string | null): Promise<void> {
  const browser = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []
  try {
    await setLanguage(pickInitialLanguage(telegramLanguage, browser), { persist: false })
  } catch {
    apply(DEFAULT_LANGUAGE)
  }
}
