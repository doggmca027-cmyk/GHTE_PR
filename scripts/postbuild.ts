// Runs automatically after `npm run build` (npm "postbuild" hook).
//   1. Publishes the TON Connect manifest with every URL pointed at the real app origin
//      (the committed file keeps a placeholder; nothing tracked is modified).
//   2. Scans the finished bundle: the build FAILS if it contains a secret or a server-only name.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { loadEnv } from 'vite'
import { buildManifest, resolveAppUrl, scanBundleForSecrets, type Manifest } from './lib/env-checks.ts'
import { DOCS, DOC_LANGS, botLink, buildRobots, buildSitemap, docFile, fillPage } from './lib/seo.ts'

const root = process.cwd()
const dist = join(root, 'dist')
if (!existsSync(dist)) {
  console.error('postbuild: dist/ not found.')
  process.exit(1)
}
const env = { ...loadEnv('production', root, ''), ...process.env }

// 1. manifest
const templatePath = join(root, 'public', 'tonconnect-manifest.json')
const appUrl = resolveAppUrl(env)
if (appUrl && existsSync(templatePath)) {
  const manifest = buildManifest(JSON.parse(readFileSync(templatePath, 'utf8')) as Manifest, appUrl, env)
  writeFileSync(join(dist, 'tonconnect-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`postbuild: tonconnect-manifest.json published for ${appUrl}`)
} else {
  console.log('postbuild: APP_URL unknown, manifest left as committed (placeholder URLs will be rejected in production builds).')
}
// 1b. the public legal pages: absolute URLs and the bot link filled in; robots.txt and sitemap.xml for search engines
const bot = botLink(env.VITE_TWA_RETURN_URL)
for (const doc of DOCS) {
  for (const lang of DOC_LANGS) {
    const file = join(dist, docFile(doc, lang))
    if (!existsSync(file)) { console.error(`postbuild: ${docFile(doc, lang)} is missing from dist/.`); process.exit(1) }
    if (appUrl) writeFileSync(file, fillPage(readFileSync(file, 'utf8'), appUrl, bot))
  }
}
writeFileSync(join(dist, 'robots.txt'), buildRobots(appUrl))
if (appUrl) {
  writeFileSync(join(dist, 'sitemap.xml'), buildSitemap(appUrl, new Date().toISOString().slice(0, 10)))
  console.log(`postbuild: legal pages, robots.txt and sitemap.xml published for ${appUrl}${bot ? ` (bot ${bot.name})` : ''}`)
} else {
  console.log('postbuild: APP_URL unknown, legal pages keep their placeholders and no sitemap.xml is written.')
}

if (!existsSync(join(dist, 'tonconnect-icon.png'))) {
  console.error('postbuild: dist/tonconnect-icon.png is missing; the manifest iconUrl would 404.')
  process.exit(1)
}

// 2. bundle scan
const TEXT = new Set(['.js', '.css', '.html', '.json', '.map', '.txt'])
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const files = walk(dist)
  .filter((p) => TEXT.has(extname(p)))
  .map((p) => ({ path: p.slice(dist.length + 1), text: readFileSync(p, 'utf8') }))
const hits = scanBundleForSecrets(files)
if (hits.length > 0) {
  console.error('postbuild: SECRET LEAK DETECTED in the production bundle:')
  for (const h of hits) console.error(`  ${h.file}: ${h.message}`)
  process.exit(1)
}
console.log(`postbuild: scanned ${files.length} bundle file(s): no secrets or server-only names.`)
