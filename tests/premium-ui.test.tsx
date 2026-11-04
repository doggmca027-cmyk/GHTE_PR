// @vitest-environment jsdom
// The two-level catalogue as the customer meets it: Premium cards come first (nothing is hidden), wear a 💎 badge and a gold frame, and the
// database is asked for the same order.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceCard } from '../src/components/services/ServiceCard'
import { SERVICE_COLUMNS, fetchCategoryServices, searchServices, serviceFromRow } from '../src/services/api/services'
import { parseServiceQuery } from '../src/lib/service-search'
import { MOCK_CATALOG } from '../src/constants/dev'
import type { ICatalogService } from '../src/types/catalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (over: Record<string, unknown> = {}) => ({ id: 's1', category_id: 'c1', name: 'Instagram Followers', description: null, customer_rate_per_1000: '1.2', min_quantity: 10, max_quantity: 1000, refill_supported: false, sort_order: 10, ...over })

describe('the flag on the card', () => {
  it('the app reads the column, and only a true flag marks the card', () => {
    expect(SERVICE_COLUMNS).toContain('is_premium')
    expect(serviceFromRow(row({ is_premium: true })).isPremium).toBe(true)
    for (const is_premium of [false, null, undefined]) expect(serviceFromRow(row({ is_premium }))).not.toHaveProperty('isPremium')
  })
})

describe('the order of the list', () => {
  beforeEach(() => { vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon') })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('a category and a search ask the database for Premium first, then the usual order', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(decodeURIComponent(url)); return new Response('[]', { status: 200 }) }))
    const session = { token: 't', expiresAt: 0, isMock: false } as never
    await fetchCategoryServices(session, 'c1')
    await searchServices(session, ['c1'], parseServiceQuery('followers'))
    for (const url of urls) expect(url).toContain('order=is_premium.desc,sort_order,customer_rate_per_1000,id')
    expect(urls).toHaveLength(2)
  })

  it('the offline catalogue sorts the same way and hides nothing', async () => {
    const session = { token: '', expiresAt: 0, isMock: true } as never
    for (const category of MOCK_CATALOG.categories) {
      const all = MOCK_CATALOG.services.filter((s) => s.categoryId === category.id)
      const listed = await fetchCategoryServices(session, category.id, 0, 1000)
      expect(listed).toHaveLength(all.length)
      const flags = listed.map((s) => s.isPremium === true)
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)))
    }
  })
})

describe('the card', () => {
  let host: HTMLElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })
  const service = (over: Partial<ICatalogService> = {}): ICatalogService => ({ id: 's1', categoryId: 'c1', name: 'Instagram Followers | Real | Refill 30D', description: null, ratePer1000: 3, minQuantity: 10, maxQuantity: 1000, refillSupported: true, sortOrder: 1, ...over })
  const draw = async (s: ICatalogService) => { await act(async () => { root.render(createElement(ServiceCard, { service: s, platform: 'instagram', onSelect: () => {} })) }) }

  it('a Premium card wears the 💎 badge (once, first) and a gold frame', async () => {
    await draw(service({ isPremium: true, segments: ['premium', 'guaranteed'] }))
    const button = host.querySelector('button')!
    expect(button.getAttribute('data-premium')).toBe('true')
    expect(button.className).toContain('border-amber-300')
    const badges = host.querySelector('[data-testid="service-badges"]')!
    expect(badges.textContent!.match(/💎/g)).toHaveLength(1)
    expect(badges.firstElementChild!.textContent).toContain('Premium')
    expect(badges.textContent!.match(/Premium/g)).toHaveLength(1) // the segment badge does not repeat it
  })

  it('a card of the mass market looks as it did', async () => {
    await draw(service({ name: 'Instagram Followers', refillSupported: false }))
    const button = host.querySelector('button')!
    expect(button.getAttribute('data-premium')).toBeNull()
    expect(button.className).not.toContain('amber')
    expect(host.textContent).not.toContain('💎')
  })
})
