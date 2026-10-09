import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectKeys, placeholders } from '../scripts/lib/i18n-keys'
import {
  LANGUAGES, currentLanguage, currentLocale, languageOf, matchLanguage, pickInitialLanguage, setLanguage, t, tr,
  type LangCode,
} from '../src/i18n'
import { KNOWN_MESSAGES, tm } from '../src/i18n/messages'

const SRC = path.resolve(__dirname, '../src')
const OTHER = LANGUAGES.filter((l) => l.code !== 'en')
const { keys, templateCalls } = collectKeys(SRC)

async function dictionary(code: LangCode): Promise<Record<string, string>> {
  return (await import(`../src/i18n/locales/${code}.ts`)).default
}

afterEach(async () => {
  await setLanguage('en', { persist: false })
})

describe('the language list', () => {
  it('has the 15 languages, once each, with their own names; only Arabic is right-to-left', () => {
    expect(LANGUAGES).toHaveLength(15)
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(15)
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'ru', 'uk', 'es', 'pt', 'id', 'tr', 'ar', 'hi', 'fr', 'de', 'it', 'vi', 'zh', 'ja'])
    expect(LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code)).toEqual(['ar'])
    for (const l of LANGUAGES) expect(l.name.length, l.code).toBeGreaterThan(1)
    expect(languageOf('ru').name).toBe('Русский')
  })

  it('every language has a dictionary file, and the loader table in src/i18n/index.ts names exactly those files', () => {
    const index = fs.readFileSync(path.join(SRC, 'i18n/index.ts'), 'utf8')
    for (const l of OTHER) {
      expect(fs.existsSync(path.join(SRC, `i18n/locales/${l.code}.ts`)), l.code).toBe(true)
      expect(index, l.code).toContain(`import('./locales/${l.code}')`)
    }
    expect(fs.readdirSync(path.join(SRC, 'i18n/locales')).sort()).toEqual(OTHER.map((l) => `${l.code}.ts`).sort())
  })
})

describe('the texts the app asks to translate', () => {
  it('are found by reading the code, and none is built with a template literal (those cannot be read)', () => {
    expect(templateCalls).toEqual([])
    expect(keys.size).toBeGreaterThan(200)
    expect(keys.has('Top Up Balance')).toBe(true)
    expect(keys.has('Search platforms')).toBe(true)
    // every fixed sentence of src/i18n/messages.ts is among them
    for (const m of KNOWN_MESSAGES) expect(keys.has(m), m).toBe(true)
  })

  it.each(OTHER.map((l) => l.code))('%s: translates every one of them, nothing stale, placeholders intact', async (code) => {
    const dict = await dictionary(code)
    const missing = [...keys.keys()].filter((k) => !(k in dict))
    const stale = Object.keys(dict).filter((k) => !keys.has(k))
    const brokenPlaceholders = [...keys.keys()].filter((k) => k in dict && placeholders(k).join() !== placeholders(dict[k]).join())
    const empty = Object.entries(dict).filter(([, v]) => v.trim() === '').map(([k]) => k)
    expect({ missing, stale, brokenPlaceholders, empty }).toEqual({ missing: [], stale: [], brokenPlaceholders: [], empty: [] })
  })

  it.each(OTHER.map((l) => l.code))('%s: is a real translation, not a copy of the English', async (code) => {
    const dict = await dictionary(code)
    const same = Object.entries(dict).filter(([k, v]) => k === v).length
    // a few texts are the same in every language (Telegram ID, ...), most are not
    expect(same / Object.keys(dict).length).toBeLessThan(0.12)
  })

  it('no language mixes in HTML or a stray newline', async () => {
    for (const l of OTHER) {
      for (const [k, v] of Object.entries(await dictionary(l.code))) {
        expect(v, `${l.code}: ${k}`).not.toMatch(/[<>\n]/)
      }
    }
  })
})

describe('t() at run time', () => {
  it('is English until a language is chosen, and returns an unknown text unchanged', () => {
    expect(currentLanguage()).toBe('en')
    expect(t('Orders')).toBe('Orders')
    expect(t('A sentence nobody translated')).toBe('A sentence nobody translated')
    expect(tr('Orders')).toBe('Orders')
  })

  it('fills {placeholders}, in English and in a translation, and leaves an unknown placeholder alone', async () => {
    expect(t('Order #{id}', { id: 'ab12' })).toBe('Order #ab12')
    expect(t('{n} min ago', { n: 5 })).toBe('5 min ago')
    expect(t('Order #{id}', {})).toBe('Order #{id}')
    await setLanguage('ru', { persist: false })
    expect(t('Order #{id}', { id: 'ab12' })).toBe('Заказ №ab12')
    expect(t('{n} min ago', { n: 5 })).toBe('5 мин назад')
  })

  it('switches language and back', async () => {
    await setLanguage('de', { persist: false })
    expect(currentLanguage()).toBe('de')
    expect(t('Settings')).toBe('Einstellungen')
    expect(currentLocale()).toBe('de-DE')
    await setLanguage('en', { persist: false })
    expect(t('Settings')).toBe('Settings')
  })

  it('translates the messages that come from the shared validators and the server, including the ones with numbers', async () => {
    await setLanguage('ru', { persist: false })
    expect(tm('Enter a quantity')).toBe('Введите количество')
    expect(tm('Minimum is 1,000')).toBe('Минимум — 1,000')
    expect(tm('Maximum deposit is $500.00')).toBe('Максимальное пополнение — $500.00')
    expect(tm('Quantity must be between 100 and 5,000.')).toBe('Количество должно быть от 100 до 5,000.')
    expect(tm('Insufficient balance.')).toBe('Недостаточно средств.')
    // a sentence nobody knows is shown as it came
    expect(tm('The provider said: out of stock')).toBe('The provider said: out of stock')
  })

  it('an unknown language code changes nothing', async () => {
    await setLanguage('xx' as LangCode, { persist: false })
    expect(currentLanguage()).toBe('en')
  })
})

describe('which language the app starts in', () => {
  it('maps what Telegram and browsers send: region and script tags, the old Indonesian code', () => {
    expect(matchLanguage('ru')).toBe('ru')
    expect(matchLanguage('pt-BR')).toBe('pt')
    expect(matchLanguage('zh-Hans')).toBe('zh')
    expect(matchLanguage('zh_CN')).toBe('zh')
    expect(matchLanguage('in')).toBe('id')
    expect(matchLanguage('UK')).toBe('uk')
    expect(matchLanguage('xx')).toBeNull()
    expect(matchLanguage('')).toBeNull()
    expect(matchLanguage(undefined)).toBeNull()
  })

  it('follows Telegram first, then the browser, then English (no stored choice here)', () => {
    expect(pickInitialLanguage('es', ['fr'])).toBe('es')
    expect(pickInitialLanguage(undefined, ['xx-YY', 'ja-JP', 'fr'])).toBe('ja')
    expect(pickInitialLanguage('xx', [])).toBe('en')
    expect(pickInitialLanguage(undefined)).toBe('en')
  })
})

describe('the screens in another language', () => {
  const render = async (name: 'SettingsScreen' | 'PlatformList', props: Record<string, unknown>) => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const Component = name === 'SettingsScreen' ? (await import('../src/components/settings/SettingsScreen')).SettingsScreen : (await import('../src/components/services/PlatformList')).PlatformList
    return renderToStaticMarkup(createElement(Component as never, props as never))
  }
  const session = { token: 't', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } }

  it('Settings lists all 15 languages by their own name and marks the current one', async () => {
    const html = await render('SettingsScreen', { session })
    for (const l of LANGUAGES) expect(html, l.code).toContain(l.name)
    expect(html).toContain('role="radiogroup"')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-checked="true"[^>]*lang="en"|lang="en"[^>]*aria-checked="true"/)
  })

  it('Settings is translated after the language is chosen', async () => {
    await setLanguage('ru', { persist: false })
    const html = await render('SettingsScreen', { session })
    expect(html).toContain('Настройки')
    expect(html).toContain('Язык')
    expect(html).toContain('Условия использования')
    expect(html).toMatch(/lang="ru"[^>]*aria-checked="true"|aria-checked="true"[^>]*lang="ru"/)
  })

  it('the platform list is translated too', async () => {
    await setLanguage('es', { persist: false })
    const html = await render('PlatformList', { platforms: [{ slug: 'twitch', name: 'Twitch', count: 3 }, { slug: 'kick', name: 'Kick', count: 0 }], onSelect: () => {} })
    expect(html).toContain('Buscar plataformas')
    expect(html).toContain('Servicios: 3')
    expect(html).toContain('Aún no hay servicios')
  })

  it('Arabic is right-to-left', () => {
    expect(languageOf('ar').dir).toBe('rtl')
    expect(languageOf('de').dir).toBe('ltr')
  })
})
