// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformList } from '../src/components/services/PlatformList'
import { resetLogoFailures } from '../src/lib/platform-logo'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PLATFORMS = [
  { slug: 'telegram', name: 'Telegram', count: 4 },
  { slug: 'instagram', name: 'Instagram', count: 2 },
  { slug: 'vk', name: 'VK', count: 0 },
  { slug: 'youtube', name: 'YouTube', count: 0 },
  { slug: 'tiktok', name: 'TikTok', count: 1 },
  { slug: 'twitter', name: 'X (Twitter)', count: 0 },
  { slug: 'website', name: 'Website Traffic', count: 0 },
]

let root: Root
let host: HTMLElement
let selected: string[]

beforeEach(() => {
  resetLogoFailures()
  selected = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const mount = (platforms = PLATFORMS) => act(() => root.render(createElement(PlatformList, { platforms, onSelect: (s: string) => selected.push(s) })))
const rows = () => [...host.querySelectorAll('li')].map((li) => li.querySelector('span.truncate')?.textContent)
const input = () => host.querySelector('input[type="search"]') as HTMLInputElement
const type = (value: string) => act(() => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  set.call(input(), value)
  input().dispatchEvent(new Event('input', { bubbles: true }))
})
const badge = (name: string): HTMLElement => {
  const el = [...host.querySelectorAll('li')].find((li) => li.querySelector('span.truncate')?.textContent === name)?.querySelector('span[data-logo]')
  if (!el) throw new Error(`no row named ${name}`)
  return el as HTMLElement
}
const imgOf = (name: string) => badge(name).querySelector('img') as HTMLImageElement | null
const fire = (el: Element, type: 'load' | 'error') => act(() => void el.dispatchEvent(new Event(type)))

describe('the sticky search bar', () => {
  it('is stuck to the top of the scrolling screen, above the list, with a background that matches the screen', () => {
    mount()
    const bar = host.querySelector('[data-testid="platform-search"]') as HTMLElement
    expect(bar.className).toContain('sticky')
    expect(bar.className).toContain('top-0')
    expect(bar.className).toContain('z-10')
    expect(bar.className).toMatch(/bg-\[#EDF4FD\]/)
    expect(bar.contains(input())).toBe(true)
    expect(bar.compareDocumentPosition(host.querySelector('ul')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // touch friendly: a 16 px font (iOS does not zoom the page on focus) and a tall field
    expect(input().className).toContain('text-[16px]')
    expect(input().className).toContain('h-12')
  })

  it('shows every platform with no query', () => {
    mount()
    expect(rows()).toEqual(['Telegram', 'Instagram', 'VK', 'YouTube', 'TikTok', 'X (Twitter)', 'Website Traffic'])
  })

  it('filters while typing, in memory: no request of any kind is made', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    mount()
    type('you')
    expect(rows()).toEqual(['YouTube'])
    type('t')
    expect(rows()).toContain('Telegram')
    type('zzzzzz')
    expect(rows()).toEqual([])
    expect(host.textContent).toContain('No platforms found')
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it.each([
    ['tg', 'Telegram'], ['телега', 'Telegram'], ['ig', 'Instagram'], ['инста', 'Instagram'],
    ['vk', 'VK'], ['вк', 'VK'], ['yt', 'YouTube'], ['ютуб', 'YouTube'], ['tt', 'TikTok'], ['тикток', 'TikTok'], ['сайт', 'Website Traffic'],
  ])('the alias "%s" puts %s first', (alias, name) => {
    mount()
    type(alias)
    expect(rows()[0]).toBe(name)
  })

  it('has a clear button that appears only with text, empties the field and restores the whole list', () => {
    mount()
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull()
    type('tg')
    const clear = host.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement
    expect(clear).not.toBeNull()
    act(() => clear.click())
    expect(input().value).toBe('')
    expect(rows()).toHaveLength(PLATFORMS.length)
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull()
  })

  it('tapping a found platform selects it', () => {
    mount()
    type('телега')
    act(() => (host.querySelector('li button') as HTMLButtonElement).click())
    expect(selected).toEqual(['telegram'])
  })
})

describe('the platform logos', () => {
  it('ask the SimpleIcons CDN lazily, without a referrer, and start hidden behind the coloured tile with initials', () => {
    mount()
    const img = imgOf('Telegram')!
    expect(img.getAttribute('src')).toBe('https://cdn.simpleicons.org/telegram')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.className).toContain('opacity-0')
    const tile = badge('Telegram')
    expect(tile.dataset.logo).toBe('loading')
    expect(tile.textContent).toBe('TE') // the initials show until the logo has arrived
    expect(tile.style.backgroundColor).not.toBe('')
  })

  it('once the logo has loaded it replaces the initials on a white tile', () => {
    mount()
    fire(imgOf('Telegram')!, 'load')
    const tile = badge('Telegram')
    expect(tile.dataset.logo).toBe('loaded')
    expect(tile.textContent).toBe('')
    expect(imgOf('Telegram')!.className).not.toContain('opacity-0')
    expect(tile.style.backgroundColor).toMatch(/^(#fff|#ffffff|rgb\(255, 255, 255\))$/i)
  })

  it('FALLBACK: if the CDN fails (offline, blocked, 404) the image is removed and the coloured initials tile stays', () => {
    mount()
    const img = imgOf('Instagram')!
    fire(img, 'error')
    const tile = badge('Instagram')
    expect(tile.dataset.logo).toBe('failed')
    expect(tile.querySelector('img')).toBeNull()
    expect(tile.textContent).toBe('IN')
    expect(tile.style.backgroundColor).not.toMatch(/255, 255, 255|#fff/i)
  })

  it('one failure does not touch the other platforms', () => {
    mount()
    fire(imgOf('Instagram')!, 'error')
    expect(badge('Instagram').dataset.logo).toBe('failed')
    expect(badge('TikTok').dataset.logo).toBe('loading')
    expect(imgOf('TikTok')).not.toBeNull()
  })

  it('a failed logo is not asked for again when the list is shown again (search, new screen)', () => {
    mount()
    fire(imgOf('VK')!, 'error')
    act(() => root.unmount())
    root = createRoot(host)
    mount()
    expect(badge('VK').dataset.logo).toBe('failed')
    expect(imgOf('VK')).toBeNull()
    expect(imgOf('Telegram')).not.toBeNull() // the others are still tried
  })

  it('a platform that is not a brand makes no request and shows its tile at once', () => {
    mount()
    expect(imgOf('Website Traffic')).toBeNull()
    expect(badge('Website Traffic').dataset.logo).toBe('failed')
    expect(badge('Website Traffic').textContent).toBe('WT')
  })

  it('X (Twitter) asks for the "x" logo, the name SimpleIcons uses', () => {
    mount()
    expect(imgOf('X (Twitter)')!.getAttribute('src')).toBe('https://cdn.simpleicons.org/x')
  })

  it('a loaded logo survives filtering (the row stays mounted) and a failed one stays failed', () => {
    mount()
    fire(imgOf('YouTube')!, 'load')
    fire(imgOf('Telegram')!, 'error')
    type('t') // keeps Telegram and YouTube in the list
    expect(rows()).toContain('Telegram')
    expect(badge('Telegram').dataset.logo).toBe('failed')
    type('')
    expect(badge('YouTube').dataset.logo).toBe('loaded')
  })
})
