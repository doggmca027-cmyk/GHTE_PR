import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

// Regression test for "Can't sign you in. Please open this app from Telegram." shown INSIDE Telegram.
// Cause: in a production bundle `import WebApp from '@twa-dev/sdk'` returned the CommonJS exports object (and a bare
// side-effect import was tree-shaken away), so WebApp.initData was always empty. src/lib/webapp.ts now reads
// window.Telegram.WebApp, which Telegram's own script (index.html) defines. This builds that module with the project's
// own bundler and runs the result against a fake Telegram launch, like the real page does.

const root = path.resolve(__dirname, '..')
const INIT_DATA = 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A42%7D&auth_date=1700000000&hash=abc123'
// Stands in for https://telegram.org/js/telegram-web-app.js (same code the npm SDK ships).
const TELEGRAM_SCRIPT = fs.readFileSync(path.join(root, 'node_modules/@twa-dev/sdk/dist/telegram-web-apps.js'), 'utf8')

async function bundle(entrySource: string): Promise<string> {
  // The probe must live inside the project so imports resolve exactly as they do for the app.
  const dir = fs.mkdtempSync(path.join(root, 'tests', '.probe-'))
  const entry = path.join(dir, 'entry.ts')
  fs.writeFileSync(entry, entrySource)
  try {
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, minify: true, lib: { entry, formats: ['iife'], name: 'Probe' } },
    })
    const out = Array.isArray(result) ? result[0] : result
    if (!('output' in out)) throw new Error('unexpected build result')
    const chunk = out.output.find((o) => o.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('no chunk')
    return chunk.code
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** A fake WebView window. With `withTelegramScript` it first runs Telegram's own script, like the <script> tag in index.html. */
function runInFakeTelegram(code: string, hash: string, withTelegramScript = true): Record<string, unknown> {
  const store: Record<string, string> = {}
  const win: Record<string, unknown> = {
    location: { hash, href: `https://app.example/${hash}`, search: '' },
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    sessionStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'test' }, innerHeight: 800, innerWidth: 400,
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    document: {
      documentElement: { style: { setProperty() {} } }, head: { appendChild() {} }, body: { appendChild() {} },
      getElementsByTagName: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      addEventListener() {}, removeEventListener() {}, querySelector: () => null, getElementById: () => null,
    },
  }
  win.window = win
  win.self = win
  win.top = win
  win.parent = win
  win.globalThis = win
  const ctx = vm.createContext(win)
  if (withTelegramScript) vm.runInContext(TELEGRAM_SCRIPT, ctx)
  vm.runInContext(code, ctx)
  return win
}

const PROBE = `
  import { WebApp } from '../../src/lib/webapp.ts'
  ;(globalThis as any).__probe = { initData: WebApp.initData, platform: WebApp.platform, ready: typeof WebApp.ready, haptic: typeof WebApp.HapticFeedback }
`

describe('Telegram WebApp in the production bundle', () => {
  it('exposes initData from the launch parameters', async () => {
    const win = runInFakeTelegram(
      await bundle(PROBE),
      `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.0&tgWebAppPlatform=weba&tgWebAppThemeParams=%7B%7D`,
    )
    expect(win.__probe).toEqual({ initData: INIT_DATA, platform: 'weba', ready: 'function', haptic: 'object' })
  })

  it('has an empty initData (and no crash) in a plain browser', async () => {
    const win = runInFakeTelegram(await bundle(PROBE), '')
    expect(win.__probe).toMatchObject({ initData: '', ready: 'function' })
  })

  it('degrades to "not in Telegram" when Telegram\'s script did not load', async () => {
    const win = runInFakeTelegram(await bundle(PROBE), '', false)
    expect(win.__probe).toEqual({ initData: '', platform: undefined, ready: 'function', haptic: 'object' })
  })
})
