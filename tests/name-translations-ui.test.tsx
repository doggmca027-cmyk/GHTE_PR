// @vitest-environment jsdom
// The storefront shows a service in the customer's language when the translator has made one, and the English name otherwise.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ServiceCard } from '../src/components/services/ServiceCard'
import { setLanguage } from '../src/i18n'
import { localizedName, serviceName } from '../src/lib/service-view'
import { SERVICE_COLUMNS, serviceFromRow } from '../src/services/api/services'
import type { ICatalogService } from '../src/types/catalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NAME = 'Website Traffic | Organic from Google'
const TR = { ru: 'Трафик на сайт | Органический из Google', es: 'Tráfico web | Orgánico de Google', hi: 'वेबसाइट ट्रैफ़िक | Google से ऑर्गेनिक' }

describe('which name is shown', () => {
  it('the name in the customer\'s language, the English name when there is none for it', () => {
    expect(localizedName(NAME, undefined, 'es', TR)).toBe(TR.es)
    expect(localizedName(NAME, undefined, 'hi', TR)).toBe(TR.hi)
    expect(localizedName(NAME, undefined, 'de', TR)).toBe(NAME)
    expect(localizedName(NAME, undefined, 'en', TR)).toBe(NAME)
    expect(localizedName(NAME, undefined, 'es', {})).toBe(NAME)
    expect(localizedName(NAME, undefined, 'es')).toBe(NAME)
  })
  it('a regional tag finds the language (es-MX reads Spanish)', () => {
    expect(localizedName(NAME, undefined, 'es-MX', TR)).toBe(TR.es)
  })
  it('Russian readers get the provider\'s own Russian name first, Ukrainian readers their translation first', () => {
    const i18n = { ru: 'Оригинал от панели' }
    expect(localizedName(NAME, i18n, 'ru', TR)).toBe('Оригинал от панели')
    expect(localizedName(NAME, i18n, 'ru', { ru: TR.ru })).toBe('Оригинал от панели')
    expect(localizedName(NAME, undefined, 'ru', TR)).toBe(TR.ru)
    expect(localizedName(NAME, i18n, 'uk', { uk: 'Трафік на сайт' })).toBe('Трафік на сайт')
    expect(localizedName(NAME, i18n, 'uk', TR)).toBe('Оригинал от панели') // no Ukrainian translation: the Russian original, as before
    expect(localizedName(NAME, i18n, 'es')).toBe(NAME)
  })
  it('serviceName reads a card', () => {
    expect(serviceName({ name: NAME, nameTranslations: TR }, 'es')).toBe(TR.es)
  })
})

describe('the row of the database', () => {
  const row = { id: 's', category_id: 'c', name: NAME, description: null, customer_rate_per_1000: '1', min_quantity: 10, max_quantity: 100, refill_supported: false, sort_order: 1 }
  it('the app reads the column; an empty object or none means no translations', () => {
    expect(SERVICE_COLUMNS).toContain('name_translations')
    expect(serviceFromRow({ ...row, name_translations: TR }).nameTranslations).toEqual(TR)
    expect(serviceFromRow({ ...row, name_translations: {} })).not.toHaveProperty('nameTranslations')
    expect(serviceFromRow({ ...row, name_translations: null })).not.toHaveProperty('nameTranslations')
    expect(serviceFromRow(row)).not.toHaveProperty('nameTranslations')
  })
})

describe('the card', () => {
  let host: HTMLElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); await setLanguage('en', { persist: false }) })
  const service: ICatalogService = { id: 's1', categoryId: 'c1', name: NAME, description: null, ratePer1000: 1, minQuantity: 10, maxQuantity: 1000, refillSupported: false, sortOrder: 1, nameTranslations: TR }
  const title = async (lang: Parameters<typeof setLanguage>[0]) => {
    await act(async () => { await setLanguage(lang, { persist: false }) })
    await act(async () => { root.render(createElement(ServiceCard, { service, platform: 'website', onSelect: () => {} })) })
    return host.querySelector('h3')!.textContent
  }
  it('shows the Spanish and the Hindi name to Spanish and Hindi readers, and the English one to everybody else', async () => {
    expect(await title('es')).toBe(TR.es)
    expect(await title('hi')).toBe(TR.hi)
    expect(await title('en')).toBe(NAME)
    expect(await title('ja')).toBe(NAME)
  })
})
