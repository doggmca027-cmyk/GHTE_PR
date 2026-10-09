import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnfundedCard } from '../src/components/admin/UnfundedCard'
import { statusMeta } from '../src/lib/order-view'
import { NO_UNFUNDED, type UnfundedSummary } from '../src/types/admin'

const waiting: UnfundedSummary = {
  count: 3, charge: 120, cost: 30, oldest: new Date(Date.now() - 2 * 3600_000).toISOString(),
  providers: [{ id: 'p1', name: 'SMM Center', count: 3, cost: 30, balance: 2.9999, oldest: new Date(Date.now() - 2 * 3600_000).toISOString() }],
}

describe('the admin card of orders waiting for a provider top-up', () => {
  it('says how many, what the customers paid, what to transfer and where, and when the money goes back', () => {
    const html = renderToStaticMarkup(createElement(UnfundedCard, { unfunded: waiting, ttlHours: 24 }))
    for (const text of ['3 оплаченных заказа ждут пополнения провайдера', '$120.00', '$30.00', 'SMM Center', 'перевести', 'за 24 ч', 'ждёт 2 ч']) expect(html).toContain(text)
    expect(html).toContain('role="status"')
  })

  it('is not there when nothing waits', () => {
    expect(renderToStaticMarkup(createElement(UnfundedCard, { unfunded: NO_UNFUNDED, ttlHours: 24 }))).toBe('')
  })

  it('uses the right Russian plural', () => {
    const card = (count: number) => renderToStaticMarkup(createElement(UnfundedCard, { unfunded: { ...waiting, count }, ttlHours: 24 }))
    expect(card(1)).toContain('1 оплаченный заказ ждёт пополнения')
    expect(card(5)).toContain('5 оплаченных заказов ждут пополнения')
  })
})

describe('the customer sees a paid order that waits for the service to be connected', () => {
  it('has its own label while waiting, and an ordinary paid order keeps "Paid"', () => {
    expect(statusMeta('paid', true)).toMatchObject({ label: 'Waiting to be connected', tone: 'warning', pulse: true })
    expect(statusMeta('paid').label).toBe('Paid')
    expect(statusMeta('submitted', true).label).toBe('Submitted') // the flag only matters for paid orders
  })
})
