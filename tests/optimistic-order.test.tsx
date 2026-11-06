// @vitest-environment jsdom
// Optimistic ordering: at the tap of "Order Now" the balance drops and the order shows as "being confirmed", BEFORE the server has answered; the server's
// answer is still the truth (its wallet replaces ours), and a refusal puts the balance back and brings the form back with the reason.
// Why it matters here: the API can be slow or restricted (Supabase answered HTTP 402 on 2026-11-06); the customer sees what was done at once, and is never
// left with a wrong balance when it fails.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { token: 't', expiresAt: Date.now() / 1000 + 3600, isMock: false, wallet: { balance: 10, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'x', firstName: 'X', languageCode: 'en', isAdmin: false } }

describe('1. debitWallet: the balance drops now, the server stays the truth', () => {
  let root: Root
  let host: HTMLDivElement
  let api!: { balance: () => number; debit: (u: number) => () => void; apply: (b: number) => void; refresh: () => Promise<void> }
  const reads = vi.fn(async () => ({ balance: 7.5, currency: 'USD' }))

  beforeEach(async () => {
    vi.resetModules()
    reads.mockClear()
    vi.doMock('../src/services/api/auth', async (orig) => ({ ...(await orig<object>()), fetchWallet: reads, authenticateWithTelegram: async () => SESSION }))
    vi.doMock('../src/services/api/web-auth', async (orig) => ({ ...(await orig<object>()), insideTelegram: () => true }))
    const { AuthProvider, useAuth } = await import('../src/context/AuthContext')
    let latest!: ReturnType<typeof useAuth>
    let shown = 0
    const Probe = () => {
      latest = useAuth()
      shown = latest.state.status === 'authenticated' ? latest.state.session.wallet.balance : -1
      return null
    }
    host = document.createElement('div')
    root = createRoot(host)
    await act(async () => { root.render(createElement(AuthProvider, null, createElement(Probe))) })
    await act(async () => { await Promise.resolve() })
    api = {
      balance: () => shown,
      debit: (units) => { let undo = () => undefined as void; act(() => { undo = latest.debitWallet(units) as () => void }); return () => act(() => { undo() }) },
      apply: (b) => act(() => latest.applyWallet({ balance: b, currency: 'USD' })),
      refresh: () => act(async () => { await latest.refreshWallet() }),
    }
  })
  afterEach(() => { act(() => root.unmount()); vi.doUnmock('../src/services/api/auth'); vi.doUnmock('../src/services/api/web-auth') })

  it('lowers the displayed balance at once, by the amount in 1/10,000 of the currency', () => {
    expect(api.balance()).toBe(10)
    api.debit(40_000) // $4.00
    expect(api.balance()).toBe(6)
    api.debit(125) // $0.0125
    expect(api.balance()).toBe(5.9875)
  })

  it('the undo puts the balance back', () => {
    const undo = api.debit(40_000)
    expect(api.balance()).toBe(6)
    undo()
    expect(api.balance()).toBe(10)
  })

  it('...but not over the server\'s own word: once applyWallet has set the wallet, an undo changes nothing', () => {
    const undo = api.debit(40_000)
    api.apply(5.5) // the server says: 5.50 (a discount, say)
    undo()
    expect(api.balance()).toBe(5.5)
  })

  it('never goes below zero, and a zero, negative or broken amount does nothing', () => {
    api.debit(1_000_000) // $100 from $10
    expect(api.balance()).toBe(0)
    api.apply(10)
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) api.debit(bad)()
    expect(api.balance()).toBe(10)
  })

  it('does not count as a read from the server: the next refresh still asks, and the server\'s balance replaces the optimistic one', async () => {
    api.debit(40_000)
    expect(api.balance()).toBe(6)
    await api.refresh()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(api.balance()).toBe(7.5)
  })
})

describe('2. the order form: the status and the balance change at the tap, a refusal brings the form back', () => {
  let root: Root
  let host: HTMLDivElement
  let session: typeof SESSION
  const applyWallet = vi.fn()
  const undo = vi.fn()
  const debitWallet = vi.fn(() => undo)
  const createOrder = vi.fn()
  const onViewOrders = vi.fn()
  const onClose = vi.fn()

  const service = { id: 's1', categoryId: 'c1', name: 'Telegram Post Views', description: null, ratePer1000: 4, minQuantity: 1000, maxQuantity: 100_000, refillSupported: false, sortOrder: 1 }
  const quote = { listPrice: 4, tier: { slug: 'bronze', percentage: 0, discount: 0 }, promo: { applied: false, discount: 0 }, finalPrice: 4, totalDiscount: 0, discountReduced: false }

  const text = () => host.textContent ?? ''
  const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''))
  const type = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  async function open() {
    vi.resetModules()
    vi.doMock('../src/context/AuthContext', () => ({ useAuth: () => ({ applyWallet, debitWallet }) }))
    vi.doMock('../src/services/api/orders', () => ({ createOrder }))
    vi.doMock('../src/hooks/useQuote', () => ({ useQuote: () => ({ state: { kind: 'ready', quote, promoError: null }, invalidate: () => undefined }) }))
    const { OrderModal } = await import('../src/components/services/OrderModal')
    session = { ...SESSION, wallet: { balance: 10, currency: 'USD' } }
    await act(async () => {
      root.render(createElement(OrderModal, { service, platform: 'telegram', platformName: 'Telegram', session: session as never, onClose, onViewOrders }))
    })
    type(host.querySelector('input[type="url"]')!, 'https://t.me/mychannel')
  }
  const tapOrder = () => act(async () => { button(/Order Now/)!.click() })

  beforeEach(() => {
    applyWallet.mockReset(); undo.mockReset(); debitWallet.mockClear(); createOrder.mockReset(); onViewOrders.mockReset(); onClose.mockReset()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.doUnmock('../src/context/AuthContext'); vi.doUnmock('../src/services/api/orders'); vi.doUnmock('../src/hooks/useQuote')
  })

  it('at the tap, before any answer: the balance is debited by the total, the order shows as being confirmed, nothing can be tapped', async () => {
    createOrder.mockReturnValue(new Promise(() => undefined)) // the server has not answered
    await open()
    expect(text()).toContain('Configure order')
    await tapOrder()

    expect(debitWallet).toHaveBeenCalledTimes(1)
    expect(debitWallet).toHaveBeenCalledWith(40_000) // $4.00 in 1/10,000
    expect(text()).toContain('Order received')
    expect(text()).toContain('Confirming with provider')
    expect(text()).toContain('1,000') // the quantity as sent
    expect(text()).toContain('$4.00') // charged
    expect(button(/View my orders/)!.disabled).toBe(true)
    expect(button(/Done/)!.disabled).toBe(true)
    expect(host.querySelector('input[type="url"]')).toBeNull() // the form is not drawn while the answer is awaited
    expect(createOrder).toHaveBeenCalledTimes(1)
  })

  it('the server\'s answer replaces the optimistic one: its wallet is applied, the order is placed, the buttons work; nothing is taken back', async () => {
    let answer!: (v: unknown) => void
    createOrder.mockReturnValue(new Promise((r) => { answer = r }))
    await open()
    await tapOrder()
    await act(async () => { answer({ order: { id: 'o1', status: 'submitted', chargeAmount: 4, quantity: 1000, targetUrl: 'https://t.me/mychannel' }, pending: false, wallet: { balance: 6, currency: 'USD' } }) })

    expect(applyWallet).toHaveBeenCalledWith({ balance: 6, currency: 'USD' })
    expect(undo).not.toHaveBeenCalled()
    expect(text()).toContain('Order placed!')
    expect(text()).toContain('New balance')
    expect(button(/View my orders/)!.disabled).toBe(false)
    act(() => button(/View my orders/)!.click())
    expect(onViewOrders).toHaveBeenCalledTimes(1)
  })

  it('a refusal puts the balance back (the undo), brings the form back with what was typed, and says why', async () => {
    let refuse!: (e: unknown) => void
    createOrder.mockReturnValue(new Promise((_r, rej) => { refuse = rej }))
    await open()
    await tapOrder()
    expect(text()).toContain('Confirming with provider')
    const { OrderApiError } = await import('../src/services/api/order-errors')
    await act(async () => { refuse(new OrderApiError('server', 'The provider rejected the order.')) })

    expect(undo).toHaveBeenCalledTimes(1) // the balance is back
    expect(applyWallet).not.toHaveBeenCalled()
    expect(text()).toContain('Configure order')
    expect(text()).not.toContain('Confirming with provider')
    expect((host.querySelector('input[type="url"]') as HTMLInputElement).value).toBe('https://t.me/mychannel') // what the customer typed is still there
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('rejected')
    expect(button(/Order Now/)!.disabled).toBe(false) // and they can try again
  })

  it('when the server refuses AND says what the wallet is, that wallet is the truth: it is applied and the optimistic debit is not undone over it', async () => {
    let refuse!: (e: unknown) => void
    createOrder.mockReturnValue(new Promise((_r, rej) => { refuse = rej }))
    await open()
    await tapOrder()
    const { OrderApiError } = await import('../src/services/api/order-errors')
    const err = new OrderApiError('server', 'Declined.')
    ;(err as { wallet?: unknown }).wallet = { balance: 10, currency: 'USD' }
    await act(async () => { refuse(err) })
    expect(applyWallet).toHaveBeenCalledWith({ balance: 10, currency: 'USD' })
    expect(undo).not.toHaveBeenCalled()
  })

  it('the tap does not debit when the order cannot be sent (a bad link): nothing optimistic happens before the form is valid', async () => {
    createOrder.mockReturnValue(new Promise(() => undefined))
    await open()
    type(host.querySelector('input[type="url"]')!, 'not a link')
    await act(async () => { button(/Order Now/)!.click() })
    expect(debitWallet).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
  })
})
