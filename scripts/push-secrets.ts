// Uploads the Edge Function secrets from .env.local to your Supabase project, after validating them.
// Only the function-secret names are sent (never VITE_*, the CLI token, or the DB password).
//
//   npm run secrets:push              # validate, then upload
//   npm run secrets:push -- --dry-run # validate and list the names that WOULD be uploaded
//   npm run secrets:push -- --without TON_RECIPIENT_ADDRESS,TON_NETWORK   # keep those names out of this upload
//                                       (values stay in .env.local; both left out = deposits disabled)

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFunctionSecrets, extractFunctionSecrets, formatFindings, hasErrors, parseEnvFile } from './lib/env-checks.ts'

const file = '.env.local'
const dryRun = process.argv.includes('--dry-run')
if (!existsSync(file)) {
  console.error(`push-secrets: ${file} not found.`)
  process.exit(1)
}

const all = parseEnvFile(readFileSync(file, 'utf8'))
const withoutIdx = process.argv.indexOf('--without')
const without = withoutIdx >= 0 ? (process.argv[withoutIdx + 1] ?? '').split(',').map((n) => n.trim()).filter(Boolean) : []
const secrets = Object.fromEntries(Object.entries(extractFunctionSecrets(all)).filter(([name]) => !without.includes(name)))
if (without.length > 0) console.log(`push-secrets: leaving out of this upload: ${without.join(', ')}`)
const findings = checkFunctionSecrets(secrets)
console.log(`push-secrets: ${Object.keys(secrets).length} secret(s): ${Object.keys(secrets).sort().join(', ')}`)
if (findings.length > 0) console.log(formatFindings(findings))
if (hasErrors(findings)) {
  console.error('\npush-secrets: FAILED validation. Nothing was uploaded.')
  process.exit(1)
}
if (dryRun) {
  console.log('\npush-secrets: dry run OK, nothing uploaded.')
  process.exit(0)
}

const token = all.SUPABASE_ACCESS_TOKEN
const ref = all.SUPABASE_PROJECT_REF
if (!token || !ref) {
  console.error('push-secrets: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF must be set in .env.local.')
  process.exit(1)
}

// The CLI reads secrets from a file; write a private temp file and always remove it.
const tmp = join(tmpdir(), `smm-secrets-${process.pid}-${Date.now()}.env`)
writeFileSync(tmp, Object.entries(secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n', { mode: 0o600 })
try {
  execSync(`npx supabase secrets set --env-file "${tmp}" --project-ref ${ref}`, {
    stdio: 'inherit',
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: token },
  })
  console.log('\npush-secrets: uploaded. Verify names with:  npx supabase secrets list --project-ref ' + ref)
} catch {
  console.error('\npush-secrets: the Supabase CLI reported an error (see above).')
  process.exitCode = 1
} finally {
  rmSync(tmp, { force: true })
}
