// npm run parse-prices [-- --out reports/tiktok-youtube-prices --only smmlevel,smmprime --refresh --no-ours]
//
// Reads the PUBLIC price lists of retail competitors (no login, no purchase), keeps the TikTok and YouTube lines, and writes what the market charges per 1000 for each
// product and level, so that the market floors can be applied to our TikTok and YouTube cards the way they were to the others (market-floors.md):
//
//   rows.csv         every TikTok / YouTube line that was read, with its product, level, modifiers and price in USD per 1000
//   medians.csv      per product and level: the median across competitors (each competitor counts once), for the retail storefronts of Russia, Ukraine and the CIS
//                    (the owner's reference, SMM Level among them) and for the open international panels, for the plain lines and for all of them
//   reference.json   the same in the shape market_reference.json has (cis / panel / ours / confidence), ready for the calibration of the floors
//   summary.md       what was read, what was skipped and why, the rates used
//
// Polite by construction: robots.txt is read first and a disallowed page is not fetched, one request at a time, a pause between requests, every page cached on disk
// (--refresh fetches again). Nothing is sent but GET requests for public pages. Exchange rates: the Bank of Russia daily file (fallback constants if it is down).
// Our own prices come from the public storefront (anon key of .env.local), only to put them next to the market; --no-ours skips it.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  aggregate, classify, confidenceOf, parsePerfectPanel, parseSmmLevel, parseSmmPrime, robotsAllows, median,
  type Currency, type GroupStats, type Plane, type PricedRow, type RawRow,
} from './lib/market-prices.ts'

interface Source { id: string; name: string; plane: Plane; kind: 'perfect' | 'smmprime' | 'smmlevel'; currency: Currency; urls: string[] }

const SMMLEVEL = ['buy-tiktok-followers', 'buy-tiktok-likes', 'buy-tiktok-views', 'buy-youtube-followers', 'buy-youtube-likes', 'buy-youtube-views', 'buy-youtube-comments-ua']
const SOURCES: Source[] = [
  // retail storefronts and panels of Russia, Ukraine and the CIS: the reference of the owner
  { id: 'smmlevel', name: 'SMMLEVEL', plane: 'cis', kind: 'smmlevel', currency: 'UAH', urls: SMMLEVEL.map((s) => `https://smmlevel.com.ua/${s}`) },
  { id: 'smmprime', name: 'SMMPrime', plane: 'cis', kind: 'smmprime', currency: 'RUB', urls: ['https://smmprime.com/services'] },
  { id: 'smmlavka', name: 'SMMLavka', plane: 'cis', kind: 'perfect', currency: 'RUB', urls: ['https://smmlavka.ru/services'] },
  { id: 'socproof', name: 'Soc-Proof', plane: 'cis', kind: 'perfect', currency: 'RUB', urls: ['https://soc-proof.su/services'] },
  { id: 'smmmain', name: 'SMMMain', plane: 'cis', kind: 'perfect', currency: 'USD', urls: ['https://smmmain.com/services'] },
  // open international panels (close to wholesale)
  { id: 'followiz', name: 'Followiz', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://followiz.com/services'] },
  { id: 'smmkings', name: 'SMMKings', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smmkings.com/services'] },
  { id: 'smmstone', name: 'SMMStone', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smmstone.com/services'] },
  { id: 'smmwiz', name: 'SMMWiz', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smmwiz.com/services'] },
  { id: 'smmcost', name: 'SMMCost', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smmcost.com/services'] },
  { id: 'bulkmedya', name: 'BulkMedya', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://bulkmedya.org/services'] },
  { id: 'smmpanelnet', name: 'SMM-Panel.net', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smm-panel.net/services'] },
  { id: 'smmpanelcom', name: 'SMMPanel.com', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smmpanel.com/services'] },
  { id: 'cheapestsmmpanels', name: 'CheapestSMMPanels', plane: 'panel', kind: 'perfect', currency: 'INR', urls: ['https://cheapestsmmpanels.com/services'] },
  { id: 'smmturk', name: 'SMMTurk', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://smmturk.com/services'] },
  { id: 'exosupplier', name: 'ExoSupplier', plane: 'panel', kind: 'perfect', currency: 'USD', urls: ['https://exosupplier.com/services'] },
]

const UA = 'price-list-reader/1.0 (public price lists; GET only)'
const PAUSE_MS = 1500
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const option = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1]! : d }
const OUT = option('out', 'reports/tiktok-youtube-prices')
const CACHE = option('cache', 'research_notes/.market-cache')
const ONLY = option('only', '').split(',').filter(Boolean)
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(CACHE, { recursive: true })

// ---- exchange rates -------------------------------------------------------------------------------------------------------------------------------
/** USD per one unit of the currency. */
async function rates(): Promise<{ usd: Record<Currency, number>; note: string }> {
  const fallback: Record<Currency, number> = { USD: 1, RUB: 1 / 81.67, UAH: 1 / 45.54, EUR: 1.08, INR: 1 / 84 }
  try {
    const j = (await (await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).json()) as { Valute: Record<string, { Value: number; Nominal: number }> }
    const rub = (c: string) => j.Valute[c]!.Value / j.Valute[c]!.Nominal // roubles per unit
    const usdRub = rub('USD')
    return { usd: { USD: 1, RUB: 1 / usdRub, UAH: rub('UAH') / usdRub, EUR: rub('EUR') / usdRub, INR: rub('INR') / usdRub }, note: `Bank of Russia daily file: 1 USD = ${usdRub.toFixed(2)} RUB, ${(usdRub / rub('UAH')).toFixed(2)} UAH, ${(usdRub / rub('INR')).toFixed(1)} INR` }
  } catch {
    return { usd: fallback, note: 'the Bank of Russia file was not reachable: fallback rates 81.67 RUB, 45.54 UAH, 84 INR per USD' }
  }
}

// ---- polite fetching ------------------------------------------------------------------------------------------------------------------------------
const robotsCache = new Map<string, string>()
async function allowed(url: string): Promise<boolean> {
  const u = new URL(url)
  if (!robotsCache.has(u.origin)) {
    let text = ''
    try {
      const r = await fetch(`${u.origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })
      text = r.ok && /text\/plain|text\/html|^$/.test(r.headers.get('content-type') ?? '') && !/<html/i.test(await r.clone().text()) ? await r.text() : ''
    } catch { /* no robots.txt: nothing is forbidden */ }
    robotsCache.set(u.origin, text)
    await sleep(PAUSE_MS)
  }
  return robotsAllows(robotsCache.get(u.origin)!, u.pathname)
}

async function page(url: string): Promise<{ html: string; cached: boolean }> {
  const file = path.join(CACHE, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.html`)
  if (!flag('refresh') && fs.existsSync(file)) return { html: fs.readFileSync(file, 'utf8'), cached: true }
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(180000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const html = await r.text()
  fs.writeFileSync(file, html)
  await sleep(PAUSE_MS)
  return { html, cached: false }
}

// ---- main -----------------------------------------------------------------------------------------------------------------------------------------
const fx = await rates()
const status: { source: string; plane: Plane; state: string; lines: number; kept: number }[] = []
const priced: PricedRow[] = []
const skipped: Record<string, number> = {}
const csvRows = ['source;plane;platform;action;level;modifiers;refill_days;usd_per_1000;price_original;currency;min;max;name;category']
const q = (s: string) => `"${s.replace(/"/g, "'").replace(/\s+/g, ' ').slice(0, 160)}"`

for (const src of SOURCES.filter((s) => ONLY.length === 0 || ONLY.includes(s.id))) {
  const raw: RawRow[] = []
  let state = 'ok'
  const misses: string[] = []
  try {
    for (const url of src.urls) {
      if (!(await allowed(url))) { state = `skipped: robots.txt forbids ${new URL(url).pathname}`; continue }
      const { html } = await page(url)
      if (src.kind === 'perfect') raw.push(...parsePerfectPanel(html, src.id, src.plane, src.currency))
      else if (src.kind === 'smmprime') raw.push(...parseSmmPrime(html, src.id, src.plane, src.currency))
      else {
        const got = parseSmmLevel(html, new URL(url).pathname.slice(1))
        if (got.length === 0) misses.push(new URL(url).pathname.slice(1))
        raw.push(...got)
      }
    }
    if (misses.length > 0 && raw.length > 0) state = `ok, but no price could be read on: ${misses.join(', ')} (another page layout)`
    if (raw.length === 0 && state === 'ok') state = 'read, but no price lines found (the page format may have changed)'
  } catch (e) {
    state = `failed: ${e instanceof Error ? e.message : String(e)}`
  }
  let kept = 0
  for (const r of raw) {
    const c = classify(r.name, r.category)
    if (!c.platform) continue
    if (c.skip || !c.action) { skipped[c.skip ?? 'no_action'] = (skipped[c.skip ?? 'no_action'] ?? 0) + 1; continue }
    const usd = r.price * fx.usd[r.currency]
    kept++
    priced.push({ source: src.id, plane: src.plane, platform: c.platform, action: c.action, level: c.level, modifiers: c.modifiers, usd, name: r.name })
    csvRows.push([src.id, src.plane, c.platform, c.action, c.level, c.modifiers.join('+'), c.refillDays ?? '', usd.toFixed(5), r.price, r.currency, r.min ?? '', r.max ?? '', q(r.name), q(r.category)].join(';'))
  }
  status.push({ source: src.name, plane: src.plane, state, lines: raw.length, kept })
  console.log(`${src.name.padEnd(18)} ${src.plane.padEnd(5)} ${String(raw.length).padStart(6)} lines, ${String(kept).padStart(5)} TikTok/YouTube  ${state === 'ok' ? '' : state}`)
}

// ---- our own prices, only to stand next to the market ---------------------------------------------------------------------------------------------
interface Ours { median: number; cards: number }
const ours = new Map<string, Ours>()
const ourTotals: Record<string, number> = {}
if (!flag('no-ours')) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '') }
  } catch { /* the environment may carry them */ }
  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) {
    const prices = new Map<string, number[]>()
    for (let off = 0; off < 20000; off += 1000) {
      const url = `${env.VITE_SUPABASE_URL}/rest/v1/services?select=name,customer_rate_per_1000,is_premium,category:categories!inner(platform:platforms!inner(slug))&is_active=eq.true&category.platform.slug=in.(tiktok,youtube)&order=id&limit=1000&offset=${off}`
      type OurRow = { name: string; customer_rate_per_1000: number | string; is_premium: boolean; category: { platform: { slug: string } } }
      let rows: OurRow[] | null = null
      for (let attempt = 0; attempt < 3 && rows === null; attempt++) {
        const res = await fetch(url, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(60000) }).catch(() => null)
        const body = res?.ok ? ((await res.json().catch(() => null)) as unknown) : null
        if (Array.isArray(body)) rows = body as OurRow[]
        else await sleep(2000)
      }
      if (rows === null) { console.warn('our own prices could not be read from the storefront: the columns "ours" are left empty'); break }
      if (rows.length === 0) break
      for (const r of rows) {
        const slug = r.category.platform.slug
        ourTotals[slug] = (ourTotals[slug] ?? 0) + 1
        const c = classify(`${r.name} ${slug}`)
        if (c.skip || !c.action) continue
        const key = `${slug}|${c.action}|${r.is_premium ? 'premium' : 'standard'}`
        prices.set(key, [...(prices.get(key) ?? []), Number(r.customer_rate_per_1000)])
      }
      if (rows.length < 1000) break
    }
    for (const [k, v] of prices) ours.set(k, { median: median(v)!, cards: v.length })
  }
}

// ---- the medians ----------------------------------------------------------------------------------------------------------------------------------
const stats = aggregate(priced)
const f = (n: number) => (n >= 10 ? n.toFixed(2) : n >= 0.1 ? n.toFixed(3) : n.toFixed(4))
const mdRows = ['platform;action;level;slice;plane;n_competitors;median_usd;low_usd;high_usd;lines;competitors']
for (const g of stats) for (const [plane, s] of [['cis', g.cis], ['panel', g.panel]] as const) {
  if (s) mdRows.push([g.platform, g.action, g.level, g.slice, plane, s.n, f(s.median), f(s.low), f(s.high), s.rows, q(s.sources.map((x) => `${x.source} ${f(x.median)}`).join(', '))].join(';'))
}

const pick = (g: GroupStats[], plane: 'cis' | 'panel') => {
  const plain = g.find((x) => x.slice === 'plain')?.[plane] ?? null
  const all = g.find((x) => x.slice === 'all')?.[plane] ?? null
  return plain ? { s: plain, slice: 'plain' as const } : all ? { s: all, slice: 'all' as const } : null
}
const reference: unknown[] = []
const keys = [...new Set(stats.map((g) => `${g.platform}|${g.action}|${g.level}`))]
for (const key of keys) {
  const [platform, action, level] = key.split('|') as [string, string, string]
  const group = stats.filter((g) => `${g.platform}|${g.action}|${g.level}` === key)
  const cis = pick(group, 'cis')
  const panel = pick(group, 'panel')
  const mine = ours.get(key)
  reference.push({
    platform, action, level,
    cis: cis ? { median: Number(f(cis.s.median)), low: Number(f(cis.s.low)), high: Number(f(cis.s.high)), n: cis.s.n, rows: cis.s.sources.map((x) => `${x.source} ${f(x.median)} (${x.rows} lines)`) } : null,
    panel: panel ? { median: Number(f(panel.s.median)), n: panel.s.n } : null,
    shop: null,
    ours: mine ? { median: Number(f(mine.median)), cards: mine.cards } : null,
    confidence: confidenceOf(cis?.s ?? null),
    note: `${cis ? `retail storefronts: ${cis.slice === 'plain' ? 'plain lines only (no country / retention / shorts / source modifier)' : 'all lines, modifiers included'}` : 'no retail-storefront data'}; each competitor counted once; USD per 1000, ${fx.note}; brand shops are not read by this script`,
  })
}

fs.writeFileSync(path.join(OUT, 'rows.csv'), `﻿${csvRows.join('\n')}\n`)
fs.writeFileSync(path.join(OUT, 'medians.csv'), `﻿${mdRows.join('\n')}\n`)
fs.writeFileSync(path.join(OUT, 'reference.json'), JSON.stringify(reference, null, 1))

const table: string[] = ['| Platform | Product | Level | Retail storefronts: median (n) | Open panels: median (n) | Our median (cards) | Confidence |', '|---|---|---|---|---|---|---|']
for (const key of keys.filter((k) => !/\|(live|watch_time)\|/.test(k))) {
  const [platform, action, level] = key.split('|') as [string, string, string]
  const r = reference.find((x) => { const o = x as { platform: string; action: string; level: string }; return o.platform === platform && o.action === action && o.level === level }) as { cis: { median: number; n: number } | null; panel: { median: number; n: number } | null; ours: Ours | null; confidence: string }
  table.push(`| ${platform} | ${action} | ${level} | ${r.cis ? `${r.cis.median} (${r.cis.n})` : '-'} | ${r.panel ? `${r.panel.median} (${r.panel.n})` : '-'} | ${r.ours ? `${r.ours.median} (${r.ours.cards})` : '-'} | ${r.confidence} |`)
}
const md = [
  '# TikTok and YouTube: what the market charges per 1000 (USD)', '',
  `Read on ${new Date().toISOString().slice(0, 10)} from the public price lists below. ${fx.note}. Each competitor counts once (the median of its own lines); the plain slice leaves out lines that differ by country, retention, shorts or source.`, '',
  `Our active cards: TikTok ${ourTotals.tiktok ?? '-'}, YouTube ${ourTotals.youtube ?? '-'}.`, '', ...table, '',
  '## Sources', '| Source | Plane | Lines read | TikTok / YouTube lines kept | State |', '|---|---|---:|---:|---|',
  ...status.map((s) => `| ${s.source} | ${s.plane} | ${s.lines} | ${s.kept} | ${s.state} |`), '',
  `Lines of TikTok / YouTube left out: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} (several products in one line, comment likes, report/ban services, no clear product).`, '',
]
fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'))
console.log(`\n${priced.length} lines kept from ${status.filter((s) => s.kept > 0).length} sources -> ${OUT}/ (rows.csv, medians.csv, reference.json, summary.md)`)
