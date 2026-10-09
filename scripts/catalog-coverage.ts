// How well the glossary translates a saved copy of a panel's catalogue (a JSON array of { service, name, category, type, rate, min, max }).
//
//   node scripts/catalog-coverage.ts <catalogue.json> [--untranslated 40] [--platforms] [--sample 25]
//
// Prints the share of publishable services whose English title is complete, the platforms the categories land on, the most frequent
// Russian words that are still missing from the glossary, and a few examples. Read-only; nothing is sent anywhere.

import { readFileSync } from 'node:fs'
import { buildPublishRows, detectPlatform, isPublishable } from '../supabase/functions/_shared/catalog-publish.ts'
import { hasCyrillic, parseServiceName, translateText } from '../supabase/functions/_shared/service-text.ts'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
if (!file) {
  console.error('usage: node scripts/catalog-coverage.ts <catalogue.json> [--untranslated N] [--platforms] [--sample N]')
  process.exit(2)
}
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback)

const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, string | number>>
const candidates = raw.map((r) => ({
  id: String(r.service), name: String(r.name), categoryRaw: String(r.category), serviceType: String(r.type ?? 'Default'),
  rate: Number(r.rate), min: Number(r.min), max: Number(r.max),
}))
const known = new Set(['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'spotify', 'kick', 'snapchat', 'twitch', 'soundcloud', 'discord', 'linkedin', 'pinterest', 'reddit', 'likee', 'soop', 'apple-music', 'apple-podcasts', 'audiomack', 'behance', 'binance-square', 'bluesky', 'boomplay', 'naver', 'clubhouse', 'coinmarketcap', 'coub', 'deezer', 'dribbble', 'github', 'jaco', 'kwai', 'line', 'medium', 'mentimeter', 'mixcloud', 'odnoklassniki', 'onlyfans', 'potato', 'quora', 'reverbnation', 'rumble', 'rutube', 'shazam', 'shopee', 'snackvideo', 'spinnin-records', 'threads', 'tidal', 'trovo', 'truth-social', 'tumblr', 'vimeo', 'vk', 'whatsapp', 'xiaohongshu', 'yandex-zen', 'yandex-maps', 'website', 'backlinks', 'app-installs', 'crypto-nft', 'trustpilot', 'google-maps', 'multiplatform', 'smm-tools', 'other'])

const t0 = Date.now()
const built = buildPublishRows(candidates, known)
const publishable = candidates.filter(isPublishable).length
console.log(`${candidates.length} services in the file, ${publishable} publishable (Default type, real price), ${built.skipped} skipped, built in ${Date.now() - t0} ms`)
console.log(`English title complete: ${built.rows.length - built.untranslatedServices} / ${built.rows.length} (${(((built.rows.length - built.untranslatedServices) / built.rows.length) * 100).toFixed(1)} %)`)
const cats = new Set(built.rows.map((r) => r.cat_key))
console.log(`categories: ${cats.size}, untranslated: ${built.untranslatedCategories}`)

if (args.includes('--platforms')) {
  const byPlatform = new Map<string, number>()
  for (const r of built.rows) byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + 1)
  console.log([...byPlatform.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}:${n}`).join(' '))
  const other = [...new Set(candidates.filter((c) => isPublishable(c) && detectPlatform(c.categoryRaw, known).slug === 'other').map((c) => c.categoryRaw))]
  console.log(`categories on "other" (${other.length}):`, other.slice(0, 40).join(' | '))
}

const missing = new Map<string, number>()
for (const c of candidates.filter(isPublishable)) {
  const { titleRu } = parseServiceName(c.name)
  const en = translateText(titleRu)
  if (hasCyrillic(en)) for (const w of en.toLowerCase().match(/[а-яё]+/g) ?? []) missing.set(w, (missing.get(w) ?? 0) + 1)
}
const top = option('--untranslated', 30)
console.log(`\nwords still missing from the glossary (title only), top ${top}:`)
console.log([...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([w, n]) => `${w}:${n}`).join(' '))

const sample = option('--sample', 0)
if (sample > 0) {
  const step = Math.max(1, Math.floor(built.rows.length / sample))
  console.log('\nexamples:')
  for (let i = 0; i < built.rows.length; i += step) console.log(`  [${built.rows[i].platform}] ${built.rows[i].name}\n     <- ${built.rows[i].name_ru}\n     ${JSON.stringify(built.rows[i].attributes)}`)
}
