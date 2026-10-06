// Scans the repository for hard-coded secrets and checks that env files cannot be committed.
// Wire it into CI (it is part of `npm run check`). Exit code 1 on any finding.
//
// A line that is deliberately public (e.g. the sample bot token from Telegram's docs used as a test
// vector) can carry the marker comment  `secret-scan:allow`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { scanTextForSecrets, type ScanHit } from './lib/env-checks.ts'

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vercel', '.temp', '.next', 'coverage'])
const SKIP_FILES = new Set(['package-lock.json'])
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.zip', '.pdf'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const files = walk(root)
const problems: string[] = []
const hits: ScanHit[] = []

// 1. Real env files must exist only locally and be git-ignored.
const envFiles = files.filter((f) => /(^|[\\/])\.env(\..+)?$/.test(f) && !f.endsWith('.example'))
const gitignore = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()) : []
const REQUIRED_IGNORES = ['.env', '.env.*', 'supabase/functions/.env', 'supabase/functions/.env.*', '.vercel', 'node_modules', 'dist']
for (const pattern of REQUIRED_IGNORES) {
  if (!gitignore.includes(pattern)) problems.push(`.gitignore is missing "${pattern}"`)
}
if (!gitignore.includes('!.env.example') || !gitignore.includes('!supabase/functions/.env.example')) {
  problems.push('.gitignore must re-include the example files (!.env.example, !supabase/functions/.env.example)')
}
const committedEnv = envFiles.map((f) => relative(root, f).split(sep).join('/')).filter((f) => f !== '.env.production') // .env.production only holds public defaults, checked below
if (committedEnv.length > 0) console.log(`note: local env files present (must stay untracked): ${committedEnv.join(', ')}`)

// 2. Content scan. Local untracked env files are skipped (they legitimately hold secrets).
for (const file of files) {
  const rel = relative(root, file).split(sep).join('/')
  const base = file.split(sep).pop() ?? ''
  if (SKIP_FILES.has(base) || BINARY.has(extname(file).toLowerCase())) continue
  if (/^\.env(\..+)?$/.test(base) && !base.endsWith('.example') && base !== '.env.production') continue
  if (statSync(file).size > 2_000_000) continue
  hits.push(...scanTextForSecrets(rel, readFileSync(file, 'utf8')))
}

// 3. The committed .env.production may only hold non-secret defaults.
const prod = join(root, '.env.production')
if (existsSync(prod)) {
  for (const line of readFileSync(prod, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=/.exec(line.trim())
    if (m && !['VITE_MOCK_MODE'].includes(m[1])) problems.push(`.env.production may only set VITE_MOCK_MODE (found ${m[1]}); real values belong in Vercel`)
  }
}

for (const h of hits) problems.push(`${h.file}:${h.line}  ${h.message} [${h.id}]`)

if (problems.length > 0) {
  console.error(`scan-secrets: ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`scan-secrets: OK (${files.length} files scanned, no hard-coded secrets).`)
