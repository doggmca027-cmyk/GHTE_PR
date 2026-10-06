// Production smoke test: run it after every deployment (and from your laptop before go-live).
// It reads / probes; it never creates orders or moves money.
//
//   npm run smoke -- --env-file .env.local --secrets-file .env.local [--run-workers] [--deposits-off]
//
// smoke.env (keep it OUT of git; the pattern ".env.*" is already ignored):
//   SUPABASE_URL=https://<ref>.supabase.co          (or VITE_SUPABASE_URL)
//   SUPABASE_ANON_KEY=...                           (or VITE_SUPABASE_ANON_KEY)   public key only
//   APP_URL=https://your-app.vercel.app             deployed frontend
//   JWT_SECRET=...            optional: enables the authentication checks (strongly recommended)
//   CRON_SECRET=...           optional: with --run-workers runs one idempotent order sync
//   TELEGRAM_BOT_TOKEN=...    optional: verifies the bot + menu button
//   TON_RECIPIENT_ADDRESS=... TON_NETWORK=mainnet  TONCENTER_API_KEY=...   optional: verifies TON
//
// Variables may also come from the shell. A path given with --secrets-file is validated offline
// (same rules as `npm run verify:secrets`).

import { existsSync, readFileSync } from 'node:fs'
import { extractFunctionSecrets, parseEnvFile } from './lib/env-checks.ts'
import { formatResults, runSmokeTests, summarize, type SmokeConfig } from './lib/smoke.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))

let env: Record<string, string | undefined> = { ...process.env }
for (const file of values('--env-file')) {
  if (!existsSync(file)) {
    console.error(`smoke: env file not found: ${file}`)
    process.exit(2)
  }
  env = { ...env, ...parseEnvFile(readFileSync(file, 'utf8')) }
}

// An empty value in an env file means "not set" (not an empty string that would defeat `??` fallbacks).
env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v]))

const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
const anonKey = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY
if (!supabaseUrl || !anonKey) {
  console.error('smoke: SUPABASE_URL and SUPABASE_ANON_KEY (the public anon / publishable key) are required.\nSee the header of scripts/smoke-test.ts.')
  process.exit(2)
}
if (anonKey.startsWith('sb_secret_') || /"role"\s*:\s*"service_role"/.test(Buffer.from(anonKey.split('.')[1] ?? '', 'base64').toString('utf8'))) {
  console.error('smoke: refusing to run with a service-role / secret key. Use the public anon key.')
  process.exit(2)
}

const secretsFile = values('--secrets-file')[0]
const cfg: SmokeConfig = {
  supabaseUrl,
  anonKey,
  appUrl: env.APP_URL,
  jwtSecret: env.JWT_SECRET,
  cronSecret: env.CRON_SECRET,
  runWorkers: flag('--run-workers'),
  depositsOff: flag('--deposits-off'),
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  tonRecipientAddress: env.TON_RECIPIENT_ADDRESS,
  tonNetwork: env.TON_NETWORK,
  toncenterApiKey: env.TONCENTER_API_KEY,
  toncenterUrl: env.TONCENTER_URL,
  functionSecrets: secretsFile && existsSync(secretsFile) ? extractFunctionSecrets(parseEnvFile(readFileSync(secretsFile, 'utf8'))) : undefined,
}

console.log(`smoke: ${new URL(supabaseUrl).host}${cfg.appUrl ? ` + ${new URL(cfg.appUrl).host}` : ''}`)
const results = await runSmokeTests(cfg)
console.log(formatResults(results))
process.exit(summarize(results).fail > 0 ? 1 : 0)
