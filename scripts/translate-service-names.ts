// npm run translate-names [-- --limit 500 --batch 25 --all --dry-run --langs ru,es]
//
// Translates the English names of the services into the app's other 14 languages with Gemini and saves them in services.name_translations
// ({"ru": "...", "es": "..."}). The first runs are for Premium cards only (--all adds the rest). Safe to repeat: it takes the cards that have none
// yet, and the sync of the catalogue never writes that column. Reads .env.local; prints no secret.
//
//   GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)   the Gemini key, in the environment or in .env.local
//   SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF         the same pair the other maintenance scripts use (SQL through the Management API)
import fs from 'node:fs'
import { buildPrompt, parseBatch, saveTranslationsSql, selectUntranslatedSql, TARGET_LANGUAGES, type ServiceName } from './lib/translate-names.ts'

const MODEL = process.env.TRANSLATE_MODEL ?? 'gemini-3.5-flash-lite'

function readEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
    }
  } catch { /* no file: the environment has to carry them */ }
  return env
}

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback }

const env = readEnv()
const apiKey = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY
const token = env.SUPABASE_ACCESS_TOKEN
const ref = env.SUPABASE_PROJECT_REF
if (!apiKey || !token || !ref) {
  console.error('Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY), SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF (environment or .env.local).')
  process.exit(1)
}

const langs = option('langs', Object.keys(TARGET_LANGUAGES).join(',')).split(',').filter((l) => l in TARGET_LANGUAGES)
const limit = Number(option('limit', '500'))
const batchSize = Math.max(1, Math.min(40, Number(option('batch', '25'))))
const dryRun = flag('dry-run')

async function sql<T>(query: string): Promise<T> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`database ${res.status}`)
  return (await res.json()) as T
}

async function translate(batch: ServiceName[]): Promise<ReturnType<typeof parseBatch>> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey! },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(batch.map((b) => b.name), langs) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  })
  if (!res.ok) throw new Error(`gemini ${res.status}`)
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return parseBatch(body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '', batch, langs)
}

const todo = await sql<ServiceName[]>(selectUntranslatedSql(limit, flag('all')))
console.log(`${todo.length} cards without translations${flag('all') ? '' : ' (Premium only; --all for the rest)'}, ${langs.length} languages, batches of ${batchSize}${dryRun ? ', dry run' : ''}`)

let saved = 0
let skipped = 0
for (let at = 0; at < todo.length; at += batchSize) {
  const batch = todo.slice(at, at + batchSize)
  let answer: Awaited<ReturnType<typeof translate>>
  try {
    answer = await translate(batch)
  } catch (e) {
    console.error(`batch ${at / batchSize + 1}: ${e instanceof Error ? e.message : 'failed'} (left for the next run)`)
    continue
  }
  const rows = batch.flatMap((b) => (answer.has(b.id) ? [{ id: b.id, name: b.name, tr: answer.get(b.id)! }] : []))
  skipped += batch.length - rows.length
  const statement = saveTranslationsSql(rows)
  if (statement && !dryRun) await sql(statement)
  saved += rows.length
  if (dryRun && rows[0]) console.log(JSON.stringify({ name: rows[0].name, tr: rows[0].tr }))
  console.log(`batch ${at / batchSize + 1}: ${rows.length} saved, ${batch.length - rows.length} left`)
}
console.log(`done: ${saved} cards translated${dryRun ? ' (nothing written)' : ''}, ${skipped} left for the next run`)
