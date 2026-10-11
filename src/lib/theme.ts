// Light / dark. Telegram tells the Mini App which colour scheme the user's Telegram uses (WebApp.colorScheme, and a `themeChanged`
// event when it flips); outside Telegram the browser's own preference decides. The customer can override it in Settings
// ("auto" follows, "light" / "dark" are remembered on the device).
//
// The scheme is written to <html data-theme="light|dark">; every colour in the app is a CSS variable that tailwind.config.js defines
// for both values, so nothing else needs to know about the theme.
import { useSyncExternalStore } from 'react'
import { WebApp } from '@/lib/webapp'

export type Scheme = 'light' | 'dark'
export type ThemePreference = 'auto' | Scheme

export const THEME_STORAGE_KEY = 'theme'

let preference: ThemePreference = 'auto'
const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

/** The top bar / background Telegram paints around the app (it must match the screen's colour or a stripe shows). */
export const SCREEN_COLOR: Record<Scheme, string> = { light: '#EBF3FE', dark: '#0E1621' }

const media = (): MediaQueryList | null => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  } catch {
    return null
  }
}

/** The customer's choice when they made one, else Telegram's scheme when the app runs inside it, else the browser's. */
export function detectScheme(): Scheme {
  if (preference !== 'auto') return preference
  const telegram = (WebApp as { colorScheme?: string }).colorScheme
  if (telegram === 'dark' || telegram === 'light') return telegram
  return media()?.matches ? 'dark' : 'light'
}

let applied: Scheme = 'light'

export function applyScheme(scheme: Scheme): void {
  applied = scheme
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.dataset.theme = scheme
    root.style.colorScheme = scheme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', SCREEN_COLOR[scheme])
  }
  try {
    WebApp.setHeaderColor(SCREEN_COLOR[scheme] as never)
    WebApp.setBackgroundColor(SCREEN_COLOR[scheme] as never)
  } catch {
    /* outside Telegram, or a client too old for the call */
  }
}

export const getThemePreference = (): ThemePreference => preference

/** Remembers the choice on the device and applies it at once. */
export function setThemePreference(next: ThemePreference): void {
  preference = next
  try {
    if (next === 'auto') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    /* private mode: the choice lasts until the app is closed */
  }
  applyScheme(detectScheme())
  listeners.forEach((fn) => fn())
}

/** The scheme in effect (light or dark), re-rendering the component when it changes for any reason. */
export function useScheme(): Scheme {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => void listeners.delete(fn) }, () => applied, () => applied)
}

/** The saved choice, re-rendering the component when it changes. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => void listeners.delete(fn) }, getThemePreference, getThemePreference)
}

/** Applies the scheme now and again whenever Telegram or the browser changes it. Returns the scheme in effect. */
export function initTheme(): Scheme {
  preference = readPreference()
  const update = () => { applyScheme(detectScheme()); listeners.forEach((fn) => fn()) }
  update()
  try {
    ;(WebApp as { onEvent?: (event: string, cb: () => void) => void }).onEvent?.('themeChanged', update)
  } catch {
    /* no Telegram */
  }
  try {
    media()?.addEventListener('change', update)
  } catch {
    /* an old browser */
  }
  return detectScheme()
}
