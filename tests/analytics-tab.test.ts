import { describe, expect, it } from 'vitest'
import type { FunnelStep, RetentionCohort, RevenueDay, Section, TopService } from '../src/types/admin-bi'

const render = async (pick: (m: typeof import('../src/components/admin/AnalyticsTab')) => [unknown, Record<string, unknown>]) => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const mod = await import('../src/components/admin/AnalyticsTab')
  const [component, props] = pick(mod)
  return renderToStaticMarkup(createElement(component as never, props))
}

const day = (d: string, orders: number, revenue: number, cost: number): RevenueDay => ({ day: d, orders, revenue, cost, margin: revenue - cost, aov: orders ? revenue / orders : null })
const FAILED: Section<never[]> = { error: 'This section could not be loaded.' }

describe('RevenueSection', () => {
  const section = (days: RevenueDay[]): Section<RevenueDay[]> => ({ data: days })
  const view = (s: Section<RevenueDay[]> | null) => render((m) => [m.RevenueSection, { section: s }])

  it('totals, margin share and one bar row per day, newest first, with orders and AOV', async () => {
    const html = await view(section([day('2026-05-10', 2, 6.4, 3.2), day('2026-05-11', 0, 0, 0), day('2026-05-12', 2, 24, 12)]))
    for (const text of ['Revenue &amp; margin', '$30.40', '$15.20', '50% of revenue', '>4<', '$7.60', '05-12', '05-10', 'AOV $12.00', 'AOV –']) expect(html).toContain(text)
    expect(html.indexOf('05-12')).toBeLessThan(html.indexOf('05-10'))
    expect(html).toContain('width:100%') // the best day fills the bar
    expect(html).toContain('width:26.7%')
  })

  it('loading: skeleton rows, busy, no numbers', async () => {
    const html = await view(null)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Loading revenue &amp; margin')
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('$')
  })

  it('failed: the section says so without breaking the rest', async () => {
    const html = await view(FAILED as Section<RevenueDay[]>)
    expect(html).toContain('role="alert"')
    expect(html).toContain('This section could not be loaded.')
  })

  it('empty: no orders in the period is a message, not a wall of empty bars', async () => {
    const html = await view(section([day('2026-05-10', 0, 0, 0), day('2026-05-11', 0, 0, 0)]))
    expect(html).toContain('No data for this period yet.')
    expect(html).not.toContain('Daily revenue')
  })
})

describe('FunnelSection', () => {
  const steps: FunnelStep[] = [
    { step: 'catalog_view', users: 240, rateFromPrevious: null, rateFromFirst: 100 },
    { step: 'checkout_started', users: 96, rateFromPrevious: 40, rateFromFirst: 40 },
    { step: 'order_placed', users: 31, rateFromPrevious: 32.29, rateFromFirst: 12.92 },
  ]
  const view = (s: Section<FunnelStep[]> | null) => render((m) => [m.FunnelSection, { section: s }])

  it('the three steps with users, bars relative to the first step and both conversion rates', async () => {
    const html = await view({ data: steps })
    for (const text of ['Viewed the catalog', 'Started checkout', 'Placed an order', '>240<', '>96<', '>31<', 'Start of the funnel', '40% of the previous step · 40% of all', '32.3% of the previous step · 12.9% of all']) expect(html).toContain(text)
    expect(html).toContain('width:100%')
    expect(html).toContain('width:40%')
  })

  it('no one entered the funnel: empty state; loading and error states', async () => {
    expect(await view({ data: steps.map((s) => ({ ...s, users: 0 })) })).toContain('No data for this period yet.')
    expect(await view({ data: [] })).toContain('No data for this period yet.')
    expect(await view(null)).toContain('aria-busy="true"')
    expect(await view(FAILED as Section<FunnelStep[]>)).toContain('This section could not be loaded.')
  })
})

describe('TopServicesSection', () => {
  const rows: TopService[] = [
    { serviceId: 's1', name: 'Telegram Post Views [Instant]', orders: 42, units: 420_000, revenue: 168.5, margin: 84.25, aov: 4.0119 },
    { serviceId: 's2', name: 'Members <b>R30</b>', orders: 9, units: 4_500, revenue: 81, margin: 40.5, aov: 9 },
  ]
  const view = (s: Section<TopService[]> | null) => render((m) => [m.TopServicesSection, { section: s }])

  it('ranked list with revenue, margin, orders, units and AOV; service names are escaped', async () => {
    const html = await view({ data: rows })
    for (const text of ['Top services', '$168.50', 'margin $84.25', '42 orders', '420,000 units', 'AOV $4.0119', '$81.00']) expect(html).toContain(text)
    expect(html.indexOf('Telegram Post Views')).toBeLessThan(html.indexOf('Members'))
    expect(html).not.toContain('<b>R30</b>')
    expect(html).toContain('&lt;b&gt;R30&lt;/b&gt;')
  })

  it('empty, loading, error', async () => {
    expect(await view({ data: [] })).toContain('No data for this period yet.')
    expect(await view(null)).toContain('Loading top services')
    expect(await view(FAILED as Section<TopService[]>)).toContain('role="alert"')
  })
})

describe('RetentionSection', () => {
  const cohorts: RetentionCohort[] = [
    { cohort: '2026-01-10', size: 3, retention: [{ day: 1, users: 2, rate: 66.67 }, { day: 7, users: 1, rate: 33.33 }] },
    { cohort: '2026-01-11', size: 1, retention: [{ day: 1, users: 1, rate: 100 }, { day: 7, users: null, rate: null }] },
  ]
  const view = (s: Section<RetentionCohort[]> | null) => render((m) => [m.RetentionSection, { section: s }])

  it('overall day-1 / day-7 retention and a cohort table; cohorts too young show a dash', async () => {
    const html = await view({ data: cohorts })
    for (const text of ['Day 1 retention', '75%', '3 of 4 users', 'Day 7 retention', '33.3%', '1 of 3 users', '01-10', '01-11', '66.7%', '100%', '–']) expect(html).toContain(text)
    expect(html).toContain('<th scope="col"')
  })

  it('only very young cohorts: says they cannot be measured yet', async () => {
    const html = await view({ data: [{ cohort: '2026-10-09', size: 5, retention: [{ day: 1, users: null, rate: null }, { day: 7, users: null, rate: null }] }] })
    expect(html).toContain('too recent to measure yet')
  })

  it('empty, loading, error', async () => {
    expect(await view({ data: [] })).toContain('No data for this period yet.')
    expect(await view(null)).toContain('aria-busy="true"')
    expect(await view(FAILED as Section<RetentionCohort[]>)).toContain('This section could not be loaded.')
  })
})

describe('shell: range picker, error boundary, admin tab', () => {
  it('the picker offers 7, 30 and 90 days and marks the current one', async () => {
    const html = await render((m) => [m.RangePicker, { value: 30, onChange: () => {}, onRefresh: () => {}, refreshing: false }])
    expect(html).toContain('7 days')
    expect(html).toContain('90 days')
    expect(html).toMatch(/aria-checked="true"[^>]*>30 days/)
    expect(html).toMatch(/aria-checked="false"[^>]*>7 days/)
  })

  it('refreshing disables the refresh button and spins it', async () => {
    const html = await render((m) => [m.RangePicker, { value: 7, onChange: () => {}, onRefresh: () => {}, refreshing: true }])
    expect(html).toContain('disabled=""')
    expect(html).toContain('animate-spin')
  })

  it('a card that throws while rendering is replaced by a notice instead of blanking the admin screen', async () => {
    const { Boundary } = await import('../src/components/admin/AnalyticsTab')
    expect(Boundary.getDerivedStateFromError()).toEqual({ failed: true })
    const b = new Boundary({ name: 'Funnel', children: 'child' })
    expect(b.render()).toBe('child')
    b.state = { failed: true }
    const { renderToStaticMarkup } = await import('react-dom/server')
    const html = renderToStaticMarkup(b.render() as never)
    expect(html).toContain('Funnel')
    expect(html).toContain('could not be displayed')
    expect(html).toContain('role="alert"')
  })

  it('the admin screen lists the Analytics tab', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { AdminScreen } = await import('../src/components/admin/AdminScreen')
    const session = { token: 't', expiresAt: 0, isMock: true, wallet: { balance: 0, currency: 'USD' }, user: { id: 'u', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: true } }
    expect(renderToStaticMarkup(createElement(AdminScreen, { session }))).toContain('Analytics')
  })
})
