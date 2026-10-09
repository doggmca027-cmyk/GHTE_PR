// What a translator needs: every text the app asks to have translated, and what each language is still missing.
//
//   npm run i18n:keys              # a summary per language (exit 1 if any language is incomplete)
//   npm run i18n:keys -- --list    # also prints the English texts, one per line
//   npm run i18n:keys -- ru        # the texts Russian is missing, ready to paste into src/i18n/locales/ru.ts
//
// A new text is added by writing t('English text') in the code; tests/i18n.test.ts fails until all 14 dictionaries have it.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectKeys } from './lib/i18n-keys.ts'

const CODES = ['ru', 'uk', 'es', 'pt', 'id', 'tr', 'ar', 'hi', 'fr', 'de', 'it', 'vi', 'zh', 'ja']
const src = path.resolve(import.meta.dirname, '../src')
const { keys } = collectKeys(src)
const args = process.argv.slice(2)

if (args.includes('--list')) for (const k of [...keys.keys()].sort((a, b) => a.localeCompare(b))) console.log(k)

const wanted = args.filter((a) => CODES.includes(a))
let incomplete = false
for (const code of wanted.length > 0 ? wanted : CODES) {
  const dict = (await import(pathToFileURL(path.join(src, `i18n/locales/${code}.ts`)).href)).default as Record<string, string>
  const missing = [...keys.keys()].filter((k) => !(k in dict))
  const stale = Object.keys(dict).filter((k) => !keys.has(k))
  if (missing.length > 0 || stale.length > 0) incomplete = true
  console.log(`${code}: ${keys.size - missing.length}/${keys.size} translated${stale.length > 0 ? `, ${stale.length} stale` : ''}`)
  if (wanted.length > 0) {
    for (const k of missing) console.log(`  ${JSON.stringify(k)}: '',`)
    for (const k of stale) console.log(`  stale: ${JSON.stringify(k)}`)
  }
}
process.exitCode = incomplete ? 1 : 0
