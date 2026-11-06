// @vitest-environment jsdom
// The landing page a person sees (components/seo/SeoLanding.tsx) and the JSON-LD components. Rendered without the app's shell and without signing in: a
// visitor from a search costs the database nothing, which is checked here by a fetch that must never be called.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonLd, ServiceJsonLd } from '../src/components/seo/JsonLd'
import SeoLanding from '../src/components/seo/SeoLanding'
import { parseLandingSlug, type SeoRoute } from '../src/seo/pages'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const fetchSpy = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubEnv('VITE_TWA_RETURN_URL', 'https://t.me/GHTE_PR_BOT/app')
  document.head.innerHTML = ''
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('dir')
  document.documentElement.lang = 'en'
})

const render = (lang: SeoRoute['lang'], slug: string) => act(() => { root.render(createElement(SeoLanding, { route: { lang, landing: parseLandingSlug(slug)! } })) })

describe('the landing page', () => {
  it('shows the heading, the introduction, what the customer gets, the questions and the two ways in', () => {
    render('en', 'buy-telegram-premium-followers')
    expect(host.querySelector('h1')!.textContent).toBe('Buy Telegram premium followers with TON')
    expect(host.textContent).toContain('prepaid USD balance that you top up with TON')
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['What you get', 'Questions'])
    expect(host.querySelectorAll('section ul li')).toHaveLength(4)
    expect(host.querySelectorAll('dl dt')).toHaveLength(3)
    const links = [...host.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toContainEqual(['Open in Telegram', 'https://t.me/GHTE_PR_BOT'])
    expect(links).toContainEqual(['Open the web app', '/'])
  })

  it('without a bot link only the web button is there, and it is the main one', () => {
    vi.stubEnv('VITE_TWA_RETURN_URL', '')
    render('en', 'crypto-smm-panel')
    const links = [...host.querySelectorAll('a')].map((a) => a.textContent)
    expect(links).not.toContain('Open in Telegram')
    expect(links).toContain('Open the web app')
  })

  it('links to the sibling pages in the same language, and to the same page in the other languages (hreflang)', () => {
    render('ru', 'buy-telegram-followers')
    const hrefs = [...host.querySelectorAll('nav a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/ru/buy-instagram-followers')
    expect(hrefs).not.toContain('/ru/buy-telegram-followers') // not to itself
    expect(hrefs).toContain('/en/buy-telegram-followers')
    expect(hrefs).toContain('/ar/buy-telegram-followers')
    expect(host.querySelector('nav a[hreflang="es"]')!.textContent).toBe('Español')
  })

  it('sets what the browser shows: the title, the description, the canonical address, the language and the direction (Arabic reads right to left)', () => {
    render('ar', 'buy-instagram-real-followers')
    expect(document.title).toBe('شراء متابعين حقيقيين انستقرام بعملة TON | GRAM Hub')
    expect(document.head.querySelector('meta[name="description"]')!.getAttribute('content')).toContain('انستقرام')
    expect(document.head.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe(`${window.location.origin}/ar/buy-instagram-real-followers`)
    expect(document.documentElement.lang).toBe('ar')
    expect(document.documentElement.dir).toBe('rtl')
    expect(host.firstElementChild!.getAttribute('dir')).toBe('rtl')
  })

  it('carries the structured data of the page as JSON-LD, valid, with no price', () => {
    render('es', 'buy-instagram-followers')
    const blocks = [...host.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent!))
    expect(blocks.map((b) => b['@type'])).toEqual(['Organization', 'Product', 'FAQPage'])
    expect(blocks[1].name).toBe('Comprar seguidores de Instagram con TON')
    expect(blocks[1].offers).toBeUndefined()
  })

  it('costs the database nothing: not one request is made to draw it', () => {
    render('en', 'buy-tiktok-views')
    render('uk', 'smm-panel-for-agencies')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('JSON-LD components', () => {
  it('JsonLd writes the data into a script of type application/ld+json, escaped so that nothing can close it', () => {
    act(() => { root.render(createElement(JsonLd, { data: { name: '</script><b>x</b>' } })) })
    const s = host.querySelector('script[type="application/ld+json"]')!
    expect(s.textContent).not.toContain('</script>')
    expect(JSON.parse(s.textContent!).name).toBe('</script><b>x</b>')
    expect(host.querySelector('b')).toBeNull()
  })

  it('ServiceJsonLd is a Product with an Offer of the service\'s real price per 1,000', () => {
    act(() => { root.render(createElement(ServiceJsonLd, { service: { name: 'Instagram Followers [Refill: 30 Days]', sku: 'IG-FOL-HQ-3F9A1C', platformName: 'Instagram', ratePer1000: 1.82, minQuantity: 50, maxQuantity: 200_000 } })) })
    const ld = JSON.parse(host.querySelector('script')!.textContent!)
    expect(ld).toMatchObject({ '@type': 'Product', sku: 'IG-FOL-HQ-3F9A1C', offers: { price: '1.82', priceCurrency: 'USD' } })
  })
})
