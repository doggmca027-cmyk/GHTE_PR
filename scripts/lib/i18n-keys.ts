// Finds every text the app asks to have translated: the string literal handed to t('...') or tr('...') anywhere under src/.
// Used by tests/i18n.test.ts (completeness of the 14 dictionaries) and by `npm run i18n:keys` (to see what a translator needs).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['locales', 'node_modules'])

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(full)
    } else if (/\.(ts|tsx)$/.test(name)) yield full
  }
}

// t( / tr( followed by a quoted literal. The `\b` keeps `str(` and `.concat(` out; escapes inside the literal are honoured.
const CALL = /(?<![\w.$])(?:t|tr)\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g
const TEMPLATE_CALL = /(?<![\w.$])(?:t|tr)\(\s*`/g

const unescape = (raw: string, quote: string): string =>
  raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.startsWith('u') && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16))
    if (c === 'n') return '\n'
    if (c === quote || c === '\\' || c === "'" || c === '"') return c
    return c
  })

export interface Collected {
  /** English text -> the files that use it. */
  keys: Map<string, string[]>
  /** Calls written with a template literal (their text cannot be found by reading the code): a test forbids them. */
  templateCalls: string[]
}

export function collectKeys(srcDir: string): Collected {
  const keys = new Map<string, string[]>()
  const templateCalls: string[] = []
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8')
    const rel = path.relative(srcDir, file).replace(/\\/g, '/')
    for (const m of text.matchAll(CALL)) {
      const key = unescape(m[2], m[1])
      keys.set(key, [...(keys.get(key) ?? []), rel])
    }
    if (TEMPLATE_CALL.test(text)) templateCalls.push(rel)
    TEMPLATE_CALL.lastIndex = 0
  }
  return { keys, templateCalls }
}

/** The `{name}` placeholders of a message, sorted. */
export const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
