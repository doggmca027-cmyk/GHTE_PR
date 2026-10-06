// Runs automatically before `npm run build` (npm "prebuild" hook).
// Warns about missing / dangerous client environment variables; FAILS the build only for a
// production deployment (Vercel production environment, or STRICT_ENV=1).
//
//   node scripts/verify-env.ts            # check what the build would use right now
//   STRICT_ENV=1 node scripts/verify-env.ts   # apply production rules locally

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import { buildManifest, checkClientEnv, checkManifest, formatFindings, hasErrors, resolveAppUrl, type Finding, type Manifest } from './lib/env-checks.ts'

const root = process.cwd()
const production = process.env.VERCEL_ENV === 'production' || process.env.STRICT_ENV === '1'

// Same sources Vite will read for a production build: .env, .env.local, .env.production(.local), then the process environment.
const env = { ...loadEnv('production', root, ''), ...process.env }

const findings: Finding[] = checkClientEnv(env, { production })

const manifestPath = join(root, 'public', 'tonconnect-manifest.json')
if (existsSync(manifestPath)) {
  const template = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  const appUrl = resolveAppUrl(env)
  // The build publishes the template with every URL rewritten to the real origin (see postbuild.ts).
  const effective = appUrl ? buildManifest(template, appUrl, env) : template
  findings.push(...checkManifest(effective, { production, appUrl }))
  if (production && !appUrl) {
    findings.push({ level: 'error', id: 'APP_URL', message: 'Cannot determine the public URL of the app. Set APP_URL (e.g. https://your-app.vercel.app) in the Vercel project environment.' })
  }
} else {
  findings.push({ level: 'error', id: 'manifest', message: 'public/tonconnect-manifest.json is missing.' })
}

const label = production ? 'PRODUCTION build' : 'non-production build'
if (findings.length === 0) {
  console.log(`verify-env: OK (${label}).`)
} else {
  console.log(`verify-env: ${label}\n${formatFindings(findings)}`)
}
if (hasErrors(findings)) {
  console.error('\nverify-env: FAILED. Fix the errors above (see DEPLOYMENT.md).')
  process.exit(1)
}
