// @vitest-environment jsdom
// An article number (SKU) typed or pasted into ANY search box of the catalogue finds its card across all categories and platforms with one exact
// request, and the assistant can send one there from any screen.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skuFromQuery } from '../src/lib/service-search'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('what looks like an article', () => {
  it.each([
    ['IG-FOL-STD-ROOT89336', 'IG-FOL-STD-ROOT89336'],
    ['  ig-fol-std-root89336  ', 'IG-FOL-STD-ROOT89336'],
    ['**TT-LIKE-HQ-SEC12787**', 'TT-LIKE-HQ-SEC12787'],
    ['[YT-VIEW-CHEAP-MTP5760] please', 'YT-VIEW-CHEAP-MTP5760'],
    ['TG-MEM-STD-JAP7158-A1DD', 'TG-MEM-STD-JAP7158-A1DD'],
    ['OTH-OTH-STD-SECAB12', 'OTH-OTH-STD-SECAB12'],
    ['TWH-LIVE-HQ-SEC4', 'TWH-LIVE-HQ-SEC4'],
  ])('%s -> %s', (text, sku) => {
    expect(skuFromQuery(text)).toBe(sku)
  })

  it.each(['instagram followers', 'non-drop real-time', 'ig-fol', 'IG-FOL-', 'IG-FOL-STD', 'IG-FOL-STD-', 'cheap 30-day refill', '', '   '])('"%s" is words, not an article', (text) => {
    expect(skuFromQuery(text)).toBeNull()
  })
})

describe('looking an article up', () => {
  const SKU = 'IG-FOL-STD-ROOT89336'
  let host: HTMLElement
  let root: Root
  let requests: string[]
  let skuAnswer: (sku: string) => Response
  let ScreenModule: typeof import('../src/components/services/ServicesScreen')

  const category = (id: string, platform: string, name: string, count: number, sort = 0) => ({
    id, name, slug: id, icon_url: null, sort_order: sort, name_i18n: {}, active_service_count: count, platforms: { slug: platform },
  })
  const card = (id: string, name: string, rate: number) => ({
    id, category_id: 'c-ig', name, description: null, customer_rate_per_1000: rate, min_quantity: 10, max_quantity: 1000, refill_supported: true, sort_order: 0,
    name_i18n: {}, attributes: { refill: 30 },
  })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const found = (sku: string) => json([{ ...card('s-found', `Instagram Followers (${sku})`, 0.9828), category: { platform: { slug: 'instagram', name: 'Instagram' } } }])

  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    requests.push(decodeURIComponent(url))
    const u = new URL(url)
    if (u.pathname.endsWith('/rest/v1/platforms')) return json([{ slug: 'telegram', name: 'Telegram', category: 'messaging', sort_order: 10 }, { slug: 'instagram', name: 'Instagram', category: 'social', sort_order: 20 }])
    if (u.pathname.endsWith('/rest/v1/categories')) return json([category('c-tg', 'telegram', 'Telegram Members', 5, 1), category('c-tg2', 'telegram', 'Telegram Views', 5, 2), category('c-ig', 'instagram', 'Instagram Followers', 1, 3)])
    if (u.pathname.endsWith('/rest/v1/services')) {
      const sku = /sku=eq\.([A-Z0-9-]+)/.exec(decodeURIComponent(url))?.[1]
      if (sku) return skuAnswer(sku)
      return json([])
    }
    return new Response('not found', { status: 404 })
  }

  const session = { token: 'jwt', expiresAt: 0, isMock: false, wallet: { balance: 5, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } }

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    vi.doMock('../src/context/AuthContext', () => ({ useAuth: () => ({ refreshWallet: async () => {}, applyWallet: () => {} }) }))
    vi.doMock('../src/lib/analytics-client', () => ({ track: () => {}, bindAnalytics: () => {} }))
    vi.doMock('../src/components/services/OrderModal', () => ({ OrderModal: (p: { service: { name: string }; platform: string; platformName?: string }) => createElement('div', { role: 'dialog', 'data-platform': p.platform, 'data-platform-name': p.platformName }, `order ${p.service.name}`) }))
    ScreenModule = await import('../src/components/services/ServicesScreen')
    requests = []
    skuAnswer = (sku) => found(sku)
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
    vi.doUnmock('../src/components/services/OrderModal')
  })

  const wait = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  const mount = async (props: Record<string, unknown> = {}) => {
    await act(async () => { root.render(createElement(ScreenModule.ServicesScreen, { session, onViewOrders: () => {}, ...props } as never)) })
    await wait(30)
  }
  const click = async (el: Element | null | undefined, ms = 30) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await wait(ms) }
  const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  const type = async (value: string, ms = 400) => {
    const input = host.querySelector('input[type="search"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await wait(ms)
  }
  const skuRequests = () => requests.filter((r) => r.includes('sku=eq.'))
  const titles = () => [...host.querySelectorAll('h3')].map((h) => h.textContent)

  it('typed at the top of the catalogue: one exact request over the whole catalogue (no category, no words), and the card instead of the platforms', async () => {
    await mount()
    expect(host.querySelector('input[type="search"]')?.getAttribute('placeholder')).toBe('Search platforms or SKU')
    expect(host.textContent).toContain('Telegram')
    await type(SKU)
    expect(skuRequests()).toHaveLength(1)
    const q = skuRequests()[0]!
    expect(q).toContain(`sku=eq.${SKU}`)
    expect(q).toContain('is_active=eq.true')
    expect(q).toContain('category.platform.active=eq.true')
    expect(q).not.toContain('category_id=in.')
    expect(q).not.toContain('ilike')
    expect(titles()).toEqual([`Instagram Followers (${SKU})`])
    expect(host.querySelector('[data-testid="sku-result"]')?.textContent).toContain(`Article number ${SKU}`)
    expect(host.textContent).not.toContain('Telegram') // the platform list gave way to the card
    // clearing the box brings the platforms back
    await click(host.querySelector('button[aria-label="Clear search"]'))
    expect(host.querySelector('[data-testid="sku-result"]')).toBeNull()
    expect(host.textContent).toContain('Telegram')
  })

  it('pasted with the decoration of the assistant\'s answer, in lower case: the same lookup', async () => {
    await mount()
    await type(`**${SKU.toLowerCase()}**`)
    expect(skuRequests().map((r) => /sku=eq\.([A-Z0-9-]+)/.exec(r)?.[1])).toEqual([SKU])
  })

  it('typed inside a platform, the card of ANOTHER platform is found, and the order form opens on its own platform', async () => {
    await mount()
    await click(buttonWith('Telegram'))
    await click(buttonWith('Telegram Members')) // into a category: the box now searches this one
    await type(SKU)
    expect(skuRequests()).toHaveLength(1)
    expect(skuRequests()[0]).not.toContain('category_id=in.') // not limited to the category open
    expect(requests.filter((r) => r.includes('/rest/v1/services') && r.includes('ilike'))).toEqual([]) // and not a words search either
    expect(titles()).toEqual([`Instagram Followers (${SKU})`])
    await click(host.querySelector('h3')!.closest('button'))
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('data-platform')).toBe('instagram')
    expect(dialog.getAttribute('data-platform-name')).toBe('Instagram')
    expect(dialog.textContent).toContain(SKU)
  })

  it('words are still words: no article lookup, the normal search runs', async () => {
    await mount()
    await click(buttonWith('Telegram'))
    await click(buttonWith('Telegram Members'))
    await type('non-drop followers')
    expect(skuRequests()).toEqual([])
    expect(requests.some((r) => r.includes('ilike'))).toBe(true)
  })

  it('an article nobody has says so; the same article again is answered from memory', async () => {
    skuAnswer = () => json([])
    await mount()
    await type('IG-FOL-STD-ROOT00000')
    expect(host.textContent).toContain('No service with this article number')
    expect(host.textContent).toContain('Check the number or ask the AI assistant.')
    await type('')
    await type('IG-FOL-STD-ROOT00000')
    expect(host.textContent).toContain('No service with this article number')
    expect(skuRequests()).toHaveLength(1)
  })

  it('a failed lookup offers to retry, and the retry asks again', async () => {
    let fail = true
    skuAnswer = (sku) => (fail ? json({ message: 'boom' }, 500) : found(sku))
    await mount()
    await type(SKU)
    expect(host.querySelector('[data-testid="sku-result"]')?.textContent).toContain("Couldn't load services")
    fail = false
    await click(buttonWith('Retry'), 400)
    expect(titles()).toEqual([`Instagram Followers (${SKU})`])
    expect(skuRequests()).toHaveLength(2)
  })

  it('an article the assistant sent starts the catalogue at the top with it in the box; a newer request replaces it, another screen forgets it', async () => {
    await mount({ lookupRequest: { sku: SKU, nonce: 1 } })
    await wait(400)
    expect((host.querySelector('input[type="search"]') as HTMLInputElement).value).toBe(SKU)
    expect(titles()).toEqual([`Instagram Followers (${SKU})`])
    skuAnswer = (sku) => found(sku)
    await mount({ lookupRequest: { sku: 'TT-LIKE-HQ-SEC12787', nonce: 2 } })
    await wait(400)
    expect((host.querySelector('input[type="search"]') as HTMLInputElement).value).toBe('TT-LIKE-HQ-SEC12787')
    expect(skuRequests().map((r) => /sku=eq\.([A-Z0-9-]+)/.exec(r)?.[1])).toEqual([SKU, 'TT-LIKE-HQ-SEC12787'])
  })
})
