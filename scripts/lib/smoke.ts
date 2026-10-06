// Production smoke tests. Everything talks HTTP through an injected `fetch`, so the logic is unit
// tested against fake deployments (tests/deployment-scripts.test.ts) and run for real by
// `npm run smoke` (scripts/smoke-test.ts).
//
// These checks only READ or send deliberately invalid requests. They never create orders, move
// money or write data. (Optional --run-workers triggers the idempotent order-status worker.)

import { normalizeToncenterTransactions, toRawAddress } from '../../supabase/functions/_shared/ton.ts'
import { signJwt } from '../../supabase/functions/_shared/jwt.ts'
import { checkFunctionSecrets, checkManifest, scanBundleForSecrets, type Finding, type Manifest } from './env-checks.ts'

export type Status = 'pass' | 'fail' | 'warn' | 'skip'
export interface CheckResult {
  group: string
  id: string
  status: Status
  detail: string
}

export interface SmokeConfig {
  supabaseUrl: string
  anonKey: string
  appUrl?: string
  /** Project JWT secret (local only). Enables the authenticated-path checks. */
  jwtSecret?: string
  cronSecret?: string
  runWorkers?: boolean
  /** Deposits are switched off on purpose (TON secrets deliberately not set): their functions answer 503/500 by design. */
  depositsOff?: boolean
  telegramBotToken?: string
  tonRecipientAddress?: string
  tonNetwork?: string
  toncenterApiKey?: string
  toncenterUrl?: string
  /** Function secrets (e.g. parsed from supabase/functions/.env.production) to validate offline. */
  functionSecrets?: Record<string, string>
}

interface Res {
  status: number
  headers: Headers
  text: string
  json: unknown
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const TIMEOUT_MS = 15_000

export async function runSmokeTests(cfg: SmokeConfig, fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const base = cfg.supabaseUrl.replace(/\/$/, '')
  const add = (group: string, id: string, status: Status, detail: string) => results.push({ group, id, status, detail })

  async function http(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await res.text()
      let json: unknown = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json }
    } catch {
      return { status: 0, headers: new Headers(), text: '', json: null }
    }
  }
  const anonHeaders = { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` }
  const rest = (path: string, headers: Record<string, string> = anonHeaders) => http('GET', `${base}/rest/v1/${path}`, { headers })
  const rpc = (fn: string, body: unknown, headers: Record<string, string> = anonHeaders) => http('POST', `${base}/rest/v1/rpc/${fn}`, { headers, body })
  const fn = (name: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    http(opts.method ?? 'POST', `${base}/functions/v1/${name}`, { headers: { ...anonHeaders, ...opts.headers }, body: opts.body })
  const code = (r: Res) => (r.json as { code?: string } | null)?.code
  const errorOf = (r: Res) => (r.json as { error?: string } | null)?.error
  const denied = (r: Res) => r.status === 401 || r.status === 403

  // ===========================================================================
  // 1. Database: migrations applied, anonymous access locked down
  // ===========================================================================
  const G1 = 'database'
  const root = await rest('')
  if (root.status === 0) {
    add(G1, 'reachable', 'fail', `Cannot reach ${base}. Check VITE_SUPABASE_URL / the project is not paused.`)
    return results // nothing else can work
  }
  // Newer Supabase answers 401 on the bare REST root for the anon role: that is normal. The key itself is judged below.
  add(G1, 'reachable', 'pass', `Project answered (HTTP ${root.status}).`)

  const cats = await rest('categories?select=id&limit=1')
  if (cats.status === 200 && Array.isArray(cats.json)) add(G1, 'migrations-applied', 'pass', 'Public catalogue table is readable by anon.')
  else if (cats.status === 401 || cats.status === 403) add(G1, 'migrations-applied', 'fail', 'Supabase rejected the anon key (HTTP 401/403): the key does not belong to this project, or the catalogue table is not readable by anon.')
  else if (cats.status === 404) add(G1, 'migrations-applied', 'fail', 'Table "categories" not found: run `supabase db push` against this project.')
  else add(G1, 'migrations-applied', 'fail', `Unexpected answer reading categories (HTTP ${cats.status}${code(cats) ? ` ${code(cats)}` : ''}).`)

  const PRIVATE_TABLES = ['users', 'wallets', 'wallet_transactions', 'orders', 'order_status_history', 'deposits', 'providers', 'provider_services', 'price_rules', 'admin_audit_log', 'notification_log']
  const leaks: string[] = []
  const missing: string[] = []
  const exposedEmpty: string[] = []
  for (const table of PRIVATE_TABLES) {
    const r = await rest(`${table}?select=*&limit=1`)
    if (r.status === 404) missing.push(table)
    else if (r.status === 200 && Array.isArray(r.json) && r.json.length > 0) leaks.push(table)
    else if (r.status === 200) exposedEmpty.push(table)
    else if (!denied(r)) exposedEmpty.push(`${table} (HTTP ${r.status})`)
  }
  if (leaks.length) add(G1, 'anon-lockdown', 'fail', `CRITICAL: anonymous users can READ rows from: ${leaks.join(', ')}. Review RLS and grants immediately.`)
  else if (missing.length) add(G1, 'anon-lockdown', 'fail', `Tables not found (migrations missing?): ${missing.join(', ')}.`)
  else if (exposedEmpty.length) add(G1, 'anon-lockdown', 'warn', `anon can query these tables (no rows visible, but it should be denied outright): ${exposedEmpty.join(', ')}.`)
  else add(G1, 'anon-lockdown', 'pass', `anon is denied on all ${PRIVATE_TABLES.length} private tables.`)

  const PRIVILEGED_RPCS = ['process_wallet_transaction', 'refund_order', 'complete_deposit', 'apply_partial_refund', 'place_order', 'get_admin_metrics', 'admin_force_refund', 'admin_update_price_rule']
  const callable: string[] = []
  for (const name of PRIVILEGED_RPCS) {
    const r = await rpc(name, {})
    if (r.status >= 200 && r.status < 300) callable.push(name)
  }
  if (callable.length) add(G1, 'anon-rpc-lockdown', 'fail', `CRITICAL: anon can EXECUTE: ${callable.join(', ')}.`)
  else add(G1, 'anon-rpc-lockdown', 'pass', 'anon cannot execute any privileged function.')

  // ===========================================================================
  // 2. Authenticated path: the JWT we mint must be accepted by PostgREST AND by the functions
  // ===========================================================================
  const G2 = 'auth'
  let userHeaders: Record<string, string> | undefined
  let userId: string | undefined
  if (!cfg.jwtSecret) {
    add(G2, 'jwt', 'skip', 'Set JWT_SECRET (locally) to test that tokens issued by telegram-auth are accepted. This is the most common production misconfiguration.')
  } else {
    userId = crypto.randomUUID()
    const { token } = await signJwt({ sub: userId, role: 'authenticated', aud: 'authenticated' }, cfg.jwtSecret, 300)
    userHeaders = { apikey: cfg.anonKey, Authorization: `Bearer ${token}` }

    const wallets = await rest('wallets?select=balance', userHeaders)
    if (wallets.status === 200 && Array.isArray(wallets.json) && wallets.json.length === 0) {
      add(G2, 'postgrest-accepts-jwt', 'pass', 'PostgREST accepts a token signed with JWT_SECRET (RLS applied: 0 rows).')
    } else if (wallets.status === 401) {
      add(G2, 'postgrest-accepts-jwt', 'fail', 'PostgREST REJECTED a token signed with this JWT_SECRET: every logged-in user would get 401. Use the project\'s (legacy) JWT secret, and do not revoke it.')
    } else {
      add(G2, 'postgrest-accepts-jwt', 'fail', `Unexpected answer for an authenticated read (HTTP ${wallets.status}).`)
    }

    const metrics = await rpc('get_admin_metrics', {}, userHeaders)
    if (metrics.status >= 200 && metrics.status < 300) add(G2, 'admin-gate', 'fail', 'CRITICAL: a random non-admin user could call get_admin_metrics().')
    else if (metrics.status === 404) add(G2, 'admin-gate', 'fail', 'get_admin_metrics() not found: run `supabase db push` (migration 20261010000000).')
    else if (code(metrics) === '42501' || denied(metrics)) add(G2, 'admin-gate', 'pass', 'A regular user is refused by the admin RPCs.')
    else add(G2, 'admin-gate', 'warn', `Admin RPC refused with an unexpected status (HTTP ${metrics.status}).`)

    const forceRefund = await rpc('admin_force_refund', { p_order_id: ZERO_UUID }, userHeaders)
    if (forceRefund.status >= 200 && forceRefund.status < 300) add(G2, 'admin-refund-gate', 'fail', 'CRITICAL: a non-admin could call admin_force_refund().')
    else add(G2, 'admin-refund-gate', denied(forceRefund) || code(forceRefund) === '42501' || forceRefund.status === 404 ? 'pass' : 'warn', 'Non-admin cannot force-refund.')

    const rawRefund = await rpc('refund_order', { p_order_id: ZERO_UUID }, userHeaders)
    add(G2, 'raw-refund-gate', rawRefund.status >= 200 && rawRefund.status < 300 ? 'fail' : 'pass', rawRefund.status >= 200 && rawRefund.status < 300 ? 'CRITICAL: an authenticated user can call refund_order() directly.' : 'refund_order() is not callable by users.')

    const promote = await http('PATCH', `${base}/rest/v1/users?id=eq.${userId}`, { headers: { ...userHeaders, Prefer: 'return=minimal' }, body: { is_admin: true } })
    add(G2, 'no-self-promotion', promote.status >= 200 && promote.status < 300 ? 'fail' : 'pass', promote.status >= 200 && promote.status < 300 ? 'CRITICAL: users can write to the users table.' : 'Users cannot modify the users table.')
  }

  // ===========================================================================
  // 3. Edge Functions: deployed, secrets present, auth enforced
  // ===========================================================================
  const G3 = 'functions'
  const notDeployed = (name: string) => `Function "${name}" is not deployed: run \`supabase functions deploy\`.`
  const misconfigured = (name: string, r: Res) => `Function "${name}" answered ${r.status} ${errorOf(r) ?? ''}: a required secret is missing (see DEPLOYMENT.md, "Secrets"). Open Dashboard -> Edge Functions -> ${name} -> Logs.`

  const expect401 = async (name: string, body: unknown, depositFunction = false) => {
    const r = await fn(name, { body })
    if (r.status === 404) add(G3, name, 'fail', notDeployed(name))
    else if (r.status === 0) add(G3, name, 'fail', `Function "${name}" is unreachable.`)
    else if (depositFunction && cfg.depositsOff && (r.status === 500 || r.status === 503)) add(G3, name, 'warn', `Deployed; deposits are switched off on purpose (${r.status} ${errorOf(r) ?? ''}). Set TON_RECIPIENT_ADDRESS + TON_NETWORK to enable them.`)
    else if (r.status === 500 || r.status === 503) add(G3, name, 'fail', misconfigured(name, r))
    else if (r.status === 401) add(G3, name, 'pass', 'Deployed, configured, and rejects unauthenticated calls (401).')
    else if (r.status >= 200 && r.status < 300) add(G3, name, 'fail', `CRITICAL: "${name}" answered ${r.status} to an UNAUTHENTICATED request.`)
    else add(G3, name, 'warn', `Unexpected status ${r.status} (${errorOf(r) ?? 'no error code'}) for an unauthenticated request.`)
  }
  await expect401('telegram-auth', { initData: 'not-valid' })
  await expect401('place-order', {})
  await expect401('create-deposit', { amountUsd: 10, asset: 'TON' }, true)
  await expect401('verify-deposit', { depositId: ZERO_UUID }, true)

  for (const name of ['sync-catalog', 'sync-order-status']) {
    const r = await fn(name, { body: {} })
    if (r.status === 404) add(G3, name, 'fail', notDeployed(name))
    else if (r.status === 500) add(G3, name, 'fail', misconfigured(name, r))
    else if (r.status === 401) add(G3, name, 'pass', 'Deployed and protected: refuses calls without the cron secret / service key.')
    else if (r.status >= 200 && r.status < 300) add(G3, name, 'fail', `CRITICAL: "${name}" ran for an unauthenticated caller.`)
    else add(G3, name, 'warn', `Unexpected status ${r.status} for an unauthenticated call.`)
  }

  if (cfg.cronSecret && cfg.runWorkers) {
    const r = await fn('sync-order-status', { headers: { 'x-cron-secret': cfg.cronSecret }, body: {} })
    const j = r.json as { checked?: unknown; errors?: unknown[] } | null
    if (r.status === 200 && typeof j?.checked === 'number') add(G3, 'sync-order-status:run', Array.isArray(j.errors) && j.errors.length ? 'warn' : 'pass', `Worker ran: checked ${j.checked} order(s), ${Array.isArray(j.errors) ? j.errors.length : 0} error(s).`)
    else if (r.status === 401) add(G3, 'sync-order-status:run', 'fail', 'CRON_SECRET on this machine does not match the one stored in Supabase secrets.')
    else add(G3, 'sync-order-status:run', 'fail', `Worker call failed (HTTP ${r.status}).`)
  } else {
    add(G3, 'sync-order-status:run', 'skip', 'Pass --run-workers with CRON_SECRET to execute one idempotent sync run.')
  }

  // functions must authenticate with the SAME secret PostgREST accepts
  if (cfg.jwtSecret && userHeaders) {
    const ok = await fn('place-order', { headers: userHeaders, body: {} })
    if (ok.status === 400 && errorOf(ok) === 'invalid_input') add(G3, 'jwt-secret-matches', 'pass', 'Edge Functions accept tokens signed with this JWT_SECRET (and PostgREST does too).')
    else if (ok.status === 401) add(G3, 'jwt-secret-matches', 'fail', 'Edge Functions REJECT this JWT_SECRET: the JWT_SECRET stored in Supabase secrets differs from the project secret.')
    else add(G3, 'jwt-secret-matches', 'warn', `Unexpected status ${ok.status} (${errorOf(ok) ?? '-'}) from place-order with a valid token.`)

    const { token: forged } = await signJwt({ sub: userId!, role: 'authenticated', aud: 'authenticated' }, `${cfg.jwtSecret}-wrong`, 300)
    const bad = await fn('place-order', { headers: { Authorization: `Bearer ${forged}` }, body: {} })
    add(G3, 'forged-token-rejected', bad.status === 401 ? 'pass' : 'fail', bad.status === 401 ? 'A token signed with the wrong secret is rejected.' : `CRITICAL: a forged token was not rejected (HTTP ${bad.status}).`)
  }

  const cors = await fn('place-order', { method: 'OPTIONS', headers: { Origin: cfg.appUrl ?? 'https://example.com', 'Access-Control-Request-Method': 'POST' } })
  const allowOrigin = cors.headers.get('access-control-allow-origin')
  if (cors.status !== 204 && cors.status !== 200) add(G3, 'cors', 'fail', `CORS preflight failed (HTTP ${cors.status}).`)
  else if (allowOrigin === '*') add(G3, 'cors', 'warn', 'Functions allow any origin ("*"). Set the ALLOWED_ORIGIN secret to your app origin.')
  else if (cfg.appUrl && allowOrigin !== new URL(cfg.appUrl).origin) add(G3, 'cors', 'fail', `ALLOWED_ORIGIN is "${allowOrigin}" but the app is served from ${new URL(cfg.appUrl).origin}: browsers will block every call.`)
  else add(G3, 'cors', 'pass', `CORS allows ${allowOrigin}.`)

  // ===========================================================================
  // 4. Frontend (Vercel)
  // ===========================================================================
  const G4 = 'frontend'
  if (!cfg.appUrl) {
    add(G4, 'app', 'skip', 'Set APP_URL (your Vercel URL) to check the deployed site, manifest and bundle.')
  } else {
    const app = new URL(cfg.appUrl).origin
    const index = await http('GET', `${app}/`)
    if (index.status !== 200 || !index.text.includes('id="root"')) {
      add(G4, 'index', 'fail', `${app}/ did not return the app (HTTP ${index.status}).`)
    } else {
      add(G4, 'index', 'pass', 'Site is up.')
      const frame = (index.headers.get('x-frame-options') ?? '').toUpperCase()
      add(G4, 'embeddable', frame === 'DENY' || frame === 'SAMEORIGIN' ? 'fail' : 'pass', frame ? `X-Frame-Options: ${frame} blocks Telegram Web from embedding the app.` : 'No frame-blocking header (Telegram Web can embed the Mini App).')

      const scripts = [...index.text.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
      const files: { path: string; text: string }[] = []
      for (const s of scripts) files.push({ path: s, text: (await http('GET', `${app}${s}`)).text })
      const hits = scanBundleForSecrets(files)
      add(G4, 'bundle-secrets', hits.length ? 'fail' : 'pass', hits.length ? `CRITICAL: the public JavaScript contains secrets / server-only names: ${hits.map((h) => `${h.file}: ${h.message}`).join('; ')}` : `Scanned ${files.length} script(s): no secrets or server-only names.`)
    }

    const mf = await http('GET', `${app}/tonconnect-manifest.json`)
    if (mf.status !== 200 || !mf.json) {
      add(G4, 'manifest', 'fail', `${app}/tonconnect-manifest.json is not served (HTTP ${mf.status}). Wallets cannot connect.`)
    } else {
      const findings: Finding[] = checkManifest(mf.json, { production: true, appUrl: app })
      const errs = findings.filter((f) => f.level === 'error')
      add(G4, 'manifest', errs.length ? 'fail' : findings.length ? 'warn' : 'pass', errs.length || findings.length ? findings.map((f) => f.message).join(' ') : 'Manifest is valid and matches the app origin.')
      add(G4, 'manifest-cors', mf.headers.get('access-control-allow-origin') === '*' ? 'pass' : 'fail', mf.headers.get('access-control-allow-origin') === '*' ? 'Manifest is CORS-enabled.' : 'Manifest lacks "Access-Control-Allow-Origin: *" (see vercel.json): wallets will fail to load it.')
      const legal = [(mf.json as Partial<Manifest>).termsOfUseUrl, (mf.json as Partial<Manifest>).privacyPolicyUrl].filter((u): u is string => typeof u === 'string')
      if (legal.length === 0) {
        add(G4, 'legal-pages', 'warn', 'The manifest has no terms / privacy links.')
      } else {
        const dead: string[] = []
        for (const u of legal) {
          const r = await http('GET', u)
          if (r.status !== 200 || !/<html/i.test(r.text)) dead.push(`${u} (HTTP ${r.status})`)
        }
        add(G4, 'legal-pages', dead.length ? 'fail' : 'pass', dead.length ? `Legal pages linked from the wallet dialog are not reachable: ${dead.join(', ')}.` : 'Terms and privacy pages are reachable.')
      }
      const icon = (mf.json as Partial<Manifest>).iconUrl
      if (typeof icon === 'string') {
        const iconRes = await http('GET', icon)
        add(G4, 'manifest-icon', iconRes.status === 200 && (iconRes.headers.get('content-type') ?? '').startsWith('image/') ? 'pass' : 'fail', iconRes.status === 200 ? 'Icon is served as an image.' : `iconUrl returned HTTP ${iconRes.status}.`)
      }
    }
  }

  // ===========================================================================
  // 5. Telegram bot
  // ===========================================================================
  const G5 = 'telegram'
  if (!cfg.telegramBotToken) {
    add(G5, 'bot', 'skip', 'Set TELEGRAM_BOT_TOKEN (locally) to verify the bot and its menu button.')
  } else {
    const tg = (method: string) => http('GET', `https://api.telegram.org/bot${cfg.telegramBotToken}/${method}`)
    const me = await tg('getMe')
    const meJson = me.json as { ok?: boolean; result?: { username?: string } } | null
    if (me.status === 200 && meJson?.ok) add(G5, 'bot-token', 'pass', `Token is valid (@${meJson.result?.username}).`)
    else add(G5, 'bot-token', 'fail', 'Telegram rejected TELEGRAM_BOT_TOKEN (getMe failed).')

    if (meJson?.ok) {
      const menu = await tg('getChatMenuButton')
      const m = (menu.json as { result?: { type?: string; web_app?: { url?: string } } } | null)?.result
      if (m?.type !== 'web_app') add(G5, 'menu-button', 'warn', `The bot's menu button is "${m?.type ?? 'unknown'}", not a Web App. Configure it in @BotFather (Bot Settings -> Menu Button).`)
      else if (cfg.appUrl && m.web_app?.url && new URL(m.web_app.url).origin !== new URL(cfg.appUrl).origin) add(G5, 'menu-button', 'fail', `The menu button opens ${m.web_app.url}, not ${cfg.appUrl}.`)
      else add(G5, 'menu-button', 'pass', `Menu button opens ${m.web_app?.url}.`)
    }
  }

  // ===========================================================================
  // 6. TON
  // ===========================================================================
  const G6 = 'ton'
  if (cfg.depositsOff) {
    add(G6, 'ton', 'skip', 'Deposits are switched off on purpose (--deposits-off): TON checks skipped.')
  } else if (!cfg.tonRecipientAddress) {
    add(G6, 'recipient', 'skip', 'Set TON_RECIPIENT_ADDRESS (+ TON_NETWORK) to verify the wallet and the Toncenter API.')
  } else {
    const probe = checkFunctionSecrets({ TON_RECIPIENT_ADDRESS: cfg.tonRecipientAddress, TON_NETWORK: cfg.tonNetwork }).filter((f) => f.id === 'TON_RECIPIENT_ADDRESS' || f.id === 'TON_NETWORK')
    const errs = probe.filter((f) => f.level === 'error')
    add(G6, 'recipient', errs.length ? 'fail' : probe.length ? 'warn' : 'pass', probe.length ? probe.map((f) => f.message).join(' ') : 'Recipient address is valid for the configured network.')

    if (!errs.length) {
      const origin = cfg.toncenterUrl || (cfg.tonNetwork === 'testnet' ? 'https://testnet.toncenter.com' : 'https://toncenter.com')
      const url = `${origin}/api/v3/transactions?account=${encodeURIComponent(toRawAddress(cfg.tonRecipientAddress))}&limit=1&sort=desc`
      const tc = await http('GET', url, { headers: cfg.toncenterApiKey ? { 'X-API-Key': cfg.toncenterApiKey } : {} })
      if (tc.status === 429) add(G6, 'toncenter', 'warn', 'Toncenter rate-limited this request (HTTP 429). Set TONCENTER_API_KEY.')
      else if (tc.status !== 200) add(G6, 'toncenter', 'fail', `Toncenter answered HTTP ${tc.status}.`)
      else {
        try {
          const parsed = normalizeToncenterTransactions(tc.json)
          add(G6, 'toncenter', 'pass', `Toncenter reachable; response shape understood (${parsed.length} recent incoming transfer(s) parsed).`)
        } catch {
          add(G6, 'toncenter', 'fail', 'Toncenter answered but the response shape is not what verify-deposit expects. Do NOT go live: deposits would never confirm.')
        }
      }
    }
  }

  // ===========================================================================
  // 7. Offline validation of the secrets file, if provided
  // ===========================================================================
  if (cfg.functionSecrets) {
    const findings = checkFunctionSecrets(cfg.functionSecrets)
    const errs = findings.filter((f) => f.level === 'error')
    add('secrets', 'function-secrets', errs.length ? 'fail' : findings.length ? 'warn' : 'pass', findings.length ? findings.map((f) => `${f.id}: ${f.message}`).join(' | ') : 'All function secrets look valid.')
  }
  return results
}

export const summarize = (results: CheckResult[]) => ({
  pass: results.filter((r) => r.status === 'pass').length,
  warn: results.filter((r) => r.status === 'warn').length,
  skip: results.filter((r) => r.status === 'skip').length,
  fail: results.filter((r) => r.status === 'fail').length,
})

export function formatResults(results: CheckResult[]): string {
  const icon: Record<Status, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }
  const lines: string[] = []
  let group = ''
  for (const r of results) {
    if (r.group !== group) {
      group = r.group
      lines.push(`\n[${group}]`)
    }
    lines.push(`  ${icon[r.status]}  ${r.id}: ${r.detail}`)
  }
  const s = summarize(results)
  lines.push(`\n${s.pass} passed, ${s.fail} failed, ${s.warn} warnings, ${s.skip} skipped`)
  return lines.join('\n')
}
