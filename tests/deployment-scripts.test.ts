import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Address } from '@ton/core'
import { describe, expect, it } from 'vitest'
import { verifyJwt } from '../supabase/functions/_shared/jwt.ts'
import { tonAddressFlags } from '../supabase/functions/_shared/ton.ts'
import {
  buildManifest,
  checkClientEnv,
  checkFunctionSecrets,
  checkManifest,
  decodeJwtPayload,
  extractFunctionSecrets,
  hasErrors,
  parseEnvFile,
  resolveAppUrl,
  scanBundleForSecrets,
  scanTextForSecrets,
  type Finding,
} from '../scripts/lib/env-checks.ts'
import { formatResults, runSmokeTests, summarize, type CheckResult, type SmokeConfig } from '../scripts/lib/smoke.ts'

// --- fixtures built at runtime (no secret-looking literals in the source) -----------------------
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeJwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.${'s'.repeat(24)}`
const REF = 'abcdefghijklmnopqrst'
const ANON = fakeJwt({ role: 'anon', ref: REF })
const SERVICE = fakeJwt({ role: 'service_role', ref: REF })
const GOOD_URL = `https://${REF}.supabase.co`
const BOT_TOKEN = `${'1'.repeat(9)}:${'A'.repeat(35)}`
const MAINNET_ADDR = new Address(0, Buffer.alloc(32, 7)).toString({ bounceable: false })
const TESTNET_ADDR = new Address(0, Buffer.alloc(32, 7)).toString({ bounceable: false, testOnly: true })

const ids = (f: Finding[], level?: Finding['level']) => f.filter((x) => !level || x.level === level).map((x) => x.id)

// ---------------------------------------------------------------------------
// env file parsing
// ---------------------------------------------------------------------------

describe('parseEnvFile', () => {
  it('parses KEY=VALUE with comments, quotes, export and blank lines', () => {
    const env = parseEnvFile(`
      # comment
      A=1
      export B = "two words"
      C='three'
      D=4 # trailing comment
      E=
      not a pair
      F=https://x.test/path?a=1#frag
    `)
    expect(env).toEqual({ A: '1', B: 'two words', C: 'three', D: '4', E: '', F: 'https://x.test/path?a=1#frag' })
  })
})

// ---------------------------------------------------------------------------
// client (Vercel) environment
// ---------------------------------------------------------------------------

describe('checkClientEnv', () => {
  const good = { VITE_SUPABASE_URL: GOOD_URL, VITE_SUPABASE_ANON_KEY: ANON, VITE_TWA_RETURN_URL: 'https://t.me/my_bot/app' }

  it('accepts a correct production configuration', () => {
    expect(checkClientEnv(good, { production: true })).toEqual([])
  })

  it('missing variables are warnings locally but errors in production', () => {
    expect(ids(checkClientEnv({}, { production: false }), 'error')).toEqual([])
    expect(ids(checkClientEnv({}, { production: false }), 'warn')).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])
    expect(ids(checkClientEnv({}, { production: true }), 'error')).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])
  })

  it('rejects a service-role / secret key used as the browser key (critical)', () => {
    for (const key of [SERVICE, 'sb_secret_abcdefghijklmnop1234']) { // secret-scan:allow (synthetic fixture)
      const f = checkClientEnv({ ...good, VITE_SUPABASE_ANON_KEY: key }, { production: false }) // fails even outside production
      expect(ids(f, 'error')).toContain('VITE_SUPABASE_ANON_KEY')
      expect(f.find((x) => x.id === 'VITE_SUPABASE_ANON_KEY')!.message).toMatch(/CRITICAL/)
    }
    expect(checkClientEnv({ ...good, VITE_SUPABASE_ANON_KEY: 'sb_publishable_abcdefghijkl' }, { production: true })).toEqual([])
  })

  it('catches an anon key from a different project than the URL', () => {
    const other = fakeJwt({ role: 'anon', ref: 'zzzzzzzzzzzzzzzzzzzz' })
    expect(ids(checkClientEnv({ ...good, VITE_SUPABASE_ANON_KEY: other }, { production: true }), 'error')).toContain('VITE_SUPABASE_ANON_KEY')
  })

  it('validates the URL', () => {
    expect(ids(checkClientEnv({ ...good, VITE_SUPABASE_URL: 'http://x.supabase.co' }, { production: true }), 'error')).toContain('VITE_SUPABASE_URL')
    expect(ids(checkClientEnv({ ...good, VITE_SUPABASE_URL: 'not a url' }, { production: true }), 'error')).toContain('VITE_SUPABASE_URL')
    expect(ids(checkClientEnv({ ...good, VITE_SUPABASE_URL: 'http://localhost:54321', VITE_SUPABASE_ANON_KEY: 'sb_publishable_x' }, { production: false }), 'error')).toEqual([])
  })

  it('mock mode: a production build must never contain it', () => {
    expect(ids(checkClientEnv({ ...good, VITE_MOCK_MODE: 'true' }, { production: true }), 'error')).toContain('VITE_MOCK_MODE')
    expect(ids(checkClientEnv({ ...good, VITE_MOCK_MODE: 'true' }, { production: false }), 'warn')).toContain('VITE_MOCK_MODE')
    expect(ids(checkClientEnv({ ...good, VITE_MOCK_MODE: 'true' }, { production: false }), 'error')).toEqual([])
    expect(checkClientEnv({ ...good, VITE_MOCK_MODE: 'false' }, { production: true })).toEqual([])
    expect(ids(checkClientEnv({ ...good, VITE_MOCK_MODE: 'TRUE' }, { production: true }), 'warn')).toContain('VITE_MOCK_MODE') // ignored by the app, but flagged
  })

  it('refuses anything secret-looking exposed through a VITE_ variable', () => {
    for (const name of ['VITE_SERVICE_ROLE_KEY', 'VITE_BOT_TOKEN', 'VITE_JWT_SECRET', 'VITE_CRON_SECRET', 'VITE_PROVIDER_API_KEY']) {
      expect(ids(checkClientEnv({ ...good, [name]: 'x' }, { production: false }), 'error')).toContain(name)
    }
    expect(ids(checkClientEnv({ ...good, VITE_INNOCENT: BOT_TOKEN }, { production: false }), 'error')).toContain('VITE_INNOCENT')
    expect(ids(checkClientEnv({ ...good, VITE_INNOCENT: SERVICE }, { production: false }), 'error')).toContain('VITE_INNOCENT')
    expect(checkClientEnv({ ...good, VITE_ANYTHING_ELSE: 'hello' }, { production: true })).toEqual([])
  })

  it('warns about a missing / odd Telegram return URL', () => {
    expect(ids(checkClientEnv({ VITE_SUPABASE_URL: GOOD_URL, VITE_SUPABASE_ANON_KEY: ANON }, { production: true }), 'warn')).toContain('VITE_TWA_RETURN_URL')
    expect(ids(checkClientEnv({ ...good, VITE_TWA_RETURN_URL: 'https://example.com' }, { production: true }), 'warn')).toContain('VITE_TWA_RETURN_URL')
  })

  it('decodes JWT payloads defensively', () => {
    expect(decodeJwtPayload(ANON)).toMatchObject({ role: 'anon' })
    expect(decodeJwtPayload('nope')).toBeNull()
    expect(decodeJwtPayload('a.b.c')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// app URL + TON Connect manifest
// ---------------------------------------------------------------------------

describe('TON Connect manifest', () => {
  const template = { url: 'https://your-domain.example', name: 'SMM Mini App', iconUrl: 'https://your-domain.example/tonconnect-icon.png' }

  it('resolves the public URL: APP_URL wins, then Vercel production domain', () => {
    expect(resolveAppUrl({ APP_URL: 'https://app.example.com/' })).toBe('https://app.example.com')
    expect(resolveAppUrl({ APP_URL: 'app.example.com', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' })).toBe('https://app.example.com')
    expect(resolveAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'my-app.vercel.app' })).toBe('https://my-app.vercel.app')
    expect(resolveAppUrl({})).toBeUndefined()
  })

  it('rewrites every URL to the real origin and links the shipped terms / privacy pages', () => {
    const m = buildManifest(template, 'https://app.example.com')
    expect(m).toEqual({
      url: 'https://app.example.com', name: 'SMM Mini App', iconUrl: 'https://app.example.com/tonconnect-icon.png',
      termsOfUseUrl: 'https://app.example.com/terms', privacyPolicyUrl: 'https://app.example.com/privacy',
    })
    const custom = buildManifest(template, 'https://app.example.com', { TERMS_URL: 'https://legal.example.org/tos', PRIVACY_URL: '  ' })
    expect(custom.termsOfUseUrl).toBe('https://legal.example.org/tos') // override wins
    expect(custom.privacyPolicyUrl).toBe('https://app.example.com/privacy') // blank = default
  })

  it('the placeholder is an error in production, a warning otherwise', () => {
    expect(ids(checkManifest(template, { production: true }), 'error')).toContain('manifest.placeholder')
    expect(ids(checkManifest(template, { production: false }), 'warn')).toContain('manifest.placeholder')
    expect(checkManifest(buildManifest(template, 'https://app.example.com'), { production: true, appUrl: 'https://app.example.com' })).toEqual([])
  })

  it('flags SVG icons, http URLs, missing fields and an origin mismatch', () => {
    const real = buildManifest(template, 'https://app.example.com')
    expect(ids(checkManifest({ ...real, iconUrl: 'https://app.example.com/icon.svg' }, { production: true }), 'error')).toContain('manifest.iconUrl')
    expect(ids(checkManifest({ ...real, url: 'http://app.example.com' }, { production: true }), 'error')).toContain('manifest.https')
    expect(hasErrors(checkManifest({ name: 'x' }, { production: true }))).toBe(true)
    expect(ids(checkManifest(real, { production: true, appUrl: 'https://other.example.com' }), 'warn')).toContain('manifest.origin')
    expect(hasErrors(checkManifest(null, { production: true }))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Supabase function secrets
// ---------------------------------------------------------------------------

describe('checkFunctionSecrets', () => {
  const good = {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    JWT_SECRET: 'j'.repeat(40),
    CRON_SECRET: 'c'.repeat(64),
    TON_RECIPIENT_ADDRESS: MAINNET_ADDR,
    TON_NETWORK: 'mainnet',
    PROVIDER_SECSERS_API_KEY: 'provider-key',
    ADMIN_TELEGRAM_IDS: '123456789, 42',
    ALLOWED_ORIGIN: 'https://my-app.vercel.app',
    TONCENTER_API_KEY: 'k',
  }

  it('accepts a complete production configuration', () => {
    expect(checkFunctionSecrets(good)).toEqual([])
  })

  it('every required secret is enforced, and empty counts as missing', () => {
    for (const name of ['TELEGRAM_BOT_TOKEN', 'JWT_SECRET', 'CRON_SECRET', 'TON_RECIPIENT_ADDRESS', 'TON_NETWORK']) {
      const { [name as keyof typeof good]: _removed, ...rest } = good
      expect(ids(checkFunctionSecrets(rest), 'error')).toContain(name)
      expect(ids(checkFunctionSecrets({ ...good, [name]: '  ' }), 'error')).toContain(name)
    }
  })

  it('deposits can be switched off on purpose: both TON values absent is fine, only one of them is not', () => {
    const { TON_RECIPIENT_ADDRESS: _a, TON_NETWORK: _n, ...off } = good
    const f = checkFunctionSecrets(off)
    expect(ids(f, 'error')).toEqual([])
    expect(f.find((x) => x.id === 'TON_*')!.message).toMatch(/DEPOSITS ARE DISABLED/)
    const { TON_NETWORK: _only, ...addressOnly } = good // would silently mean mainnet
    expect(ids(checkFunctionSecrets(addressOnly), 'error')).toContain('TON_NETWORK')
    const { TON_RECIPIENT_ADDRESS: _only2, ...networkOnly } = good
    expect(ids(checkFunctionSecrets(networkOnly), 'error')).toContain('TON_RECIPIENT_ADDRESS')
  })

  it('TON_NETWORK must be exact (a typo would silently mean mainnet)', () => {
    for (const bad of ['Mainnet', 'test', 'testnet ', 'main', '1']) {
      expect(ids(checkFunctionSecrets({ ...good, TON_NETWORK: bad }), 'error'), bad).toContain('TON_NETWORK')
    }
    expect(ids(checkFunctionSecrets({ ...good, TON_NETWORK: 'testnet', TON_RECIPIENT_ADDRESS: TESTNET_ADDR }), 'error')).toEqual([])
  })

  it('catches a testnet address on mainnet (deposits would go nowhere real) and bad addresses', () => {
    expect(tonAddressFlags(TESTNET_ADDR)).toMatchObject({ testOnly: true })
    expect(tonAddressFlags(MAINNET_ADDR)).toMatchObject({ testOnly: false })
    expect(ids(checkFunctionSecrets({ ...good, TON_RECIPIENT_ADDRESS: TESTNET_ADDR }), 'error')).toContain('TON_RECIPIENT_ADDRESS')
    expect(ids(checkFunctionSecrets({ ...good, TON_RECIPIENT_ADDRESS: 'UQ-not-an-address' }), 'error')).toContain('TON_RECIPIENT_ADDRESS')
    const corrupted = MAINNET_ADDR.slice(0, -2) + (MAINNET_ADDR.endsWith('A') ? 'BB' : 'AA')
    expect(ids(checkFunctionSecrets({ ...good, TON_RECIPIENT_ADDRESS: corrupted }), 'error')).toContain('TON_RECIPIENT_ADDRESS')
    expect(ids(checkFunctionSecrets({ ...good, TON_NETWORK: 'testnet' }), 'warn')).toContain('TON_RECIPIENT_ADDRESS') // mainnet address on testnet
    expect(ids(checkFunctionSecrets({ ...good, TON_RECIPIENT_ADDRESS: new Address(0, Buffer.alloc(32, 7)).toRawString() }), 'warn')).toContain('TON_RECIPIENT_ADDRESS')
  })

  it('MOCK_MODE=true is fatal in production; dev-only variables are flagged', () => {
    expect(ids(checkFunctionSecrets({ ...good, MOCK_MODE: 'true' }), 'error')).toContain('MOCK_MODE')
    expect(ids(checkFunctionSecrets({ ...good, MOCK_MODE: 'false' }), 'warn')).toContain('MOCK_MODE')
    expect(ids(checkFunctionSecrets({ ...good, TON_USD_FALLBACK_RATE: '5' }), 'warn')).toContain('TON_USD_FALLBACK_RATE')
  })

  it('reserved SUPABASE_ names are rejected (the CLI refuses them)', () => {
    expect(ids(checkFunctionSecrets({ ...good, SUPABASE_JWT_SECRET: 'x' }), 'error')).toContain('SUPABASE_JWT_SECRET')
  })

  it('weak or malformed secrets are errors', () => {
    expect(ids(checkFunctionSecrets({ ...good, JWT_SECRET: 'short' }), 'error')).toContain('JWT_SECRET')
    expect(ids(checkFunctionSecrets({ ...good, JWT_SECRET: ANON }), 'error')).toContain('JWT_SECRET') // an API key is not the JWT secret
    expect(ids(checkFunctionSecrets({ ...good, CRON_SECRET: 'abc' }), 'error')).toContain('CRON_SECRET')
    expect(ids(checkFunctionSecrets({ ...good, CRON_SECRET: 'c'.repeat(20) }), 'warn')).toContain('CRON_SECRET')
    expect(ids(checkFunctionSecrets({ ...good, TELEGRAM_BOT_TOKEN: 'abc' }), 'error')).toContain('TELEGRAM_BOT_TOKEN')
  })

  it('provider keys: need one, and misnamed ones are caught', () => {
    const { PROVIDER_SECSERS_API_KEY: _k, ...noProvider } = good
    expect(ids(checkFunctionSecrets(noProvider), 'warn')).toContain('PROVIDER_*_API_KEY')
    // a decryption secret alone is not a provider key: the warning stays (and explains the DB requirement)
    const withSecretOnly = checkFunctionSecrets({ ...noProvider, PROVIDER_KEY_SECRET: Buffer.alloc(32, 1).toString('base64') })
    expect(ids(withSecretOnly, 'warn')).toContain('PROVIDER_*_API_KEY')
    expect(withSecretOnly.find((f) => f.id === 'PROVIDER_*_API_KEY')!.message).toMatch(/api_key_encrypted/)
    expect(ids(checkFunctionSecrets({ ...good, PROVIDER_KEY_SECRET: 'tooshort' }), 'error')).toContain('PROVIDER_KEY_SECRET')
    expect(ids(checkFunctionSecrets({ ...good, PROVIDER_SECSERS_KEY: 'x' }), 'warn')).toContain('PROVIDER_SECSERS_KEY')
  })

  it('admins and CORS', () => {
    expect(ids(checkFunctionSecrets({ ...good, ADMIN_TELEGRAM_IDS: 'abc' }), 'error')).toContain('ADMIN_TELEGRAM_IDS')
    expect(ids(checkFunctionSecrets({ ...good, ADMIN_TELEGRAM_IDS: '1, junk' }), 'warn')).toContain('ADMIN_TELEGRAM_IDS')
    const { ADMIN_TELEGRAM_IDS: _a, ...noAdmin } = good
    expect(ids(checkFunctionSecrets(noAdmin), 'warn')).toContain('ADMIN_TELEGRAM_IDS')
    for (const bad of ['https://app.example.com/', 'https://app.example.com/path', 'app.example.com']) {
      expect(ids(checkFunctionSecrets({ ...good, ALLOWED_ORIGIN: bad }), 'error'), bad).toContain('ALLOWED_ORIGIN')
    }
    const { ALLOWED_ORIGIN: _o, ...noOrigin } = good
    expect(ids(checkFunctionSecrets(noOrigin), 'warn')).toContain('ALLOWED_ORIGIN')
  })

  it('tuning values are validated', () => {
    expect(ids(checkFunctionSecrets({ ...good, SYNC_BATCH_SIZE: '0' }), 'error')).toContain('SYNC_BATCH_SIZE')
    expect(ids(checkFunctionSecrets({ ...good, SYNC_BATCH_SIZE: '500' }), 'error')).toContain('SYNC_BATCH_SIZE')
    expect(ids(checkFunctionSecrets({ ...good, RECONCILE_AFTER_MINUTES: '-5' }), 'error')).toContain('RECONCILE_AFTER_MINUTES')
    expect(ids(checkFunctionSecrets({ ...good, RECONCILE_AFTER_MINUTES: '5' }), 'warn')).toContain('RECONCILE_AFTER_MINUTES')
    expect(checkFunctionSecrets({ ...good, SYNC_BATCH_SIZE: '100', RECONCILE_AFTER_MINUTES: '60' })).toEqual([])
  })

  it('never echoes secret values in its messages', () => {
    const everything = checkFunctionSecrets({ ...good, JWT_SECRET: 'LEAKME-short', CRON_SECRET: 'LEAKME', TELEGRAM_BOT_TOKEN: 'LEAKME-token', MOCK_MODE: 'true' })
    expect(JSON.stringify(everything)).not.toContain('LEAKME')
  })
})

// ---------------------------------------------------------------------------
// secret scanning
// ---------------------------------------------------------------------------

describe('scanTextForSecrets', () => {
  const scan = (line: string) => scanTextForSecrets('x.ts', line).map((h) => h.id)

  it('finds real-looking credentials', () => {
    expect(scan(`const t = '${BOT_TOKEN}'`)).toContain('telegram-bot-token')
    expect(scan(`const k = 'sb_secret_${'a'.repeat(30)}'`)).toContain('supabase-secret-key')
    expect(scan('-----BEGIN PRIVATE KEY-----')).toContain('private-key') // secret-scan:allow (synthetic fixture)
    expect(scan(`x = "ghp_${'a'.repeat(36)}"`)).toContain('github-token')
    expect(scan(`id: AKIA${'A'.repeat(16)}`)).toContain('aws-access-key')
    expect(scan(`const JWT_SECRET = "${'q'.repeat(40)}"`)).toContain('generic-assignment')
    expect(scan(`const a = '${SERVICE}'`)).toContain('jwt-literal')
    expect(scanTextForSecrets('x.ts', `const a = '${SERVICE}'`)[0].message).toMatch(/CRITICAL/)
  })

  it('does not flag ordinary code, hashes, env var NAMES or short test values', () => {
    expect(scan("const secret = Deno.env.get('JWT_SECRET')")).toEqual([])
    expect(scan(`const VECTOR_HASH = '${'a1'.repeat(32)}'`)).toEqual([])
    expect(scan("signJwt(claims, 'secret', 3600)")).toEqual([])
    expect(scan('JWT_SECRET=')).toEqual([])
    expect(scan('await rpc("get_admin_metrics")')).toEqual([])
  })

  it('honours the allow marker and reports line numbers', () => {
    expect(scan(`const t = '${BOT_TOKEN}' // secret-scan:allow`)).toEqual([])
    expect(scanTextForSecrets('f.ts', `ok\nok\nconst t = '${BOT_TOKEN}'`)[0]).toMatchObject({ file: 'f.ts', line: 3 })
  })
})

describe('scanBundleForSecrets', () => {
  it('flags server-only names and credentials in shipped JavaScript', () => {
    expect(scanBundleForSecrets([{ path: 'a.js', text: 'var x="SUPABASE_SERVICE_ROLE_KEY"' }])).toHaveLength(1)
    expect(scanBundleForSecrets([{ path: 'a.js', text: 'const k="service_role"' }])[0].message).toMatch(/server-only/)
    expect(scanBundleForSecrets([{ path: 'a.js', text: `x="${BOT_TOKEN}"` }]).map((h) => h.id)).toContain('telegram-bot-token')
    expect(scanBundleForSecrets([{ path: 'a.js', text: 'console.log("hello", VITE_SUPABASE_URL)' }])).toEqual([])
  })

  it('allows the PUBLIC anon key that is meant to be compiled in, but nothing else shaped like a JWT', () => {
    const sig = 'x'.repeat(43) // realistic signature length
    const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.${sig}`
    const bundle = (token: string) => [{ path: 'index.js', text: `const k="${token}";fetch(u,{headers:{apikey:k}})` }]
    expect(scanBundleForSecrets(bundle(jwt({ role: 'anon', ref: REF })))).toEqual([])
    expect(scanBundleForSecrets(bundle(jwt({ role: 'service_role', ref: REF }))).map((h) => h.message).join()).toMatch(/CRITICAL/)
    expect(scanBundleForSecrets(bundle(jwt({ role: 'authenticated' }))).map((h) => h.id)).toContain('jwt-literal')
    expect(scanBundleForSecrets(bundle(jwt({ sub: 'no-role' }))).map((h) => h.id)).toContain('jwt-literal')
  })

  it('the source scanner still rejects ANY hard-coded JWT, anon included (keys come from the environment)', () => {
    const token = `${b64url({ alg: 'HS256' })}.${b64url({ role: 'anon' })}.${'x'.repeat(43)}`
    expect(scanTextForSecrets('src/x.ts', `const k = '${token}'`).map((h) => h.id)).toContain('jwt-literal')
  })
})

// ---------------------------------------------------------------------------
// smoke test against a simulated deployment
// ---------------------------------------------------------------------------

const JWT_SECRET = 'j'.repeat(40)
const APP = 'https://my-app.vercel.app'
const PRIVATE_TABLES = ['users', 'wallets', 'wallet_transactions', 'orders', 'order_status_history', 'deposits', 'providers', 'provider_services', 'price_rules', 'admin_audit_log', 'notification_log']
const FUNCTIONS = ['telegram-auth', 'place-order', 'create-deposit', 'verify-deposit', 'sync-catalog', 'sync-order-status']
const CRON = 'c'.repeat(64)

type Handler = (url: URL, init: RequestInit, bearer: string | undefined) => Response | undefined | Promise<Response | undefined>
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A well-behaved deployment. `override` runs first so a test can break exactly one thing. */
function deployment(override: Handler = () => undefined) {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1]
    const custom = await override(url, init, bearer)
    if (custom) return custom
    const method = init.method ?? 'GET'

    if (url.host === 'api.telegram.org') {
      if (url.pathname.endsWith('/getMe')) return json(200, { ok: true, result: { username: 'my_bot' } })
      if (url.pathname.endsWith('/getChatMenuButton')) return json(200, { ok: true, result: { type: 'web_app', web_app: { url: APP } } })
    }
    if (url.host.endsWith('toncenter.com')) return json(200, { transactions: [] })

    if (url.host === 'my-app.vercel.app') {
      if (url.pathname === '/') return new Response('<html><div id="root"></div><script src="/assets/index-1.js"></script></html>', { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/assets/index-1.js') return new Response('console.log("app")')
      if (url.pathname === '/tonconnect-manifest.json') return json(200, { url: APP, name: 'SMM', iconUrl: `${APP}/tonconnect-icon.png`, termsOfUseUrl: `${APP}/terms`, privacyPolicyUrl: `${APP}/privacy` }, { 'access-control-allow-origin': '*' })
      if (url.pathname === '/terms' || url.pathname === '/privacy') return new Response('<html><body>legal</body></html>', { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/tonconnect-icon.png') return new Response('png', { headers: { 'content-type': 'image/png' } })
    }

    const fnMatch = /^\/functions\/v1\/([a-z-]+)$/.exec(url.pathname)
    if (fnMatch) {
      const name = fnMatch[1]
      if (!FUNCTIONS.includes(name)) return json(404, { message: 'Function not found' })
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': APP } })
      if (name.startsWith('sync-')) {
        return headers.get('x-cron-secret') === CRON ? json(200, { checked: 0, errors: [] }) : json(401, { error: 'unauthorized' })
      }
      if (name === 'telegram-auth') return json(401, { error: 'missing_hash' })
      const claims = bearer ? await verifyJwt(bearer, JWT_SECRET) : null
      if (!claims) return json(401, { success: false, error: 'unauthorized' })
      return json(400, { success: false, error: 'invalid_input' })
    }

    if (url.pathname === '/rest/v1/' || url.pathname === '/rest/v1') return json(200, { swagger: '2.0' })
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)
    const claims = bearer ? await verifyJwt(bearer, JWT_SECRET) : null
    if (rpc) return claims ? json(403, { code: '42501', message: 'forbidden: admin access required' }) : json(401, { code: '42501', message: 'permission denied' })
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1]
    if (table === 'categories') return json(200, [])
    if (table === 'users' && method === 'PATCH') return json(403, { code: '42501' })
    if (table && PRIVATE_TABLES.includes(table)) {
      if (claims && ['wallets', 'orders', 'users', 'wallet_transactions', 'order_status_history', 'deposits'].includes(table)) return json(200, [])
      return json(401, { code: '42501', message: `permission denied for table ${table}` })
    }
    return json(404, { message: 'not found' })
  }) as unknown as typeof fetch
}

const CFG: SmokeConfig = {
  supabaseUrl: GOOD_URL,
  anonKey: ANON,
  appUrl: APP,
  jwtSecret: JWT_SECRET,
  cronSecret: CRON,
  runWorkers: true,
  telegramBotToken: BOT_TOKEN,
  tonRecipientAddress: MAINNET_ADDR,
  tonNetwork: 'mainnet',
}

const run = (override?: Handler, cfg: Partial<SmokeConfig> = {}) => runSmokeTests({ ...CFG, ...cfg }, deployment(override))
const find = (results: CheckResult[], id: string) => results.find((r) => r.id === id)!
const failed = (results: CheckResult[]) => results.filter((r) => r.status === 'fail').map((r) => r.id)

describe('smoke test: healthy deployment', () => {
  it('passes everything', async () => {
    const results = await run()
    expect(failed(results)).toEqual([])
    expect(results.filter((r) => r.status === 'warn')).toEqual([])
    expect(summarize(results).pass).toBeGreaterThanOrEqual(25)
    for (const id of ['legal-pages', 'migrations-applied', 'anon-lockdown', 'anon-rpc-lockdown', 'postgrest-accepts-jwt', 'admin-gate', 'jwt-secret-matches', 'forged-token-rejected', 'cors', 'manifest', 'bundle-secrets', 'bot-token', 'menu-button', 'toncenter']) {
      expect(find(results, id).status, id).toBe('pass')
    }
    expect(formatResults(results)).toMatch(/\d+ passed, 0 failed/)
  })

  it('skips (not fails) the optional groups when their inputs are absent', async () => {
    const results = await run(undefined, { jwtSecret: undefined, cronSecret: undefined, runWorkers: false, appUrl: undefined, telegramBotToken: undefined, tonRecipientAddress: undefined })
    expect(failed(results)).toEqual([])
    expect(results.filter((r) => r.status === 'skip').map((r) => r.id)).toEqual(expect.arrayContaining(['jwt', 'app', 'bot', 'recipient']))
  })
})

describe('smoke test: detects broken deployments', () => {
  it('an unreachable project short-circuits with one clear failure', async () => {
    const results = await runSmokeTests(CFG, (async () => { throw new TypeError('network down') }) as unknown as typeof fetch)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: 'reachable', status: 'fail' })
  })

  it('migrations missing', async () => {
    const results = await run((u) => (u.pathname === '/rest/v1/categories' ? json(404, { code: 'PGRST205' }) : undefined))
    expect(failed(results)).toContain('migrations-applied')
  })

  it('CRITICAL: anonymous users can read a private table', async () => {
    const results = await run((u, init, bearer) => (u.pathname === '/rest/v1/users' && bearer === ANON && (init.method ?? 'GET') === 'GET' ? json(200, [{ id: 'x' }]) : undefined))
    expect(find(await Promise.resolve(results), 'anon-lockdown')).toMatchObject({ status: 'fail' })
    expect(find(results, 'anon-lockdown').detail).toMatch(/CRITICAL.*users/)
  })

  it('anon can execute a money function', async () => {
    const results = await run((u, _i, bearer) => (u.pathname === '/rest/v1/rpc/refund_order' && bearer === ANON ? json(200, {}) : undefined))
    expect(find(results, 'anon-rpc-lockdown').detail).toMatch(/refund_order/)
    expect(failed(results)).toContain('anon-rpc-lockdown')
  })

  it('PostgREST rejects our JWT: the secret is not the project secret', async () => {
    const results = await run((u, _i, bearer) => (u.pathname === '/rest/v1/wallets' && bearer && bearer !== ANON ? json(401, { code: 'PGRST301' }) : undefined))
    expect(failed(results)).toContain('postgrest-accepts-jwt')
    expect(find(results, 'postgrest-accepts-jwt').detail).toMatch(/legacy/i)
  })

  it('CRITICAL: a normal user can open the admin RPCs / force refunds / promote themselves', async () => {
    expect(failed(await run((u, _i, b) => (u.pathname.endsWith('/get_admin_metrics') && b !== ANON ? json(200, {}) : undefined)))).toContain('admin-gate')
    expect(failed(await run((u, _i, b) => (u.pathname.endsWith('/admin_force_refund') && b !== ANON ? json(200, {}) : undefined)))).toContain('admin-refund-gate')
    expect(failed(await run((u, _i, b) => (u.pathname.endsWith('/refund_order') && b !== ANON ? json(200, {}) : undefined)))).toContain('raw-refund-gate')
    expect(failed(await run((u, i) => (u.pathname === '/rest/v1/users' && i.method === 'PATCH' ? new Response(null, { status: 204 }) : undefined)))).toContain('no-self-promotion')
  })

  it('missing admin migration is reported as such', async () => {
    const results = await run((u, _i, b) => (u.pathname.endsWith('/get_admin_metrics') && b !== ANON ? json(404, { code: 'PGRST202' }) : undefined))
    expect(find(results, 'admin-gate').detail).toMatch(/db push/)
  })

  it.each(FUNCTIONS)('function %s not deployed', async (name) => {
    const results = await run((u) => (u.pathname === `/functions/v1/${name}` ? json(404, { message: 'Function not found' }) : undefined))
    expect(find(results, name)).toMatchObject({ status: 'fail' })
    expect(find(results, name).detail).toMatch(/functions deploy/)
  })

  it.each(FUNCTIONS)('function %s missing its secrets (500)', async (name) => {
    const results = await run((u) => (u.pathname === `/functions/v1/${name}` ? json(500, { error: 'server_misconfigured' }) : undefined))
    expect(find(results, name)).toMatchObject({ status: 'fail' })
    expect(find(results, name).detail).toMatch(/secret/i)
  })

  it('create-deposit without TON_RECIPIENT_ADDRESS (503)', async () => {
    const results = await run((u) => (u.pathname === '/functions/v1/create-deposit' ? json(503, { error: 'deposits_unavailable' }) : undefined))
    expect(failed(results)).toContain('create-deposit')
  })

  it('CRITICAL: an unauthenticated call succeeds on a protected function', async () => {
    for (const name of ['place-order', 'sync-catalog']) {
      const results = await run((u) => (u.pathname === `/functions/v1/${name}` ? json(200, {}) : undefined))
      expect(find(results, name).detail).toMatch(/CRITICAL/)
    }
  })

  it('functions use a different JWT_SECRET than PostgREST', async () => {
    const results = await run((u, _i, bearer) => (u.pathname === '/functions/v1/place-order' && bearer && bearer !== ANON ? json(401, { error: 'unauthorized' }) : undefined))
    expect(failed(results)).toContain('jwt-secret-matches')
    expect(find(results, 'jwt-secret-matches').detail).toMatch(/differs/)
  })

  it('CRITICAL: a forged token is accepted', async () => {
    const results = await run((u) => (u.pathname === '/functions/v1/place-order' ? json(400, { error: 'invalid_input' }) : undefined))
    expect(failed(results)).toContain('forged-token-rejected')
  })

  it('wrong CRON_SECRET', async () => {
    const results = await run(undefined, { cronSecret: 'wrong' })
    expect(find(results, 'sync-order-status:run')).toMatchObject({ status: 'fail' })
  })

  it('CORS: wildcard is a warning, a mismatched origin is a failure', async () => {
    const wildcard = await run((u, i) => (u.pathname.startsWith('/functions/') && i.method === 'OPTIONS' ? new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } }) : undefined))
    expect(find(wildcard, 'cors').status).toBe('warn')
    const wrong = await run((u, i) => (u.pathname.startsWith('/functions/') && i.method === 'OPTIONS' ? new Response(null, { status: 204, headers: { 'access-control-allow-origin': 'https://elsewhere.example' } }) : undefined))
    expect(find(wrong, 'cors').status).toBe('fail')
  })

  it('site down / frame-blocking header / secrets in the bundle', async () => {
    expect(failed(await run((u) => (u.host === 'my-app.vercel.app' && u.pathname === '/' ? new Response('nope', { status: 502 }) : undefined)))).toContain('index')
    const framed = await run((u) => (u.host === 'my-app.vercel.app' && u.pathname === '/' ? new Response('<div id="root"></div>', { headers: { 'x-frame-options': 'DENY' } }) : undefined))
    expect(failed(framed)).toContain('embeddable')
    const leaky = await run((u) => (u.pathname === '/assets/index-1.js' ? new Response('const a = "SUPABASE_SERVICE_ROLE_KEY"') : undefined))
    expect(find(leaky, 'bundle-secrets')).toMatchObject({ status: 'fail' })
    expect(find(leaky, 'bundle-secrets').detail).toMatch(/CRITICAL/)
  })

  it('TON Connect manifest problems', async () => {
    const manifest = (body: unknown, headers: Record<string, string> = { 'access-control-allow-origin': '*' }) => (u: URL) => (u.pathname === '/tonconnect-manifest.json' ? json(200, body, headers) : undefined)
    expect(failed(await run((u) => (u.pathname === '/tonconnect-manifest.json' ? new Response('', { status: 404 }) : undefined)))).toContain('manifest')
    expect(failed(await run(manifest({ url: 'https://your-domain.example', name: 'x', iconUrl: 'https://your-domain.example/i.png' })))).toContain('manifest')
    expect(failed(await run(manifest({ url: APP, name: 'x', iconUrl: `${APP}/i.svg` })))).toContain('manifest')
    expect(failed(await run(manifest({ url: APP, name: 'x', iconUrl: `${APP}/tonconnect-icon.png` }, {})))).toContain('manifest-cors')
    expect(failed(await run((u) => (u.pathname === '/tonconnect-icon.png' ? new Response('', { status: 404 }) : undefined)))).toContain('manifest-icon')
  })

  it('dead terms / privacy links are caught', async () => {
    expect(failed(await run((u) => (u.host === 'my-app.vercel.app' && u.pathname === '/privacy' ? new Response('nope', { status: 404 }) : undefined)))).toContain('legal-pages')
    expect(find(await run((u) => (u.host === 'my-app.vercel.app' && u.pathname === '/terms' ? new Response('<html>', { status: 500 }) : undefined)), 'legal-pages').detail).toMatch(/terms/)
  })

  it('Telegram: bad token, menu button pointing elsewhere', async () => {
    expect(failed(await run((u) => (u.pathname.endsWith('/getMe') ? json(401, { ok: false }) : undefined)))).toContain('bot-token')
    const wrongMenu = await run((u) => (u.pathname.endsWith('/getChatMenuButton') ? json(200, { ok: true, result: { type: 'web_app', web_app: { url: 'https://old.example.com' } } }) : undefined))
    expect(failed(wrongMenu)).toContain('menu-button')
    const defaultMenu = await run((u) => (u.pathname.endsWith('/getChatMenuButton') ? json(200, { ok: true, result: { type: 'default' } }) : undefined))
    expect(find(defaultMenu, 'menu-button').status).toBe('warn')
  })

  it('deposits switched off on purpose: warnings, not failures, and the TON group is skipped', async () => {
    const off = (u: URL) => (u.pathname === '/functions/v1/create-deposit' ? json(503, { error: 'deposits_unavailable' }) : u.pathname === '/functions/v1/verify-deposit' ? json(500, { error: 'server_misconfigured' }) : undefined)
    const results = await run(off, { depositsOff: true })
    expect(failed(results)).toEqual([])
    expect(find(results, 'create-deposit').status).toBe('warn')
    expect(find(results, 'verify-deposit').status).toBe('warn')
    expect(results.find((r) => r.group === 'ton')).toMatchObject({ status: 'skip' })
    // without the flag the very same answers are failures
    expect(failed(await run(off))).toEqual(expect.arrayContaining(['create-deposit', 'verify-deposit']))
  })

  it('a rejected anon key is reported on the catalogue read; a 401 on the bare REST root alone is normal', async () => {
    expect(failed(await run((u) => (u.pathname === '/rest/v1/' ? json(401, {}) : undefined)))).toEqual([])
    expect(failed(await run((u, _i, b) => (u.pathname === '/rest/v1/categories' && b === ANON ? json(401, { message: 'Invalid API key' }) : undefined)))).toContain('migrations-applied')
  })

  it('a blank TONCENTER_URL falls back to the default host', async () => {
    expect(find(await run(undefined, { toncenterUrl: '' }), 'toncenter').status).toBe('pass')
  })

  it('TON: unexpected Toncenter shape blocks go-live; rate limits and wrong network are reported', async () => {
    const shape = await run((u) => (u.host.endsWith('toncenter.com') ? json(200, { result: [] }) : undefined))
    expect(failed(shape)).toContain('toncenter')
    expect(find(shape, 'toncenter').detail).toMatch(/Do NOT go live/)
    expect(find(await run((u) => (u.host.endsWith('toncenter.com') ? json(429, {}) : undefined)), 'toncenter').status).toBe('warn')
    expect(failed(await run(undefined, { tonRecipientAddress: TESTNET_ADDR, tonNetwork: 'mainnet' }))).toContain('recipient')
    const testnet = await run(undefined, { tonRecipientAddress: TESTNET_ADDR, tonNetwork: 'testnet' })
    expect(failed(testnet)).toEqual([]) // a testnet address with TON_NETWORK=testnet is accepted, and the testnet Toncenter host is used
  })

  it('validates a provided secrets file offline', async () => {
    const bad = await run(undefined, { functionSecrets: { MOCK_MODE: 'true' } })
    expect(find(bad, 'function-secrets')).toMatchObject({ status: 'fail' })
    const fine = await run(undefined, {
      functionSecrets: { TELEGRAM_BOT_TOKEN: BOT_TOKEN, JWT_SECRET: JWT_SECRET, CRON_SECRET: CRON, TON_RECIPIENT_ADDRESS: MAINNET_ADDR, TON_NETWORK: 'mainnet', PROVIDER_X_API_KEY: 'k', ADMIN_TELEGRAM_IDS: '1', ALLOWED_ORIGIN: APP, TONCENTER_API_KEY: 'k' },
    })
    expect(find(fine, 'function-secrets').status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// CLI behaviour: exit codes of the real scripts
// ---------------------------------------------------------------------------

describe('CLI exit codes', () => {
  const cleanEnv = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '' }
  // Run in an empty project folder so the developer's own .env.local can never influence the result.
  const isolated = mkdtempSync(join(tmpdir(), 'verify-env-'))
  mkdirSync(join(isolated, 'public'))
  copyFileSync('public/tonconnect-manifest.json', join(isolated, 'public', 'tonconnect-manifest.json'))
  const verifyEnv = (extra: Record<string, string>) => {
    try {
      const stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', resolve('scripts/verify-env.ts')], { cwd: isolated, env: { ...cleanEnv, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out: stdout }
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: `${err.stdout}${err.stderr}` }
    }
  }
  const prod = { VERCEL_ENV: 'production', APP_URL: 'https://my-app.vercel.app', VITE_SUPABASE_URL: GOOD_URL, VITE_SUPABASE_ANON_KEY: ANON, VITE_TWA_RETURN_URL: 'https://t.me/my_bot/app' }

  it('verify-env: a correct production build passes', () => {
    expect(verifyEnv(prod)).toMatchObject({ code: 0 })
  }, 60_000)

  it('verify-env: local builds with nothing configured only warn', () => {
    const r = verifyEnv({})
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/VITE_SUPABASE_URL/)
  }, 60_000)

  it.each([
    ['missing Supabase config', { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, /VITE_SUPABASE_URL/],
    ['mock mode', { VITE_MOCK_MODE: 'true' }, /VITE_MOCK_MODE/],
    ['service-role key as browser key', { VITE_SUPABASE_ANON_KEY: SERVICE }, /CRITICAL/],
    ['secret exposed via VITE_', { VITE_CRON_SECRET: 'x' }, /VITE_CRON_SECRET/],
    ['unknown public URL', { APP_URL: '' }, /APP_URL|placeholder/],
  ])('verify-env: production build FAILS on %s', (_name, change, pattern) => {
    const r = verifyEnv({ ...prod, ...change })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(pattern)
  }, 60_000)

  it('verify-secrets: rejects a bad file and accepts a good one without printing values', () => {
    const run = (file: string) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/verify-secrets.ts', file], { env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string }
        return { code: err.status, out: `${err.stdout}${err.stderr}` }
      }
    }
    expect(run('does-not-exist.env').code).toBe(1)
    expect(run('supabase/functions/.env.example').code).toBe(1) // the template has empty placeholders
  }, 60_000)
})

// ---------------------------------------------------------------------------
// One combined env file (.env.local): only function secrets are extracted / uploaded
// ---------------------------------------------------------------------------

describe('extractFunctionSecrets', () => {
  const combined = parseEnvFile(`
    SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx
    SUPABASE_PROJECT_REF=abcdefghijklmnopqrst
    SUPABASE_DB_PASSWORD=
    TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
    JWT_SECRET=${'j'.repeat(40)}
    CRON_SECRET=
    TON_NETWORK=testnet
    PROVIDER_SECSERS_API_KEY=k
    PROVIDER_YOURPANEL_API_KEY=
    ADMIN_TELEGRAM_IDS=
    VITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co
    VITE_SUPABASE_ANON_KEY=anon
    APP_URL=https://x.example
    MOCK_MODE=true
  `)

  it('keeps only filled-in function secrets (and dev-only flags, so they can be refused)', () => {
    expect(Object.keys(extractFunctionSecrets(combined)).sort()).toEqual(['JWT_SECRET', 'MOCK_MODE', 'PROVIDER_SECSERS_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TON_NETWORK'])
  })

  it('never lets the CLI token, DB password, VITE_* or frontend values through', () => {
    const out = JSON.stringify(extractFunctionSecrets(combined))
    for (const leak of ['sbp_', 'SUPABASE_', 'VITE_', 'APP_URL', 'anon']) expect(out).not.toContain(leak)
  })

  it('empty values count as "not set", so validation reports what is still missing', () => {
    const f = checkFunctionSecrets(extractFunctionSecrets(combined))
    expect(ids(f, 'error')).toEqual(expect.arrayContaining(['CRON_SECRET', 'TON_RECIPIENT_ADDRESS', 'MOCK_MODE']))
    expect(ids(f, 'error')).not.toContain('SUPABASE_ACCESS_TOKEN')
  })

  it('a fully filled file passes', () => {
    const env = extractFunctionSecrets({
      ...combined, CRON_SECRET: 'c'.repeat(64), TON_RECIPIENT_ADDRESS: MAINNET_ADDR, TON_NETWORK: 'mainnet', MOCK_MODE: '',
      ADMIN_TELEGRAM_IDS: '1', ALLOWED_ORIGIN: 'https://x.example', TONCENTER_API_KEY: 'k',
    })
    expect(checkFunctionSecrets(env)).toEqual([])
  })

  it('the shipped template lists every name the project uses and holds no values', async () => {
    const { readFileSync } = await import('node:fs')
    const template = parseEnvFile(readFileSync('.env.example', 'utf8'))
    const names = [
      'SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_DB_PASSWORD',
      'TELEGRAM_BOT_TOKEN', 'JWT_SECRET', 'CRON_SECRET', 'TON_RECIPIENT_ADDRESS', 'TON_NETWORK', 'ADMIN_TELEGRAM_IDS', 'ALLOWED_ORIGIN',
      'TONCENTER_API_KEY', 'PROVIDER_KEY_SECRET', 'SYNC_BATCH_SIZE', 'RECONCILE_AFTER_MINUTES', 'TONCENTER_URL',
      'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_TWA_RETURN_URL', 'APP_URL', 'TERMS_URL', 'PRIVACY_URL', 'VITE_TONCONNECT_MANIFEST_URL',
    ]
    for (const n of names) expect(template, n).toHaveProperty(n)
    expect(Object.keys(template).some((k) => /^PROVIDER_.+_API_KEY$/.test(k))).toBe(true)
    const filled = Object.entries(template).filter(([k, v]) => v !== '' && k !== 'TON_NETWORK')
    expect(filled, 'the template must not contain real values').toEqual([])
    // dev-only switches stay commented out
    for (const dev of ['MOCK_MODE', 'VITE_MOCK_MODE', 'TON_USD_FALLBACK_RATE']) expect(template).not.toHaveProperty(dev)
  })
})
