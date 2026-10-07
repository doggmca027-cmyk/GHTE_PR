// Rotates critical secrets of the live Supabase project through the Management API. Values are never printed.
//
//   npm run secrets:rotate -- cron                         # new CRON_SECRET: Vault copy (pg_cron) + Edge Function secret
//   npm run secrets:rotate -- provider-key-secret          # new PROVIDER_KEY_SECRET; every encrypted provider key re-encrypted
//   npm run secrets:rotate -- provider-key --provider "Name" [--store auto|db|env]
//                                                          # a provider's new API key, from NEW_SECRET_VALUE or stdin
//   npm run secrets:rotate -- set JWT_SECRET               # a value issued elsewhere (JWT secret after a dashboard
//                                                          # rotation, TELEGRAM_BOT_TOKEN, TONCENTER_API_KEY), from NEW_SECRET_VALUE or stdin
//
// DRY RUN BY DEFAULT: reads the project, prints the plan (names + fingerprints), writes nothing. Add --apply to do it.
// After an applied rotation the new value is written into .env.local (so `npm run secrets:push` can never bring the old one
// back); --no-env-file skips that. New values are never accepted on the command line (shell history): pipe them in.
// Needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in .env.local; exits non-zero before any change if anything is missing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnvFile } from './lib/env-checks.ts'
import {
  RotationError,
  SETTABLE,
  applyEnvUpdates,
  rotateCronSecret,
  rotateProviderApiKey,
  rotateProviderKeySecret,
  setIssuedSecret,
  type RotationResult,
  type SupabasePort,
} from './lib/rotation.ts'
import { registerSecret, sanitizeText } from '../supabase/functions/_shared/logger.ts'

const ENV_FILE = '.env.local'
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const fail = (message: string): never => {
  console.error(`rotate-secrets: ${sanitizeText(message)}`)
  process.exit(1)
}

async function readNewValue(): Promise<string> {
  const fromEnv = process.env.NEW_SECRET_VALUE?.trim()
  if (fromEnv) return fromEnv
  if (process.stdin.isTTY) fail('pipe the new value in (stdin) or set NEW_SECRET_VALUE; it is never taken from the command line.')
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const value = Buffer.concat(chunks).toString('utf8').trim()
  if (!value) fail('no new value was given on stdin.')
  return value
}

function managementApi(token: string, ref: string): SupabasePort {
  const base = `https://api.supabase.com/v1/projects/${ref}`
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    // the error text may quote the statement (and so a value): it goes through the same scrubber as the logs
    if (!res.ok) throw new RotationError(`Management API ${path} answered HTTP ${res.status}: ${sanitizeText(text).slice(0, 300)}`)
    return text
  }
  return {
    async setSecrets(secrets) {
      registerSecret(...Object.values(secrets))
      await call('/secrets', Object.entries(secrets).map(([name, value]) => ({ name, value })))
    },
    async query(sql) {
      const text = await call('/database/query', { query: sql })
      return (text.trim() === '' ? [] : JSON.parse(text)) as never[]
    },
  }
}

async function main() {
  const command = args[0]
  if (!command || flag('--help')) {
    console.log('usage: npm run secrets:rotate -- <cron | provider-key-secret | provider-key --provider NAME [--store auto|db|env] | set NAME> [--apply] [--no-env-file]')
    process.exit(command ? 0 : 1)
  }
  if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found: it must hold SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF.`)
  const env = parseEnvFile(readFileSync(ENV_FILE, 'utf8'))
  const token = env.SUPABASE_ACCESS_TOKEN
  const ref = env.SUPABASE_PROJECT_REF
  if (!token || !ref) fail('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF must be set in .env.local. Nothing was changed.')
  if (!/^[a-z0-9]{20}$/.test(ref!)) fail('SUPABASE_PROJECT_REF does not look like a project ref. Nothing was changed.')
  registerSecret(token, env.PROVIDER_KEY_SECRET, env.CRON_SECRET, env.JWT_SECRET, env.SUPABASE_DB_PASSWORD)

  const apply = flag('--apply')
  const api = managementApi(token!, ref!)
  let result: RotationResult
  if (command === 'cron') {
    result = await rotateCronSecret(api, { apply })
  } else if (command === 'provider-key-secret') {
    result = await rotateProviderKeySecret(api, { apply, oldMaster: env.PROVIDER_KEY_SECRET || undefined })
  } else if (command === 'provider-key') {
    const provider = option('--provider')
    if (!provider) fail('provider-key needs --provider "<name as in the providers table>".')
    const store = (option('--store') ?? 'auto') as 'auto' | 'db' | 'env'
    if (!['auto', 'db', 'env'].includes(store)) fail('--store must be auto, db or env.')
    const newKey = await readNewValue()
    registerSecret(newKey)
    result = await rotateProviderApiKey(api, { apply, provider: provider!, newKey, master: env.PROVIDER_KEY_SECRET || undefined, store })
  } else if (command === 'set') {
    const name = args[1]
    if (!name || !(SETTABLE as readonly string[]).includes(name)) fail(`set needs one of: ${SETTABLE.join(', ')}.`)
    const value = await readNewValue()
    registerSecret(value)
    result = await setIssuedSecret(api, { apply, name: name!, value })
  } else {
    return fail(`unknown command "${command}".`)
  }
  registerSecret(...Object.values(result.envUpdates))

  console.log(`rotate-secrets: ${command} on project ${ref} (${apply ? 'APPLIED' : 'dry run, nothing written'})`)
  for (const s of result.steps) console.log(`  - ${s}`)
  if (!apply) {
    console.log('\nRun again with --apply to perform these steps.')
    return
  }
  if (Object.keys(result.envUpdates).length > 0 && !flag('--no-env-file')) {
    writeFileSync(ENV_FILE, applyEnvUpdates(readFileSync(ENV_FILE, 'utf8'), result.envUpdates))
    console.log(`  - ${ENV_FILE} updated: ${Object.keys(result.envUpdates).join(', ')}`)
  }
  console.log('\nDone. Edge Functions read the new value on their next start (within a minute). Verify: docs/RUNBOOK.md, "After any rotation".')
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
