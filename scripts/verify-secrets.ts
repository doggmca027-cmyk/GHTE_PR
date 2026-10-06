// Validates the Edge Function secrets BEFORE you upload them. Never prints values.
// Exit code 1 if anything is wrong.
//
//   npm run verify:secrets                 # checks the secrets block of .env.local
//   npm run verify:secrets -- other.env    # any env file (combined or secrets-only)

import { existsSync, readFileSync } from 'node:fs'
import { checkFunctionSecrets, extractFunctionSecrets, formatFindings, hasErrors, parseEnvFile } from './lib/env-checks.ts'

const file = process.argv[2] ?? '.env.local'
if (!existsSync(file)) {
  console.error(`verify-secrets: ${file} not found.\nCopy .env.example to .env.local and fill in the values.`)
  process.exit(1)
}

const env = extractFunctionSecrets(parseEnvFile(readFileSync(file, 'utf8')))
const findings = checkFunctionSecrets(env)
const keys = Object.keys(env).sort()

console.log(`verify-secrets: ${file}`)
console.log(`  ${keys.length} function secret(s) filled in: ${keys.join(', ') || '(none)'}`)
if (findings.length === 0) {
  console.log('  OK: all required secrets are present and look valid.')
} else {
  console.log(formatFindings(findings))
}
if (hasErrors(findings)) {
  console.error('\nverify-secrets: FAILED. Fix the errors above, then run it again. Nothing was uploaded.')
  process.exit(1)
}
console.log('\nNext:  npm run secrets:push')
