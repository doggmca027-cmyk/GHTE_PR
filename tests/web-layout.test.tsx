// @vitest-environment jsdom
// The website (a browser) gets a full-width layout with a top navigation bar; the Telegram Mini App keeps its phone screen untouched.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Layout } from '../src/components/layout/Layout'
import { LayoutModeContext, layoutModeFor, sheetOverlayClass, sheetPanelClass } from '../src/lib/layout-mode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const props = (over: Record<string, unknown> = {}) => ({ activeTab: 'home' as const, onTabChange: vi.fn(), balance: 3, currency: 'USD', children: createElement('p', null, 'page'), ...over })
const render = (mode: 'app' | 'web' | null, over: Record<string, unknown> = {}) => {
  const layout = createElement(Layout, props(over))
  act(() => root.render(mode ? createElement(LayoutModeContext.Provider, { value: mode }, layout) : layout))
}

describe('which layout', () => {
  it('inside Telegram the Mini App, in a browser the website', () => {
    expect(layoutModeFor(true)).toBe('app')
    expect(layoutModeFor(false)).toBe('web')
  })

  it('the Mini App (and anything rendered without a mode) keeps the phone screen: the 430 px frame and the bottom tab bar, no website parts', () => {
    for (const mode of ['app', null] as const) {
      render(mode)
      expect(host.querySelector('[data-layout="web"]')).toBeNull()
      expect(host.querySelector('.max-w-\\[430px\\]')).not.toBeNull()
      expect(host.querySelector('footer')).toBeNull()
      expect(host.querySelectorAll('nav')).toHaveLength(1) // the tab bar only
    }
  })

  it('the website: full width, sections in the top bar (FAQ included), language and theme there, a footer with the documents', () => {
    render('web')
    expect(host.querySelector('[data-layout="web"]')).not.toBeNull()
    expect(host.querySelector('.max-w-\\[430px\\]')).toBeNull()
    expect(host.querySelector('main')?.className).toContain('max-w-[1320px]')
    const top = [...host.querySelectorAll('header nav button')].map((b) => b.textContent?.trim())
    expect(top).toEqual(['Home', 'Service catalog', 'Orders', 'Wallet', 'Support', 'FAQ'])
    expect(host.querySelector('header select[aria-label="Language"]')).not.toBeNull()
    expect([...host.querySelectorAll('footer a')].map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/terms', '/privacy', '/terms#orders']))
    expect(host.querySelector('footer')?.textContent).toContain(`© ${new Date().getFullYear()} GRAM Hub`)
  })

  it('a guest on the website signs in from the top right; a customer sees the balance there', () => {
    const onSignIn = vi.fn()
    render('web', { guest: true, onSignIn })
    act(() => (host.querySelector('[data-testid="header-sign-in"]') as HTMLButtonElement).click())
    expect(onSignIn).toHaveBeenCalledTimes(1)
    render('web', { guest: false })
    expect(host.querySelector('[data-testid="header-sign-in"]')).toBeNull()
    expect(host.querySelector('header')?.textContent).toContain('$3')
  })

  it('the top bar changes the tab', () => {
    const onTabChange = vi.fn()
    render('web', { onTabChange })
    act(() => ([...host.querySelectorAll('header nav button')][1] as HTMLButtonElement).click())
    expect(onTabChange).toHaveBeenCalledWith('services')
  })
})

describe('scrolling', () => {
  it('a new tab opens at its top: the Mini App\'s scrolling screen is reset (it stayed down past the content of the new tab)', () => {
    render('app', { activeTab: 'services' })
    const main = host.querySelector('main[data-scroll-root]') as HTMLElement
    main.scrollTop = 900
    expect(main.scrollTop).toBe(900)
    render('app', { activeTab: 'home' })
    expect((host.querySelector('main[data-scroll-root]') as HTMLElement).scrollTop).toBe(0)
  })
})

describe('sheets', () => {
  it('in the app a bottom sheet inside the phone frame (as before); on the website a dialog fixed over the page', () => {
    expect(sheetOverlayClass(false)).toBe('absolute inset-0 z-50 flex items-end animate-fade-in')
    expect(sheetPanelClass(false)).toBe('')
    expect(sheetOverlayClass(true)).toContain('fixed inset-0')
    expect(sheetPanelClass(true)).toContain('sm:max-w-xl')
  })
})
