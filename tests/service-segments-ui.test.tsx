// @vitest-environment jsdom
// The segment chips of the storefront: premium / with guarantee / safe growth. The cards carry them, a chip under the search field shows only the cards of
// that kind (with or without words typed), tapping it again shows all, and leaving the platform clears it.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSegments, segmentParam, segmentsFromRow } from '../src/lib/segments'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('reading the segments of a row', () => {
  it('keeps the known ones, once each, in the order of the chips; anything else is nothing', () => {
    expect(segmentsFromRow(['safe', 'premium', 'premium', 'nonsense'])).toEqual(['premium', 'safe'])
    expect(segmentsFromRow([])).toEqual([])
    expect(segmentsFromRow(null)).toEqual([])
    expect(segmentsFromRow('premium')).toEqual([])
  })
  it('asks the database for "contains"', () => {
    expect(decodeURIComponent(segmentParam('premium'))).toBe('segments=cs.{premium}')
  })
  it('the offline catalogue reads a name roughly like the database does', () => {
    expect(mockSegments('Instagram Followers [Real, Refill 30D]')).toEqual(['premium', 'guaranteed'])
    expect(mockSegments('Instagram Followers [Fast, No Refill]')).toEqual([])
    expect(mockSegments('Telegram Post Views [Instant]')).toEqual([])
  })
})

describe('the API client', () => {
  const rows = [{ id: 's1', category_id: 'c1', name: 'Instagram Followers | HQ', description: null, customer_rate_per_1000: '1.2', min_quantity: 10, max_quantity: 1000, refill_supported: false, sort_order: 1, segments: ['safe', 'premium'] }]
  beforeEach(() => { vi.resetModules(); vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon') })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const session = { token: 't', expiresAt: 0, isMock: false } as never

  it('a card carries its segments only when it has some, and the app reads the column', async () => {
    const { serviceFromRow, SERVICE_COLUMNS } = await import('../src/services/api/services')
    expect(SERVICE_COLUMNS).toContain('segments')
    expect(serviceFromRow(rows[0]!).segments).toEqual(['premium', 'safe'])
    expect(serviceFromRow({ ...rows[0]!, segments: [] })).not.toHaveProperty('segments')
    expect(serviceFromRow({ ...rows[0]!, segments: undefined })).not.toHaveProperty('segments')
  })

  it('a segment alone is a search (no words filter), with words both apply, and without either nothing is asked', async () => {
    const { searchServices } = await import('../src/services/api/services')
    const { parseServiceQuery } = await import('../src/lib/service-search')
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(decodeURIComponent(url)); return new Response(JSON.stringify(rows), { status: 200 }) }))
    expect(await searchServices(session, ['c1'], [], 0, 30, 'premium')).toHaveLength(1)
    expect(urls[0]).toContain('segments=cs.{premium}')
    expect(urls[0]).not.toContain('&and=')
    expect(urls[0]).toContain('category_id=in.(c1)')
    await searchServices(session, ['c1'], parseServiceQuery('followers'), 0, 30, 'safe')
    expect(urls[1]).toContain('&and=(or(name.ilike.*followers*')
    expect(urls[1]).toContain('segments=cs.{safe}')
    await searchServices(session, ['c1'], parseServiceQuery('followers'), 0, 30)
    expect(urls[2]).not.toContain('segments=')
    expect(await searchServices(session, ['c1'], [], 0, 30, null)).toEqual([])
    expect(urls).toHaveLength(3)
  })
})

describe('the chips on the services screen (offline catalogue)', () => {
  let host: HTMLElement
  let root: Root
  let ServicesScreen: typeof import('../src/components/services/ServicesScreen').ServicesScreen
  const session = { token: '', expiresAt: 0, isMock: true, wallet: { balance: 5, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } } as never

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../src/context/AuthContext', () => ({ useAuth: () => ({ refreshWallet: async () => {}, applyWallet: () => {} }) }))
    vi.doMock('../src/lib/analytics-client', () => ({ track: () => {}, bindAnalytics: () => {} }))
    ;({ ServicesScreen } = await import('../src/components/services/ServicesScreen'))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.doUnmock('../src/context/AuthContext')
    vi.doUnmock('../src/lib/analytics-client')
  })

  const wait = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  const click = async (el: Element | null | undefined, ms = 400) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await wait(ms) }
  const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  const chip = (label: string) => host.querySelector(`[data-testid="segment-chips"] button[aria-pressed]:not([hidden])`) && [...host.querySelectorAll('[data-testid="segment-chips"] button')].find((b) => b.textContent?.includes(label))
  const titles = () => [...host.querySelectorAll('h3')].map((h) => h.textContent)
  const open = async () => {
    await act(async () => { root.render(createElement(ServicesScreen, { session, onViewOrders: () => {} })) })
    await wait(20)
    await click(buttonWith('Telegram'), 20)
  }

  it('no chips before a platform is opened; inside one, three chips under the search field', async () => {
    await act(async () => { root.render(createElement(ServicesScreen, { session, onViewOrders: () => {} })) })
    await wait(20)
    expect(host.querySelector('[data-testid="segment-chips"]')).toBeNull()
    await click(buttonWith('Telegram'), 20)
    const group = host.querySelector('[data-testid="segment-chips"]')!
    expect(group.getAttribute('aria-label')).toBe('Filter by type')
    expect([...group.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Premium', 'With guarantee', 'Safe growth'])
  })

  it('a chip lists only the cards of that kind, a second tap brings the categories back', async () => {
    await open()
    expect(titles()).toEqual([]) // categories, not services
    await click(chip('Premium'))
    expect(chip('Premium')?.getAttribute('aria-pressed')).toBe('true')
    expect(titles()).toEqual(['Telegram Post Views [Real, 30 Days]'])
    await click(chip('With guarantee'))
    expect(chip('Premium')?.getAttribute('aria-pressed')).toBe('false')
    expect(titles()).toEqual(['Telegram Channel Members [Non-Drop 30D]'])
    await click(chip('With guarantee'))
    expect(titles()).toEqual([])
    expect(host.textContent).toContain('Telegram Views') // the categories are back
  })

  it('a chip and words together narrow the list; nothing of that kind says so', async () => {
    await open()
    await click(chip('Premium'))
    const input = host.querySelector('input[type="search"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'members'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await wait(400)
    expect(titles()).toEqual([])
    expect(host.textContent).toContain('No services found')
  })

  it('the cards show what their name says: a premium card says so, the guarantee is not said twice', async () => {
    await open()
    await click(chip('Premium'))
    const card = host.querySelector('[data-testid="service-badges"]')!
    expect(card.textContent).toContain('Premium')
    await click(chip('With guarantee'))
    const badges = host.querySelector('[data-testid="service-badges"]')!.textContent ?? ''
    expect(badges).toContain('Refill') // the badge of the refill ...
    expect(badges).not.toContain('With guarantee') // ... and not a second one for the same promise
  })

  it('leaving the platform clears the chip', async () => {
    await open()
    await click(chip('Premium'))
    await click(host.querySelector('button[aria-label="Back to platforms"]'), 20)
    await click(buttonWith('Telegram'), 20)
    expect(chip('Premium')?.getAttribute('aria-pressed')).toBe('false')
  })
})
