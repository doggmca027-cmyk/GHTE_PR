// The reader of competitors' public price lists (scripts/lib/market-prices.ts): numbers and currencies, the three list formats, what a line sells, the median per
// product across competitors, and the robots.txt check. No network: the lists are small fixtures in the shape of the real pages.
import { describe, expect, it } from 'vitest'
import {
  aggregate, classify, confidenceOf, median, normalizeName, parseNumber, parsePerfectPanel, parsePrice, parseSmmLevel, parseSmmPrime, refillDays, robotsAllows, type PricedRow,
} from '../scripts/lib/market-prices.ts'

describe('numbers and prices', () => {
  it.each([['1 000', 1000], ['24,00', 24], ['0.0010', 0.001], ['1,500', 1500], ['1.000.000', 1_000_000], ['0,5', 0.5], ['0,500', 0.5], ['1.5', 1.5], ['12 345,67', 12345.67], ['1,234.56', 1234.56], ['1.234,56', 1234.56]])('%s is %s', (text, n) => {
    expect(parseNumber(text)).toBe(n)
  })
  it.each(['', 'abc', '$5', '-3', '1e5'])('"%s" is not a number', (text) => expect(parseNumber(text)).toBeNull())

  it('a price with its currency, the symbol before or after, or only a number', () => {
    expect(parsePrice(' $0.70 ')).toEqual({ value: 0.7, currency: 'USD' })
    expect(parsePrice('<p class="nowrap">40000,00 ₽ </p>')).toEqual({ value: 40000, currency: 'RUB' })
    expect(parsePrice('899.00&nbsp;₽')).toEqual({ value: 899, currency: 'RUB' })
    expect(parsePrice('115 грн')).toEqual({ value: 115, currency: 'UAH' })
    expect(parsePrice('€1,25')).toEqual({ value: 1.25, currency: 'EUR' })
    expect(parsePrice('₹42')).toEqual({ value: 42, currency: 'INR' })
    expect(parsePrice('100')).toEqual({ value: 100, currency: null })
    expect(parsePrice('Free')).toBeNull()
  })
})

const row = (cat: number, id: number, name: string, price: string, min = '100', max = '10 000') =>
  `<tr data-filter-table-category-id="${cat}"><td data-label="ID" data-filter-table-service-id="${id}">${id}</td><td data-label="Service" class="table-service" data-filter-table-service-name="true">${name}</td><td data-label="Rate"> ${price} </td><td data-label="Min order">${min}</td><td data-label="Max order">${max}</td><td>Description</td></tr>`
const heading = (cat: number, name: string) => `<tr data-filter-table-category-id="${cat}" class="srv-category-row"><td colspan="100%"><div><strong>${name}</strong></div></td></tr>`

describe('the common Perfect Panel list', () => {
  const html = `<table>${heading(7, 'TikTok - Views [S7] [0% Drop]')}${row(7, 6834, 'Views | HQ &amp; Fast', '$0.70', '100', '10 000 000')}${row(7, 6835, 'Views | Slow', '$0.0120')}${heading(9, 'YouTube Likes')}${row(9, 9100, 'Likes R30', '$3.5')}</table>`
  it('reads id, name, price, limits and the category of each service', () => {
    const rows = parsePerfectPanel(html, 'followiz', 'panel', 'USD')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ source: 'followiz', plane: 'panel', category: 'TikTok - Views [S7] [0% Drop]', name: 'Views | HQ & Fast', price: 0.7, currency: 'USD', min: 100, max: 10_000_000, id: '6834' })
    expect(rows[1]!.price).toBe(0.012)
    expect(rows[2]).toMatchObject({ category: 'YouTube Likes', name: 'Likes R30', price: 3.5 })
  })
  it('the format of Soc-Proof: no data-label, the price inside a paragraph, a decimal comma and roubles', () => {
    const soc = `<table><tr class="pp-service-category-row" data-filter-table-category-id="16"><td colspan="6"><strong class="pp-service-category-name">TikTok подписчики</strong></td></tr>
      <tr data-filter-table-category-id="16"><td data-filter-table-service-id="31">31 </td><td class="service-name" data-filter-table-service-name="true">ᴛᴛ Подписчики ⟮ ♻ ʀ 30 ⟯ </td><td><div class="rate-us"><p class="nowrap ser-rate">240,50 ₽ </p></div></td><td>1 000</td><td>10 000</td><td class="nowrap">1 ч.</td></tr></table>`
    const [r] = parsePerfectPanel(soc, 'socproof', 'cis', 'RUB')
    expect(r).toMatchObject({ category: 'TikTok подписчики', price: 240.5, currency: 'RUB', min: 1000, max: 10_000, id: '31' })
  })
  it('a row without a readable price, or with a zero one, is left out; a price without a symbol takes the source currency', () => {
    expect(parsePerfectPanel(`<table>${row(1, 1, 'A', 'n/a')}${row(1, 2, 'B', '$0')}</table>`, 's', 'panel', 'USD')).toEqual([])
    expect(parsePerfectPanel(`<table>${row(1, 3, 'C', '2,5')}</table>`, 's', 'cis', 'RUB')[0]).toMatchObject({ price: 2.5, currency: 'RUB' })
  })
})

describe('the other two formats', () => {
  it('SMMPrime: a div per service with data-sp attributes', () => {
    const html = `<div class="sp-service-row" data-category="TikTok Просмотры" data-filter-table-category-id="1" data-filter-table-service-id="22" data-sp-service-id="22" data-sp-name="22. TikTok Просмотры &quot;Быстрые&quot;" data-sp-rate="22,5" data-sp-min="100" data-sp-max="1 000 000" ></div>
      <div class="sp-service-row other" data-sp-service-id="23" data-sp-name="23. Free" data-sp-rate="0" ></div>`
    const rows = parseSmmPrime(html, 'smmprime', 'cis', 'RUB')
    expect(rows).toEqual([{ source: 'smmprime', plane: 'cis', category: 'TikTok Просмотры', name: 'TikTok Просмотры "Быстрые"', price: 22.5, currency: 'RUB', min: 100, max: 1_000_000, id: '22' }])
  })
  it('SMMLEVEL: one price per product page, the price of the smallest pack made per 1000, read as guaranteed', () => {
    const html = '<html><h1>Купити підписників TikTok</h1><div>Гарантія від списань 100%</div><p>Мінімальна кількість: 250 — 30 000</p> 115 грн за 250 шт <p>Купити</p></html>'
    const [r] = parseSmmLevel(html, 'buy-tiktok-followers')
    expect(r).toMatchObject({ source: 'smmlevel', plane: 'cis', currency: 'UAH', price: 460, min: 250, max: 30_000, id: 'buy-tiktok-followers' })
    expect(r!.name).toContain('[guarantee]')
    expect(classify(r!.name).level).toBe('premium')
    expect(parseSmmLevel('<h1>x</h1> nothing here', 'x')).toEqual([])
  })
})

describe('what a line sells', () => {
  it('platform, product, level and the days of the guarantee', () => {
    expect(classify('TikTok Followers | Real | R30')).toMatchObject({ platform: 'tiktok', action: 'followers', level: 'premium', refillDays: 30, skip: null })
    expect(classify('YouTube Subscribers [no refill]')).toMatchObject({ platform: 'youtube', action: 'followers', level: 'standard', refillDays: null })
    expect(classify('YouTube Views', 'Lifetime Guarantee')).toMatchObject({ action: 'views', level: 'premium', refillDays: 365 })
    expect(classify('TikTok Likes | 90 Days Refill')).toMatchObject({ action: 'likes', level: 'premium', refillDays: 90 })
    expect(classify('TikTok Shares')).toMatchObject({ action: 'shares', level: 'standard' })
  })
  it('Russian and Ukrainian lines, and the fancy letters of Soc-Proof', () => {
    expect(classify('ᴛᴛ Подписчики ⟮ ♻ ʀ 30 ⟯')).toMatchObject({ platform: 'tiktok', action: 'followers', level: 'premium', refillDays: 30 })
    expect(classify('YouTube Просмотры без гарантии')).toMatchObject({ platform: 'youtube', action: 'views', level: 'standard' })
    expect(classify('Купити підписників TikTok (buy-tiktok-followers) [guarantee]')).toMatchObject({ action: 'followers', level: 'premium' })
    expect(classify('𝗧𝗶𝗸𝗧𝗼𝗸 𝗟𝗶𝗸𝗲𝘀')).toMatchObject({ platform: 'tiktok', action: 'likes' })
  })
  it('what is not one clear product is skipped, with the reason', () => {
    expect(classify('TikTok Likes + Views').skip).toBe('ambiguous')
    expect(classify('YouTube Comment Likes').skip).toBe('comment_likes')
    expect(classify('YouTube Comments Upvotes').skip).toBe('comment_likes')
    expect(classify('Instagram Followers').skip).toBe('platform')
    expect(classify('FB/IG/TikTok/YouTube Source').skip).toBe('platform')
    expect(classify('TikTok Something').skip).toBe('no_action')
    expect(classify('TikTok бан аккаунта').skip).toBe('unwanted')
    expect(classify('YouTube Report Video').skip).toBe('unwanted')
    expect(classify('TikTok Dislikes').skip).toBe('unwanted')
  })
  it('live sessions and watch time are their own products', () => {
    expect(classify('YouTube Live Viewers 60 min').action).toBe('live')
    expect(classify('TikTok Live Stream Likes').action).toBe('live')
    expect(classify('YouTube Watch Hours 4000').action).toBe('watch_time')
  })
  it('what makes the price of the same product differ is named: country, retention, shorts, source', () => {
    expect(classify('YouTube Views USA').modifiers).toEqual(['geo'])
    expect(classify('YouTube Views Worldwide').modifiers).toEqual([])
    expect(classify('YouTube Views [Mix]').modifiers).toEqual([])
    expect(classify('YouTube Views Retention 5-8 min').modifiers).toEqual(['retention'])
    expect(classify('YouTube Shorts Views').modifiers).toEqual(['shorts'])
    expect(classify('YouTube Views from Ads').modifiers).toEqual(['source'])
    expect(classify('YouTube Views').modifiers).toEqual([])
  })
  it('the guarantee in days', () => {
    expect(refillDays('refill 30 days')).toBe(30)
    expect(refillDays('r60')).toBe(60)
    expect(refillDays('30 days refill')).toBe(30)
    expect(refillDays('no refill')).toBeNull()
    expect(refillDays('lifetime')).toBe(365)
    expect(refillDays('refill')).toBeNull() // a refill with no term: no number is made up
    expect(refillDays('views')).toBeNull()
  })
  it('names are folded: fancy letters, bold letters and emoji out', () => {
    expect(normalizeName('𝗣𝗿𝗲𝗺𝗶𝘂𝗺 ᴛɢ 🔥 Views')).toBe('premium tg views')
  })
})

const priced = (source: string, plane: 'cis' | 'panel', usd: number, over: Partial<PricedRow> = {}): PricedRow =>
  ({ source, plane, platform: 'tiktok', action: 'views', level: 'standard', modifiers: [], usd, name: 'x', ...over })

describe('the median per product', () => {
  it('median of even and odd lists', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
  it('each competitor counts once: a panel with a thousand lines weighs as much as one with three', () => {
    const rows = [...Array.from({ length: 1000 }, () => priced('big', 'panel', 0.05)), priced('a', 'panel', 0.2), priced('a', 'panel', 0.4), priced('a', 'panel', 0.3), priced('b', 'panel', 0.1)]
    const g = aggregate(rows).find((x) => x.slice === 'all')!
    expect(g.panel).toMatchObject({ n: 3, rows: 1004 })
    expect(g.panel!.median).toBeCloseTo(0.1, 10) // medians 0.05, 0.1, 0.3 -> 0.1
    expect(g.panel!.low).toBe(0.05)
    expect(g.panel!.high).toBeCloseTo(0.3, 10)
    expect(g.cis).toBeNull()
  })
  it('the plain slice leaves out the lines that differ by country, retention, shorts or source', () => {
    const rows = [priced('a', 'cis', 1), priced('a', 'cis', 9, { modifiers: ['geo'] }), priced('b', 'cis', 1.2)]
    const stats = aggregate(rows)
    expect(stats.find((x) => x.slice === 'plain')!.cis).toMatchObject({ n: 2, median: 1.1 })
    expect(stats.find((x) => x.slice === 'all')!.cis!.rows).toBe(3)
  })
  it('products and levels are kept apart', () => {
    const rows = [priced('a', 'cis', 1), priced('a', 'cis', 5, { level: 'premium' }), priced('a', 'cis', 7, { action: 'likes' })]
    expect(aggregate(rows).filter((x) => x.slice === 'plain').map((x) => `${x.action}/${x.level}`).sort()).toEqual(['likes/standard', 'views/premium', 'views/standard'])
  })
  it('the confidence of a retail median: high with three storefronts that mostly agree, medium with two or with SMMLEVEL alone, low otherwise', () => {
    const stats = (srcs: [string, number][]) => aggregate(srcs.map(([s, u]) => priced(s, 'cis', u))).find((x) => x.slice === 'all')!.cis
    expect(confidenceOf(stats([['a', 1], ['b', 1.2], ['c', 1.5]]))).toBe('high')
    expect(confidenceOf(stats([['a', 1], ['b', 1.4]]))).toBe('medium')
    expect(confidenceOf(stats([['smmlevel', 2]]))).toBe('medium')
    expect(confidenceOf(stats([['a', 2]]))).toBe('low')
    expect(confidenceOf(stats([['a', 1], ['b', 5], ['c', 30]]))).toBe('low')
    expect(confidenceOf(null)).toBe('low')
  })
})

describe('robots.txt', () => {
  const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /checkout/\nAllow: /app/public\n# comment\nSitemap: https://x/sitemap.xml'
  it('the group of * decides; the longest rule wins and Allow wins a tie', () => {
    expect(robotsAllows(robots, '/buy-tiktok-followers')).toBe(true)
    expect(robotsAllows(robots, '/services')).toBe(true)
    expect(robotsAllows(robots, '/app/orders')).toBe(false)
    expect(robotsAllows(robots, '/checkout/pay')).toBe(false)
    expect(robotsAllows(robots, '/app/public/page')).toBe(true)
  })
  it('an empty file, or no rule for *, allows everything; Disallow: / forbids it', () => {
    expect(robotsAllows('', '/services')).toBe(true)
    expect(robotsAllows('User-agent: Bingbot\nDisallow: /', '/services')).toBe(true)
    expect(robotsAllows('User-agent: *\nDisallow: /', '/services')).toBe(false)
    expect(robotsAllows('User-agent: *\nDisallow:', '/services')).toBe(true)
  })
})
