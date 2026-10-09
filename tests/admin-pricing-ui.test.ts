// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { token: 't', expiresAt: 0, isMock: true, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'ru', isAdmin: true } } as never

describe('admin: prices and promo codes (dev mock, jsdom)', () => {
  let host: HTMLElement
  let root: Root

  const flush = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
  const mount = async (load: () => Promise<Record<string, unknown>>, name: string) => {
    const mod = await load()
    await act(async () => { root.render(createElement(mod[name] as never, { session })) })
    await flush(20)
  }
  const buttonWith = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  const typeInto = async (el: Element | null | undefined, value: string) => {
    if (!el) throw new Error('no input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  beforeEach(() => {
    vi.resetModules()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('pricing: lists the services, searches, and applies a markup to a whole platform', async () => {
    await mount(() => import('../src/components/admin/PricingTab'), 'PricingTab')
    expect(host.textContent).toContain('Наценка на группу услуг')
    expect(host.textContent).toContain('Telegram Channel Members')
    expect(host.textContent).toContain('TikTok Views')

    await typeInto(host.querySelector('input[aria-label="Поиск услуги"]'), 'instagram')
    await flush(400)
    expect(host.textContent).toContain('Instagram Followers')
    expect(host.textContent).not.toContain('TikTok Views')

    // everything: +100%
    await typeInto(host.querySelector('input[inputmode="decimal"]'), '100')
    expect(host.textContent).toContain('Услуга с закупкой $1.00 за 1000 будет продаваться за $2.00')
    await act(async () => { buttonWith('Применить наценку')!.click() })
    await flush(20)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Наценка сохранена (все услуги): пересчитано цен — 3')
  })

  it('pricing: the button stays off until the scope and the number are valid', async () => {
    await mount(() => import('../src/components/admin/PricingTab'), 'PricingTab')
    const apply = () => buttonWith('Применить наценку') as HTMLButtonElement
    expect(apply().disabled).toBe(true)
    await act(async () => { buttonWith('Платформа')!.click() })
    await typeInto(host.querySelector('input[inputmode="decimal"]'), '50')
    expect(apply().disabled).toBe(true) // a platform is not chosen yet
  })

  it('promo codes: create one (generated code), see it in the list, switch it off', async () => {
    await mount(() => import('../src/components/admin/PromosTab'), 'PromosTab')
    expect(host.textContent).toContain('Промокодов пока нет.')
    const create = () => buttonWith('Создать промокод') as HTMLButtonElement
    expect(create().disabled).toBe(true)

    const valueInput = [...host.querySelectorAll('input')].find((i) => i.getAttribute('inputmode') === 'decimal')
    await typeInto(valueInput, '15')
    expect(create().disabled).toBe(false)
    await act(async () => { create().click() })
    await flush(20)
    expect(host.textContent).toContain('создан')
    expect(host.textContent).toContain('PROMO-DEMO1')
    expect(host.textContent).toContain('−15%')
    expect(host.textContent).toContain('Действует, без срока')

    await act(async () => { (host.querySelector('button[role="switch"]') as HTMLButtonElement).click() })
    await flush(20)
    expect(host.textContent).toContain('Выключен')
  })
})
