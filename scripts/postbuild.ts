// Runs automatically after `npm run build` (npm "postbuild" hook).
//   1. Publishes the TON Connect manifest with every URL pointed at the real app origin
//      (the committed file keeps a placeholder; nothing tracked is modified).
//   2. Scans the finished bundle: the build FAILS if it contains a secret or a server-only name.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { loadEnv } from 'vite'
import { buildManifest, resolveAppUrl, scanBundleForSecrets, type Manifest } from './lib/env-checks.ts'

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
