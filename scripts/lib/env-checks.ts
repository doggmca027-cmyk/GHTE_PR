// Pure deployment checks. Every function takes plain data and returns Findings, so they are unit
// tested (tests/deployment-scripts.test.ts) and reused by the CLIs in /scripts.
//
// NOTE: these scripts run with Node's native TypeScript support (no build step), so keep to
// erasable syntax only: no enums, no namespaces, no constructor parameter properties.

import { parseAdminIds } from '../../supabase/functions/_shared/admin.ts'
import { parseTonAddress, tonAddressFlags } from '../../supabase/functions/_shared/ton.ts'

export type Level = 'error' | 'warn'
export interface Finding {
  level: Level
  id: string
  message: string
}
type Env = Record<string, string | undefined>

const err = (id: string, message: string): Finding => ({ level: 'error', id, message })
const warn = (id: string, message: string): Finding => ({ level: 'warn', id, message })
export const hasErrors = (findings: Finding[]): boolean => findings.some((f) => f.level === 'error')

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== ''

/** Decodes a JWT payload without verifying it (only to inspect role / project ref). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Client (Vite / Vercel) environment
// ---------------------------------------------------------------------------

/** VITE_* variables are compiled into the public JavaScript bundle: they must never hold a secret. */
const SECRETISH_NAME = /(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|BOT_TOKEN|CRON|JWT|API_KEY|ACCESS_TOKEN)/i
const BOT_TOKEN_VALUE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/

export function checkClientEnv(env: Env, ctx: { production: boolean }): Finding[] {
  const out: Finding[] = []
  const missing = (id: string, message: string) => out.push(ctx.production ? err(id, message) : warn(id, message))

  // --- Supabase URL
  const url = env.VITE_SUPABASE_URL
  let projectRef: string | undefined
  if (!present(url)) {
    missing('VITE_SUPABASE_URL', 'VITE_SUPABASE_URL is not set: the app will show "Backend is not configured".')
  } else {
    try {
      const u = new URL(url)
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      if (u.protocol !== 'https:' && !(local && !ctx.production)) out.push(err('VITE_SUPABASE_URL', 'VITE_SUPABASE_URL must be an https:// URL.'))
      if (u.pathname !== '/' && u.pathname !== '') out.push(warn('VITE_SUPABASE_URL', 'VITE_SUPABASE_URL should be the bare project URL (https://<ref>.supabase.co), without a path.'))
      projectRef = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(u.hostname)?.[1]
    } catch {
      out.push(err('VITE_SUPABASE_URL', 'VITE_SUPABASE_URL is not a valid URL.'))
    }
  }

  // --- anon key: must be the PUBLIC key, never a privileged one
  const anon = env.VITE_SUPABASE_ANON_KEY
  if (!present(anon)) {
    missing('VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY is not set: the app cannot talk to Supabase.')
  } else if (anon.startsWith('sb_secret_')) {
    out.push(err('VITE_SUPABASE_ANON_KEY', 'CRITICAL: this is a Supabase SECRET key. It would be published in the browser bundle. Use the publishable / anon key.'))
  } else {
    const payload = decodeJwtPayload(anon)
    if (payload) {
      if (payload.role !== 'anon') {
        out.push(err('VITE_SUPABASE_ANON_KEY', `CRITICAL: this key has role "${String(payload.role)}", not "anon". Never put it in a VITE_ variable.`))
      }
      if (projectRef && typeof payload.ref === 'string' && payload.ref !== projectRef) {
        out.push(err('VITE_SUPABASE_ANON_KEY', `The anon key belongs to project "${payload.ref}" but VITE_SUPABASE_URL points at "${projectRef}".`))
      }
    } else if (!anon.startsWith('sb_publishable_')) {
      out.push(warn('VITE_SUPABASE_ANON_KEY', 'Unrecognised key format (expected a JWT starting "eyJ" or "sb_publishable_").'))
    }
  }

  // --- mock mode must never be on in production
  if (env.VITE_MOCK_MODE === 'true') {
    out.push(
      ctx.production
        ? err('VITE_MOCK_MODE', 'VITE_MOCK_MODE=true in a production build would serve FAKE wallets, catalogue and orders. Remove it.')
        : warn('VITE_MOCK_MODE', 'VITE_MOCK_MODE=true: this build uses the offline mock backend (fine for dev/preview, never for production).'),
    )
  } else if (present(env.VITE_MOCK_MODE) && env.VITE_MOCK_MODE !== 'false') {
    out.push(warn('VITE_MOCK_MODE', `VITE_MOCK_MODE="${env.VITE_MOCK_MODE}" is ignored: only the exact value "true" enables mock mode. Delete the variable.`))
  }
  for (const k of ['VITE_MOCK_SUBMITTED_MS', 'VITE_MOCK_COMPLETED_MS']) {
    if (present(env[k]) && ctx.production) out.push(warn(k, `${k} only affects the dev mock backend; remove it from production.`))
  }

  // --- Telegram return URL / manifest override
  const twa = env.VITE_TWA_RETURN_URL
  if (!present(twa)) {
    if (ctx.production) out.push(warn('VITE_TWA_RETURN_URL', 'VITE_TWA_RETURN_URL is not set: after approving in Tonkeeper users will not be sent back to the Mini App automatically (e.g. https://t.me/your_bot/app).'))
  } else if (!/^https:\/\/t\.me\/[A-Za-z0-9_]{4,}(\/[A-Za-z0-9_]+)?$/.test(twa)) {
    out.push(warn('VITE_TWA_RETURN_URL', 'VITE_TWA_RETURN_URL should look like https://t.me/<bot_username> or https://t.me/<bot_username>/<app_short_name>.'))
  }
  const manifest = env.VITE_TONCONNECT_MANIFEST_URL
  if (present(manifest)) {
    if (!/^https:\/\//.test(manifest)) out.push(err('VITE_TONCONNECT_MANIFEST_URL', 'VITE_TONCONNECT_MANIFEST_URL must be an absolute https:// URL.'))
    else out.push(warn('VITE_TONCONNECT_MANIFEST_URL', 'A custom manifest URL is set: make sure that file is public, CORS-enabled and its "url" matches the deployed origin.'))
  }

  // --- anything else exposed to the browser
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('VITE_') || name === 'VITE_SUPABASE_ANON_KEY') continue
    if (SECRETISH_NAME.test(name)) {
      out.push(err(name, `${name} looks like a secret, but every VITE_* variable is published in the browser bundle. Rename/move it to a server-side secret.`))
    } else if (present(value) && (BOT_TOKEN_VALUE.test(value) || (decodeJwtPayload(value)?.role === 'service_role'))) {
      out.push(err(name, `${name} holds a value that looks like a Telegram bot token or a service-role key. Remove it: VITE_* values are public.`))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// App URL + TON Connect manifest
// ---------------------------------------------------------------------------

/** APP_URL wins; otherwise Vercel's production domain. Returns an origin without trailing slash, or undefined. */
export function resolveAppUrl(env: Env): string | undefined {
  const raw = present(env.APP_URL) ? env.APP_URL.trim() : present(env.VERCEL_PROJECT_PRODUCTION_URL) ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL.trim()}` : undefined
  if (!raw) return undefined
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return u.origin
  } catch {
    return undefined
  }
}

export const MANIFEST_PLACEHOLDER = 'your-domain.example'

export interface Manifest {
  url: string
  name: string
  iconUrl: string
  termsOfUseUrl?: string
  privacyPolicyUrl?: string
}

/**
 * The manifest to publish: the committed template with every URL pointed at the real origin.
 * Terms / privacy default to the pages shipped in public/ (/terms, /privacy); TERMS_URL / PRIVACY_URL override.
 */
export function buildManifest(template: Manifest, appUrl: string, env: Env = {}): Manifest {
  const { termsOfUseUrl: _t, privacyPolicyUrl: _p, ...rest } = template
  return {
    ...rest,
    url: appUrl,
    iconUrl: `${appUrl}/tonconnect-icon.png`,
    termsOfUseUrl: present(env.TERMS_URL) ? env.TERMS_URL.trim() : `${appUrl}/terms`,
    privacyPolicyUrl: present(env.PRIVACY_URL) ? env.PRIVACY_URL.trim() : `${appUrl}/privacy`,
  }
}

export function checkManifest(manifest: unknown, ctx: { production: boolean; appUrl?: string }): Finding[] {
  const out: Finding[] = []
  const m = manifest as Partial<Manifest> | null
  if (!m || typeof m !== 'object') return [err('manifest', 'tonconnect-manifest.json is not a JSON object.')]

  for (const k of ['url', 'name', 'iconUrl'] as const) {
    if (typeof m[k] !== 'string' || m[k]!.trim() === '') out.push(err(`manifest.${k}`, `Manifest field "${k}" is missing.`))
  }
  const urls = [m.url, m.iconUrl, m.termsOfUseUrl, m.privacyPolicyUrl].filter((u): u is string => typeof u === 'string')
  if (urls.some((u) => u.includes(MANIFEST_PLACEHOLDER))) {
    out.push((ctx.production ? err : warn)('manifest.placeholder', `The manifest still contains the placeholder domain "${MANIFEST_PLACEHOLDER}". Set APP_URL (or deploy on Vercel) so it is replaced at build time.`))
  }
  if (typeof m.iconUrl === 'string' && !/\.(png|ico)(\?.*)?$/i.test(m.iconUrl)) {
    out.push(err('manifest.iconUrl', 'iconUrl must be a PNG or ICO file; TON Connect wallets reject SVG.'))
  }
  if (ctx.production && urls.some((u) => !u.startsWith('https://') && !u.includes(MANIFEST_PLACEHOLDER))) {
    out.push(err('manifest.https', 'All manifest URLs must be https:// in production.'))
  }
  if (typeof m.url === 'string' && ctx.appUrl) {
    try {
      if (new URL(m.url).origin !== new URL(ctx.appUrl).origin) {
        out.push(warn('manifest.origin', `Manifest url (${m.url}) does not match the app origin (${ctx.appUrl}).`))
      }
    } catch {
      out.push(err('manifest.url', 'Manifest "url" is not a valid URL.'))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Supabase Edge Function secrets
// ---------------------------------------------------------------------------

/** Minimal dotenv parser: KEY=VALUE, `export`, quotes, comments, blank lines. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '') // trailing comment on an unquoted value
    out[m[1]] = value
  }
  return out
}

export const REQUIRED_FUNCTION_SECRETS = ['TELEGRAM_BOT_TOKEN', 'JWT_SECRET', 'CRON_SECRET', 'TON_RECIPIENT_ADDRESS', 'TON_NETWORK'] as const

export function checkFunctionSecrets(env: Env): Finding[] {
  const out: Finding[] = []

  // TON_RECIPIENT_ADDRESS + TON_NETWORK together switch deposits on. Both absent = deposits deliberately OFF
  // (create-deposit answers 503). Only ONE of them is an error: a missing TON_NETWORK silently means mainnet.
  const depositsOff = !present(env.TON_RECIPIENT_ADDRESS) && !present(env.TON_NETWORK)
  for (const name of REQUIRED_FUNCTION_SECRETS) {
    if (depositsOff && (name === 'TON_RECIPIENT_ADDRESS' || name === 'TON_NETWORK')) continue
    if (!present(env[name])) out.push(err(name, `${name} is required but missing or empty.`))
  }
  if (depositsOff) {
    out.push(warn('TON_*', 'TON_RECIPIENT_ADDRESS and TON_NETWORK are both unset: DEPOSITS ARE DISABLED (create-deposit answers 503). Set both to enable them.'))
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith('SUPABASE_')) out.push(err(name, `Secret names starting with SUPABASE_ are reserved and rejected by "supabase secrets set". Supabase already injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; use JWT_SECRET for the JWT secret.`))
  }

  if (present(env.TELEGRAM_BOT_TOKEN) && !BOT_TOKEN_VALUE.test(env.TELEGRAM_BOT_TOKEN.trim())) {
    out.push(err('TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN does not look like a BotFather token (<digits>:<35 chars>).'))
  }
  if (present(env.JWT_SECRET)) {
    const s = env.JWT_SECRET.trim()
    if (s.length < 32) out.push(err('JWT_SECRET', 'JWT_SECRET is shorter than 32 characters: copy the project "JWT Secret" from Supabase (Project Settings -> API).'))
    if (s.startsWith('eyJ')) out.push(err('JWT_SECRET', 'JWT_SECRET looks like a JWT (an API key), not the project JWT secret.'))
  }
  if (present(env.CRON_SECRET)) {
    const n = env.CRON_SECRET.trim().length
    if (n < 16) out.push(err('CRON_SECRET', 'CRON_SECRET is too short to be safe. Generate one with: openssl rand -hex 32'))
    else if (n < 32) out.push(warn('CRON_SECRET', 'CRON_SECRET is shorter than 32 characters. Prefer: openssl rand -hex 32'))
  }

  // TON network is the one setting that silently falls back (anything but "testnet" means mainnet).
  // Compared RAW on purpose: the functions do `=== 'testnet'`, so "testnet " (trailing space) silently means mainnet.
  const network = env.TON_NETWORK
  if (present(network) && network !== 'mainnet' && network !== 'testnet') {
    out.push(err('TON_NETWORK', `TON_NETWORK must be exactly "mainnet" or "testnet" (got "${network}"). Any other value is treated as mainnet.`))
  }
  if (present(env.TON_RECIPIENT_ADDRESS)) {
    const addr = env.TON_RECIPIENT_ADDRESS.trim()
    try {
      parseTonAddress(addr)
      const flags = tonAddressFlags(addr)
      if (flags === null) {
        out.push(warn('TON_RECIPIENT_ADDRESS', 'Use the user-friendly address format (UQ... / EQ...) rather than the raw "0:..." form.'))
      } else {
        if (network === 'mainnet' && flags.testOnly) out.push(err('TON_RECIPIENT_ADDRESS', 'This is a TESTNET address (test-only flag) but TON_NETWORK is "mainnet": deposits would be sent to nowhere real.'))
        if (network === 'testnet' && !flags.testOnly) out.push(warn('TON_RECIPIENT_ADDRESS', 'TON_NETWORK is "testnet" but the address has no test-only flag. Double-check you are using your testnet wallet.'))
        if (flags.bounceable) out.push(warn('TON_RECIPIENT_ADDRESS', 'Bounceable address (EQ...). A non-bounceable one (UQ...) is the safer choice for receiving plain transfers.'))
      }
    } catch {
      out.push(err('TON_RECIPIENT_ADDRESS', 'TON_RECIPIENT_ADDRESS is not a valid TON address (bad length, prefix or checksum).'))
    }
  }

  // Providers: either plaintext per-provider keys or an encryption secret (+ encrypted DB column).
  const providerKeys = Object.entries(env).filter(([k, v]) => /^PROVIDER_.+_API_KEY$/.test(k) && present(v))
  // PROVIDER_KEY_SECRET alone is NOT a provider key: it only decrypts keys stored in providers.api_key_encrypted,
  // which this check cannot see. So without a plaintext key we always warn, and say what the alternative needs.
  if (providerKeys.length === 0) {
    out.push(warn('PROVIDER_*_API_KEY', `No provider API key configured (PROVIDER_<NAME>_API_KEY). Catalog sync, order placement and order sync refuse to run for a provider without a key${present(env.PROVIDER_KEY_SECRET) ? ' (PROVIDER_KEY_SECRET is set, which only works if providers.api_key_encrypted is filled in the database)' : ''}.`))
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('PROVIDER_') && k !== 'PROVIDER_KEY_SECRET' && !/^PROVIDER_.+_API_KEY$/.test(k)) {
      out.push(warn(k, `${k} is not read by any function. Provider keys must be named PROVIDER_<NAME>_API_KEY.`))
    }
  }
  if (present(env.PROVIDER_KEY_SECRET) && Buffer.from(env.PROVIDER_KEY_SECRET.trim(), 'base64').length !== 32) {
    out.push(err('PROVIDER_KEY_SECRET', 'PROVIDER_KEY_SECRET must be 32 random bytes, base64-encoded (openssl rand -base64 32).'))
  }

  // Admins
  const rawAdmins = env.ADMIN_TELEGRAM_IDS
  if (!present(rawAdmins)) {
    out.push(warn('ADMIN_TELEGRAM_IDS', 'ADMIN_TELEGRAM_IDS is not set: nobody can open the Admin dashboard until you set users.is_admin with SQL.'))
  } else {
    const parsed = parseAdminIds(rawAdmins)
    const tokens = rawAdmins.split(/[\s,;]+/).filter(Boolean)
    if (parsed.size === 0) out.push(err('ADMIN_TELEGRAM_IDS', 'ADMIN_TELEGRAM_IDS contains no valid numeric Telegram ids.'))
    else if (parsed.size !== tokens.length) out.push(warn('ADMIN_TELEGRAM_IDS', 'Some ADMIN_TELEGRAM_IDS entries are not valid Telegram ids and will be ignored.'))
  }

  // CORS
  if (!present(env.ALLOWED_ORIGIN)) {
    out.push(warn('ALLOWED_ORIGIN', 'ALLOWED_ORIGIN is not set, so the functions answer to any origin ("*"). Set it to your app origin, e.g. https://your-app.vercel.app'))
  } else if (!/^https:\/\/[^/\s]+$/.test(env.ALLOWED_ORIGIN.trim()) && !/^http:\/\/localhost(:\d+)?$/.test(env.ALLOWED_ORIGIN.trim())) {
    out.push(err('ALLOWED_ORIGIN', 'ALLOWED_ORIGIN must be a bare origin (https://host, no path, no trailing slash), or browsers will reject every response.'))
  }

  // Things that must NOT be set in production
  if (env.MOCK_MODE === 'true') out.push(err('MOCK_MODE', 'MOCK_MODE=true must never be set in production: orders would be accepted without contacting the provider.'))
  else if (present(env.MOCK_MODE)) out.push(warn('MOCK_MODE', 'MOCK_MODE is set. Delete it in production (only the exact value "true" enables it).'))
  if (present(env.TON_USD_FALLBACK_RATE)) out.push(warn('TON_USD_FALLBACK_RATE', 'TON_USD_FALLBACK_RATE is a dev-only fixed rate; remove it in production.'))

  // Tuning
  if (present(env.SYNC_BATCH_SIZE) && !(Number.isInteger(Number(env.SYNC_BATCH_SIZE)) && Number(env.SYNC_BATCH_SIZE) >= 1 && Number(env.SYNC_BATCH_SIZE) <= 200)) {
    out.push(err('SYNC_BATCH_SIZE', 'SYNC_BATCH_SIZE must be an integer between 1 and 200.'))
  }
  if (present(env.RECONCILE_AFTER_MINUTES)) {
    const n = Number(env.RECONCILE_AFTER_MINUTES)
    if (!Number.isFinite(n) || n <= 0) out.push(err('RECONCILE_AFTER_MINUTES', 'RECONCILE_AFTER_MINUTES must be a positive number.'))
    else if (n < 15) out.push(warn('RECONCILE_AFTER_MINUTES', 'Under 15 minutes risks refunding orders the provider is still about to confirm.'))
  }
  if (!present(env.TONCENTER_API_KEY)) {
    out.push(warn('TONCENTER_API_KEY', 'No TONCENTER_API_KEY: the free tier allows roughly 1 request per second, which deposit verification can exceed under load.'))
  }
  return out
}

// ---------------------------------------------------------------------------
// Source / bundle secret scanning
// ---------------------------------------------------------------------------

export const SCAN_ALLOW_MARKER = 'secret-scan:allow'

interface Pattern {
  id: string
  re: RegExp
  describe: string
}

const SECRET_PATTERNS: Pattern[] = [
  { id: 'telegram-bot-token', re: /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/, describe: 'Telegram bot token' },
  { id: 'supabase-secret-key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/, describe: 'Supabase secret key' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, describe: 'private key block' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, describe: 'GitHub token' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/, describe: 'AWS access key id' },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/, describe: 'Stripe live key' },
  { id: 'generic-assignment', re: /\b[A-Za-z_]*(?:SECRET|PASSWORD|API_KEY|ACCESS_TOKEN|BOT_TOKEN)[A-Za-z_]*\s*[:=]\s*['"][A-Za-z0-9+/_=-]{24,}['"]/i, describe: 'hard-coded credential assignment' },
]
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export interface ScanHit {
  file: string
  line: number
  id: string
  message: string
  /** For jwt-literal hits: the `role` claim of the token (so callers can tell a public anon key from a secret). */
  jwtRole?: string
}

export function scanTextForSecrets(file: string, text: string): ScanHit[] {
  const hits: ScanHit[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (line.includes(SCAN_ALLOW_MARKER)) return
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) hits.push({ file, line: i + 1, id: p.id, message: `possible ${p.describe}` })
    }
    for (const m of line.matchAll(JWT_RE)) {
      const role = decodeJwtPayload(m[0])?.role
      hits.push({ file, line: i + 1, id: 'jwt-literal', jwtRole: typeof role === 'string' ? role : undefined, message: role === 'service_role' ? 'CRITICAL: service_role JWT literal' : 'JWT literal (keys must come from the environment)' })
    }
  })
  return hits
}

/** Names / values that must never reach the browser bundle. */
export const SERVER_ONLY_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'CRON_SECRET', 'TELEGRAM_BOT_TOKEN', 'PROVIDER_KEY_SECRET',
  'TONCENTER_API_KEY', 'ADMIN_TELEGRAM_IDS', 'TON_RECIPIENT_ADDRESS', 'service_role',
] as const

export function scanBundleForSecrets(files: { path: string; text: string }[]): ScanHit[] {
  const hits: ScanHit[] = []
  for (const f of files) {
    for (const name of SERVER_ONLY_NAMES) {
      if (f.text.includes(name)) hits.push({ file: f.path, line: 0, id: 'server-name-in-bundle', message: `the bundle mentions server-only name "${name}"` })
    }
    for (const h of scanTextForSecrets(f.path, f.text)) {
      if (h.id === 'generic-assignment') continue
      // The Supabase anon key is PUBLIC by design and is compiled into the bundle on purpose (VITE_SUPABASE_ANON_KEY).
      // Any other token (service_role, authenticated, unknown) in a browser bundle is a leak.
      if (h.id === 'jwt-literal' && h.jwtRole === 'anon') continue
      hits.push(h)
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ${f.level === 'error' ? 'ERROR' : 'warn '}  ${f.id}: ${f.message}`).join('\n')
}

// ---------------------------------------------------------------------------
// One combined env file: pick out just the Edge Function secrets
// ---------------------------------------------------------------------------

/** Every name an Edge Function reads (apart from PROVIDER_*_API_KEY, matched by pattern). */
export const FUNCTION_SECRET_NAMES = [
  ...REQUIRED_FUNCTION_SECRETS,
  'ADMIN_TELEGRAM_IDS', 'ALLOWED_ORIGIN', 'TONCENTER_API_KEY', 'TONCENTER_URL', 'PROVIDER_KEY_SECRET',
  'SYNC_BATCH_SIZE', 'RECONCILE_AFTER_MINUTES',
  // dev-only names are kept so the checks can REFUSE them in production
  'MOCK_MODE', 'TON_USD_FALLBACK_RATE',
] as const

/**
 * From a combined env file (CLI token, frontend, secrets...) keep only what must be uploaded to Supabase:
 * known function secrets and PROVIDER_*_API_KEY, with EMPTY values dropped (empty = "not set").
 * VITE_*, SUPABASE_* and everything else are never included.
 */
export function extractFunctionSecrets(env: Record<string, string | undefined>): Record<string, string> {
  const known = new Set<string>(FUNCTION_SECRET_NAMES)
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.trim() === '') continue
    if (known.has(name) || /^PROVIDER_[A-Z0-9_]+_API_KEY$/.test(name)) out[name] = value
  }
  return out
}
