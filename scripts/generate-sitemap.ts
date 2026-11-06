// npm run generate-sitemap   (also runs at every build: scripts/postbuild.ts calls the same function)
//
// Multiplies the platforms, the services they sell (and the flavours the catalogue has) and the languages the pages are written in into sitemap.xml, with
// hreflang alternates on every URL, and writes it to dist/ (after `vite build`) so that search engines find every landing page. It never asks the database:
// the pages are written from src/seo/pages.ts and copy.ts, so building costs Supabase nothing and works while its API is restricted.
// APP_URL (or the Vercel production URL) is the origin; without it nothing is written, because a sitemap with a wrong origin is worse than none.

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import { resolveAppUrl } from './lib/env-checks.ts'
import { buildFullSitemap, sitemapSummary } from './lib/sitemap.ts'

const root = process.cwd()
const dist = join(root, 'dist')
if (!existsSync(dist)) {
  console.error('generate-sitemap: dist/ not found (run the build first).')
  process.exit(1)
}
const env = { ...loadEnv('production', root, ''), ...process.env }
const site = resolveAppUrl(env)
if (!site) {
  console.log('generate-sitemap: APP_URL unknown, no sitemap.xml written.')
  process.exit(0)
}
writeFileSync(join(dist, 'sitemap.xml'), buildFullSitemap(site, new Date().toISOString().slice(0, 10)))
console.log(`generate-sitemap: sitemap.xml for ${site}, ${sitemapSummary(site)}`)
