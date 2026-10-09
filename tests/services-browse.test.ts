// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/i18n'
import { describeService, localizedName } from '../src/lib/service-view'
import { resetLogoFailures } from '../src/lib/platform-logo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  await setLanguage('en', { persist: false })
})

describe('names and descriptions in the customer\'s language', () => {
  it('Russian and Ukrainian readers get the original name, everybody else the English one; a service without an original shows its name', () => {
    const i18n = { ru: 'Просмотры постов Telegram' }
    expect(localizedName('Telegram Post Views', i18n, 'ru')).toBe('Просмотры постов Telegram')
    expect(localizedName('Telegram Post Views', i18n, 'uk')).toBe('Просмотры постов Telegram')
    expect(localizedName('Telegram Post Views', i18n, 'en')).toBe('Telegram Post Views')
    expect(localizedName('Telegram Post Views', i18n, 'ja')).toBe('Telegram Post Views')
    expect(localizedName('My own service', undefined, 'ru')).toBe('My own service')
    expect(localizedName('My own service', {}, 'ru')).toBe('My own service')
  })

  it('a description is built from the facts, one line each, in English by default', () => {
    expect(describeService({ refill: 30, startMin: 0, startMax: 0, speed: 50_000, drop: 'low', real: true, geo: ['US', 'DE'] }, 'en-US')).toEqual([
      'Refill guarantee: 30 days',
      'Starts instantly',
      'Speed: up to 50K per day',
      'Low drop rate',
      'Real accounts',
      'Countries: United States, Germany',
    ])
  })

  it('every refill, start, drop and speed fact has its line', () => {
    expect(describeService({ refill: 'none' }, 'en-US')).toEqual(['No refill guarantee'])
    expect(describeService({ refill: 'lifetime' }, 'en-US')).toEqual(['Lifetime refill guarantee'])
    expect(describeService({ startMin: 0, startMax: 60 }, 'en-US')).toEqual(['Starts within 1 hour'])
    expect(describeService({ startMin: 15, startMax: 30 }, 'en-US')).toEqual(['Starts within 30 minutes'])
    expect(describeService({ startMax: 4320 }, 'en-US')).toEqual(['Starts within 3 days'])
    expect(describeService({ drop: 'none' }, 'en-US')).toEqual(['No drops'])
    expect(describeService({ drop: 'high' }, 'en-US')).toEqual(['High drop rate'])
    expect(describeService({ speed: 2_000_000 }, 'en-US')).toEqual(['Speed: up to 2M per day'])
  })

  it('says nothing when the panel gave no facts', () => {
    expect(describeService(undefined, 'en-US')).toEqual([])
    expect(describeService({}, 'en-US')).toEqual([])
  })

  it('the same facts read in another language: text, numbers, units and country names', async () => {
    await setLanguage('ru', { persist: false })
    const ru = describeService({ refill: 30, startMax: 0, geo: ['US', 'DE'] }, 'ru-RU')
    expect(ru[0]).toMatch(/^Гарантия восстановления: 30 дн/)
    expect(ru[1]).toBe('Старт мгновенно')
    expect(ru[2]).toMatch(/^Страны: .+, Германия$/)
    await setLanguage('de', { persist: false })
    expect(describeService({ refill: 'lifetime', drop: 'none' }, 'de-DE')).toEqual(['Lebenslange Auffüllgarantie', 'Keine Abgänge'])
    await setLanguage('ja', { persist: false })
    expect(describeService({ startMax: 0, geo: ['JP'] }, 'ja-JP')).toEqual(['即時開始', '国：日本'])
    await setLanguage('ar', { persist: false })
    expect(describeService({ real: true }, 'ar')).toEqual(['حسابات حقيقية'])
  })

  it('a country code the runtime does not know does not break the line', () => {
    expect(describeService({ geo: ['ZZ'] }, 'en-US')[0]).toMatch(/^Countries: /)
  })
})

// ---------------------------------------------------------------------------
// The screen: platforms -> categories -> services (a page at a time)
// ---------------------------------------------------------------------------
describe('browsing the services', () => {
  let root: Root
  let host: HTMLElement
  let requests: string[]

  const category = (id: string, platform: string, name: string, count: number, sort = 0, nameRu?: string) => ({
    id, name, slug: id, icon_url: null, sort_order: sort, name_i18n: nameRu ? { ru: nameRu } : {}, active_service_count: count, platforms: { slug: platform },
  })
  const service = (id: string, categoryId: string, name: string, rate: number) => ({
    id, category_id: categoryId, name, description: null, customer_rate_per_1000: rate, min_quantity: 10, max_quantity: 1000, refill_supported: false, sort_order: 0,
    name_i18n: { ru: `Оригинал ${name}` }, attributes: { refill: 'none', startMax: 0 },
  })
  const CATEGORIES = [
    category('c-tg-views', 'telegram', 'Telegram Post Views', 75, 1, 'Просмотры постов Telegram'),
    category('c-tg-members', 'telegram', 'Telegram Members', 2, 2),
    category('c-ig', 'instagram', 'Instagram Likes', 1, 3),
  ]
  const MANY = Array.from({ length: 75 }, (_, i) => service(`s-${String(i).padStart(3, '0')}`, 'c-tg-views', `Views ${i}`, 0.01 + i / 1000))

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    const u = new URL(url)
    if (u.pathname.endsWith('/rest/v1/platforms')) return json([{ slug: 'telegram', name: 'Telegram', category: 'messaging', sort_order: 10 }, { slug: 'instagram', name: 'Instagram', category: 'social', sort_order: 20 }, { slug: 'twitch', name: 'Twitch', category: 'video', sort_order: 30 }])
    if (u.pathname.endsWith('/rest/v1/categories')) return json(CATEGORIES)
    if (u.pathname.endsWith('/rest/v1/services')) {
      const cat = u.searchParams.get('category_id')!.replace('eq.', '')
      const offset = Number(u.searchParams.get('offset'))
      const limit = Number(u.searchParams.get('limit'))
      const all = cat === 'c-tg-views' ? MANY : cat === 'c-ig' ? [service('s-ig', 'c-ig', 'Instagram Likes Plain', 1)] : [service('s-m1', cat, 'Members A', 5), service('s-m2', cat, 'Members B', 6)]
      return json(all.slice(offset, offset + limit))
    }
    return new Response('not found', { status: 404 })
  }

  let ServicesScreen: typeof import('../src/components/services/ServicesScreen').ServicesScreen
  // the screen is imported fresh for every test (modules reset), so the language store it reads is the fresh one too
  let setLang: typeof setLanguage
  const session = { token: 'jwt', expiresAt: 0, isMock: false, wallet: { balance: 5, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } }

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    vi.doMock('../src/context/AuthContext', () => ({ useAuth: () => ({ refreshWallet: async () => {}, applyWallet: () => {} }) }))
    vi.doMock('../src/lib/analytics-client', () => ({ track: () => {}, bindAnalytics: () => {} }))
    ;({ ServicesScreen } = await import('../src/components/services/ServicesScreen'))
    ;({ setLanguage: setLang } = await import('../src/i18n'))
    resetLogoFailures()
    requests = []
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('../src/context/AuthContext')
    vi.doUnmock('../src/lib/analytics-client')
  })

  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
  const mount = async () => {
    act(() => root.render(createElement(ServicesScreen, { session, onTopUp: () => {}, onViewOrders: () => {} })))
    await flush()
  }
  const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); act(() => (el as HTMLElement).click()); await flush() }
  const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text) || b.getAttribute('aria-label')?.includes(text))
  const titles = () => [...host.querySelectorAll('h3')].map((h) => h.textContent)

  it('loads only the categories (a few hundred rows) at first, never the services', async () => {
    await mount()
    expect(requests.some((r) => r.includes('/rest/v1/categories'))).toBe(true)
    expect(requests.some((r) => r.includes('/rest/v1/services'))).toBe(false)
    const cat = requests.find((r) => r.includes('/rest/v1/categories'))!
    expect(cat).toContain('active_service_count=gt.0')
    expect(cat).toContain('platforms.active=eq.true')
    expect(cat).toContain('limit=1000')
  })

  it('lists the platforms with the sum of their categories\' services, the busiest first, empty ones after', async () => {
    await mount()
    const rows = [...host.querySelectorAll('li')].map((li) => li.textContent)
    expect(rows[0]).toContain('Telegram')
    expect(rows[0]).toContain('Services: 77') // 75 + 2
    expect(rows[1]).toContain('Instagram')
    expect(rows[2]).toContain('Twitch')
    expect(rows[2]).toContain('No services yet')
  })

  it('a platform with several categories opens a list of categories; a platform with one goes straight to its services', async () => {
    await mount()
    await click(buttonWith('Telegram'))
    expect(host.querySelector('h1')?.textContent).toBe('Telegram')
    const cats = [...host.querySelectorAll('li')].map((li) => li.textContent)
    expect(cats[0]).toContain('Telegram Post Views')
    expect(cats[0]).toContain('Services: 75')
    expect(requests.some((r) => r.includes('/rest/v1/services'))).toBe(false)
    await click(buttonWith('Back to platforms'))
    await click(buttonWith('Instagram'))
    expect(requests.some((r) => r.includes('category_id=eq.c-ig'))).toBe(true)
    expect(titles()).toEqual(['Instagram Likes Plain'])
  })

  it('opening a category loads its first page, cheapest first, and "Show more" loads the next without repeating', async () => {
    await mount()
    await click(buttonWith('Telegram'))
    await click(buttonWith('Telegram Post Views'))
    const first = requests.filter((r) => r.includes('/rest/v1/services'))
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('category_id=eq.c-tg-views')
    expect(first[0]).toContain('is_active=eq.true')
    expect(first[0]).toContain('order=sort_order,customer_rate_per_1000,id')
    expect(first[0]).toContain('limit=30')
    expect(first[0]).toContain('offset=0')
    expect(titles()).toHaveLength(30)
    expect(titles()[0]).toBe('Views 0')

    await click(buttonWith('Show more'))
    expect(requests.filter((r) => r.includes('/rest/v1/services'))[1]).toContain('offset=30')
    expect(titles()).toHaveLength(60)
    await click(buttonWith('Show more'))
    expect(titles()).toHaveLength(75)
    expect(new Set(titles()).size).toBe(75) // no page repeated
    expect(buttonWith('Show more')).toBeUndefined() // the last page was short: nothing more to ask for
  })

  it('"back" goes services -> categories -> platforms', async () => {
    await mount()
    await click(buttonWith('Telegram'))
    await click(buttonWith('Telegram Members'))
    expect(host.querySelector('h1')?.textContent).toBe('Telegram Members')
    await click(buttonWith('Back to categories'))
    expect(host.querySelector('h1')?.textContent).toBe('Telegram')
    await click(buttonWith('Back to platforms'))
    expect(host.querySelector('h1')?.textContent).toBe('Services')
  })

  it('a Russian reader sees the original category and service names, an English reader the English ones', async () => {
    await setLang('ru', { persist: false })
    await mount()
    await click(buttonWith('Telegram'))
    expect([...host.querySelectorAll('li')][0].textContent).toContain('Просмотры постов Telegram')
    await click(buttonWith('Просмотры постов Telegram'))
    expect(titles()[0]).toBe('Оригинал Views 0')
    await act(async () => { await setLang('en', { persist: false }) })
    await flush()
    expect(titles()[0]).toBe('Views 0')
  })

  it('a service of the page can be chosen, and a failed page offers a retry', async () => {
    await mount()
    await click(buttonWith('Instagram'))
    expect(host.querySelector('h3')?.textContent).toBe('Instagram Likes Plain')

    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => (String(input).includes('/rest/v1/services') ? new Response('boom', { status: 500 }) : fakeFetch(input)))
    await click(buttonWith('Back to platforms'))
    await click(buttonWith('Telegram'))
    await click(buttonWith('Telegram Members'))
    expect(host.textContent).toContain("Couldn't load services")
    expect(buttonWith('Retry')).toBeDefined()
  })

  it('an error loading the categories offers a retry', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response('boom', { status: 500 }))
    await mount()
    expect(host.textContent).toContain("Couldn't load services")
    expect(buttonWith('Retry')).toBeDefined()
  })
})
