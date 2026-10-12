// @vitest-environment jsdom
// Web expansion step 1: e-mail + password + 6-digit code sign-in and the Telegram Login Widget, issuing the same JWT as
// telegram-auth, on the same users / wallets. The flow runs against the REAL SQL (all migrations in PGlite) through the same
// ports the Edge Function uses.
import fs from 'node:fs'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_LENGTH, PBKDF2_ITERATIONS, generateOtpCode, hashOtpCode, hashPassword, isValidEmail, needsRehash, passwordProblem, safeEq, verifyPassword,
} from '../supabase/functions/_shared/web-auth-crypto.ts'
import { emailConfigured, renderCodeEmail, sendCodeEmail, type CodeEmail } from '../supabase/functions/_shared/email-sender.ts'
import {
  LIMITS, handleWebAuth, normalizeReferral, parseWebAuthRequest, verifyTelegramWidget, type TelegramWidgetPayload, type WebAuthPorts,
  type WebAuthRequest, type WebUser,
} from '../supabase/functions/_shared/web-auth.ts'
import { signJwt, verifyJwt } from '../supabase/functions/_shared/jwt.ts'
import { notifyUser } from '../supabase/functions/_shared/telegram-notify.ts'

const SECRET = 'test-jwt-secret-0123456789abcdef' // secret-scan:allow (test-only value)
const BOT_TOKEN = '123456:TEST-bot-token' // secret-scan:allow (test-only value)
const env = (vars: Record<string, string>) => ({ get: (n: string) => vars[n] })

describe('web-auth crypto', () => {
  it('PBKDF2 hashes verify, carry their iterations and match the database format', async () => {
    const h = await hashPassword('correct horse battery')
    expect(h).toMatch(new RegExp(`^pbkdf2_sha256\\$${PBKDF2_ITERATIONS}\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$`))
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(await verifyPassword('correct horse batterY', h)).toBe(false)
    expect(await hashPassword('correct horse battery')).not.toBe(h) // a fresh salt every time
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', null)).toBe(false)
    expect(needsRehash(h)).toBe(false)
    expect(needsRehash(await hashPassword('old one here', 100_000))).toBe(true)
    expect(safeEq('abc', 'abc')).toBe(true)
    expect(safeEq('abc', 'abd')).toBe(false)
  })

  it('codes are 6 digits from the CSPRNG; their hash depends on the address, the purpose and the secret', async () => {
    const codes = Array.from({ length: 300 }, generateOtpCode)
    for (const c of codes) expect(c).toMatch(/^\d{6}$/)
    expect(new Set(codes).size).toBeGreaterThan(290)
    expect(CODE_LENGTH).toBe(6)
    const a = await hashOtpCode('A@B.co', 'login_code', '123456', 's')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashOtpCode('a@b.co', 'login_code', '123456', 's')).toBe(a) // case-insensitive address
    expect(await hashOtpCode('a@b.co', 'reset_password', '123456', 's')).not.toBe(a)
    expect(await hashOtpCode('a@b.co', 'login_code', '123456', 't')).not.toBe(a)
  })

  it('e-mail and password rules', () => {
    for (const ok of ['user@example.com', 'First.Last+tag@sub.example.co.uk', ' Mixed@Example.COM ']) expect(isValidEmail(ok), ok).toBe(true)
    for (const bad of ['', 'a@b', 'no-at.example.com', 'a@@b.com', '.a@b.com', 'a..b@c.com', 'a@-b.com', 'a@b.c', 'ü@b.com', `${'a'.repeat(65)}@b.com`, 42]) expect(isValidEmail(bad), String(bad)).toBe(false)
    expect(passwordProblem('1234567')).toMatch(/at least 8/)
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/)
    expect(passwordProblem('        ')).toMatch(/spaces/)
    expect(passwordProblem('good-password')).toBeNull()
  })
})

// a widget payload signed the way Telegram signs it
async function signWidget(w: Omit<TelegramWidgetPayload, 'hash'>, token = BOT_TOKEN): Promise<TelegramWidgetPayload> {
  const fields = Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secret = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const key = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = Buffer.from(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(check))).toString('hex')
  return { ...w, hash: mac }
}

describe('Telegram Login Widget', () => {
  const now = 1_800_000_000
  it('accepts a correctly signed, recent payload and nothing else', async () => {
    const w = await signWidget({ id: 777, first_name: 'Ann', username: 'ann', auth_date: now - 30 })
    expect(await verifyTelegramWidget(w, BOT_TOKEN, now)).toBe(true)
    expect(await verifyTelegramWidget({ ...w, username: 'mallory' }, BOT_TOKEN, now)).toBe(false) // tampered field
    expect(await verifyTelegramWidget(w, 'other:token', now)).toBe(false) // another bot
    expect(await verifyTelegramWidget(w, BOT_TOKEN, now + 2 * 86_400)).toBe(false) // a stale, replayed payload
    expect(await verifyTelegramWidget(await signWidget({ id: 777, auth_date: now + 3600 }), BOT_TOKEN, now)).toBe(false) // from the future
  })
})

describe('request parsing', () => {
  it('normalises the address and the invite, validates every action', () => {
    expect(parseWebAuthRequest({ action: 'register', email: ' Ann@Example.com ', password: 'long enough', referralCode: 'ref_ABCdef12' }))
      .toEqual({ action: 'REGISTER', email: 'ann@example.com', password: 'long enough', referralCode: 'abcdef12', lang: null })
    expect(parseWebAuthRequest({ action: 'REGISTER', email: 'ann@example.com', password: 'short' })).toHaveProperty('error')
    expect(parseWebAuthRequest({ action: 'VERIFY_CODE', email: 'ann@example.com', code: '12345', purpose: 'login_code' })).toHaveProperty('error')
    expect(parseWebAuthRequest({ action: 'VERIFY_CODE', email: 'ann@example.com', code: '123456', purpose: 'reset_password' })).toHaveProperty('error')
    expect(parseWebAuthRequest({ action: 'REQUEST_CODE', email: 'ann@example.com', purpose: 'register_verify' })).toHaveProperty('error')
    expect(parseWebAuthRequest({ action: 'LOGIN_PASSWORD', email: 'nope', password: 'x' })).toEqual({ error: 'Enter a valid e-mail address.' })
    expect(parseWebAuthRequest({ action: 'DROP' })).toHaveProperty('error')
    expect(parseWebAuthRequest(null)).toHaveProperty('error')
    expect(parseWebAuthRequest({ action: 'TELEGRAM_WIDGET_LOGIN', widget: { id: 1, auth_date: 1, hash: 'x' } })).toHaveProperty('error')
    expect(normalizeReferral('bad code!')).toBeNull()
  })
})

describe('e-mail sender', () => {
  const mail: CodeEmail = { to: 'ann@example.com', code: '042137', purpose: 'login_code', lang: 'ru', minutes: 10 }

  it('renders the code in the reader\'s language, escaped, with no tracking', () => {
    const r = renderCodeEmail(mail)
    expect(r.subject).toBe('Код входа в GRAM Hub')
    expect(r.text).toContain('042137')
    expect(r.html).toContain('042137')
    expect(r.html).not.toMatch(/<img|https?:\/\//)
  })

  it('without RESEND_API_KEY: "unconfigured" on a hosted project, the code is NOT logged', async () => {
    const logs: string[] = []
    const log = { info: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})), warn: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})) }
    const hosted = env({ SUPABASE_URL: 'https://abc.supabase.co', MOCK_MODE: 'true' })
    expect(emailConfigured(hosted)).toBe(false)
    expect(await sendCodeEmail(mail, { env: hosted, log })).toBe('unconfigured')
    expect(logs.join()).not.toContain('042137')
    // local development only: the mock prints it
    const local = env({ MOCK_MODE: 'true' })
    expect(emailConfigured(local)).toBe(true)
    expect(await sendCodeEmail(mail, { env: local, log })).toBe('mock_logged')
  })

  it('sends through Resend with the key in the header only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const logs: string[] = []
    const log = { info: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})), warn: (m: string) => logs.push(m) }
    expect(await sendCodeEmail(mail, { env: env({ RESEND_API_KEY: 're_secret', EMAIL_FROM: 'GRAM Hub <no-reply@x.io>' }), fetchImpl, log })).toBe('sent')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer re_secret')
    expect(JSON.parse(init.body)).toMatchObject({ from: 'GRAM Hub <no-reply@x.io>', to: ['ann@example.com'], subject: 'Код входа в GRAM Hub' })
    expect(logs.join()).not.toContain('042137')
    expect(logs.join()).not.toContain('re_secret')
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 422 }))
    expect(await sendCodeEmail(mail, { env: env({ RESEND_API_KEY: 'k' }), fetchImpl, log })).toBe('failed')
  })
})

describe('notifications skip accounts without Telegram', () => {
  it('a null telegram_id (chatId 0) is never sent to', async () => {
    const send = vi.fn()
    const r = await notifyUser({ botToken: 'x', mock: false, claim: async () => true, release: async () => {}, send }, { chatId: Number(null), lang: 'en', enabled: true },
      { type: 'deposit_credited', amount: 5 } as never, 'k')
    expect(r).toBe('disabled')
    expect(send).not.toHaveBeenCalled()
  })
})

// ---- the whole flow against the real SQL ---------------------------------------------------------------------------------------

describe('web-auth flow (database)', () => {
  let db: PGlite
  let inbox: CodeEmail[]
  let ipKey = 'ip-1'
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0]
  const USER_COLS = 'id, telegram_id, email, username, first_name, language_code, is_banned, is_admin'

  const ports = (): WebAuthPorts => ({
    rateHit: async (b, l, w) => (await one<{ r: boolean }>('select auth_rate_hit($1, $2, $3) r', [b, l, w])).r,
    issueCode: async (a) => (await one<{ r: never }>('select web_auth_issue_code($1, $2, $3, $4, $5, $6) r',
      [a.email, a.purpose, a.codeHash, a.ttlSeconds, a.pendingPasswordHash ?? null, a.pendingReferralCode ?? null])).r,
    verifyCode: async (a) => (await one<{ r: never }>('select web_auth_verify_code($1, $2, $3, $4) r', [a.email, a.purpose, a.codeHash, a.newPasswordHash ?? null])).r,
    findByEmail: async (email) => (await one<never>(`select ${USER_COLS}, password_hash from users where email = $1`, [email])) ?? null,
    updatePasswordHash: async (id, h) => { await q('update users set password_hash = $2 where id = $1', [id, h]) },
    upsertTelegramUser: async (w) => {
      const known = await one('select id from users where telegram_id = $1', [w.id])
      if (!known && (await one<{ g: boolean }>('select global_signups_enabled g from platform_settings where id = 1'))?.g === false) return 'signups_paused'
      return one<WebUser>(`insert into users (telegram_id, username, first_name) values ($1, $2, $3)
        on conflict (telegram_id) do update set username = excluded.username, first_name = excluded.first_name returning ${USER_COLS}`, [w.id, w.username ?? null, w.first_name ?? null])
    },
    session: async (user) => {
      const { token, expiresAt } = await signJwt({ sub: user.id, role: 'authenticated', aud: 'authenticated', telegram_id: user.telegram_id }, SECRET, 3600)
      const wallet = await one<{ balance: string }>('select balance from wallets where user_id = $1', [user.id])
      return { token, expiresAt, user: { id: user.id, email: user.email, telegramId: user.telegram_id }, wallet: { balance: Number(wallet.balance) } }
    },
    sendEmail: async (m) => { inbox.push(m); return 'sent' },
    emailReady: true,
    codeSecret: 'code-secret',
    botToken: BOT_TOKEN,
    ipKey,
  })
  const run = (r: WebAuthRequest, over: Partial<WebAuthPorts> = {}) => handleWebAuth(r, { ...ports(), ...over })
  const lastCode = (email: string) => [...inbox].reverse().find((m) => m.to === email)!.code
  // the one-a-minute rule is about wall-clock time: tests move the previous code back instead of waiting
  const age = (email: string) => q(`update email_auth_codes set created_at = created_at - interval '2 minutes' where email = $1`, [email])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }, 180_000)
  beforeEach(() => { inbox = []; ipKey = `ip-${Math.random()}` })
  afterAll(async () => { await db.close() })

  it('the password hash is readable by nobody but the service role; codes and limiter rows are server-only', async () => {
    const col = async (role: string, column: string) => (await one<{ p: boolean }>(`select has_column_privilege('${role}', 'public.users', '${column}', 'select') p`)).p
    expect(await col('authenticated', 'password_hash')).toBe(false)
    expect(await col('anon', 'password_hash')).toBe(false)
    expect(await col('authenticated', 'email')).toBe(true) // own row, through RLS
    expect(await col('authenticated', 'telegram_id')).toBe(true)
    expect(await col('service_role', 'password_hash')).toBe(true)
    for (const t of ['email_auth_codes', 'auth_rate_events']) {
      const g = await one<{ a: boolean; u: boolean; rls: boolean }>(`select has_table_privilege('anon', 'public.${t}', 'select') a, has_table_privilege('authenticated', 'public.${t}', 'select') u,
        (select relrowsecurity from pg_class where oid = 'public.${t}'::regclass) rls`)
      expect([g.a, g.u, g.rls]).toEqual([false, false, true])
    }
    for (const fn of ['web_auth_issue_code(text, text, text, integer, text, text)', 'web_auth_verify_code(text, text, text, text)', 'auth_rate_hit(text, integer, integer)']) {
      const g = await one<{ a: boolean; u: boolean }>(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u`)
      expect([g.a, g.u]).toEqual([false, false])
    }
    // and in practice: the API role reading its own row gets everything but the hash
    const u = await one<{ id: string }>(`insert into users (email, email_verified_at, password_hash) values ('own@example.com', now(), $1) returning id`, [await hashPassword('own-password-1')])
    await db.exec(`set role authenticated; select set_config('request.jwt.sub', '${u.id}', false)`)
    await expect(db.query('select password_hash from users')).rejects.toThrow(/permission denied/)
    expect((await db.query<{ email: string }>('select email from users')).rows).toEqual([{ email: 'own@example.com' }])
    await db.exec(`reset role; select set_config('request.jwt.sub', '', false)`)
  })

  it('identity rules: e-mail or Telegram required, lower case, unique without regard to case', async () => {
    await expect(q('insert into users (username) values ($1)', ['ghost'])).rejects.toThrow(/users_has_identity/)
    await expect(q(`insert into users (email, email_verified_at) values ('Upper@Example.com', now())`)).rejects.toThrow(/users_email_format/)
    await expect(q(`insert into users (email) values ('unverified@example.com')`)).rejects.toThrow(/users_email_verified_pair/)
    await q(`insert into users (email, email_verified_at) values ('dup@example.com', now())`)
    await expect(q(`insert into users (telegram_id, email, email_verified_at) values (5, 'dup@example.com', now())`)).rejects.toThrow(/users_email_lower_uq|duplicate/)
  })

  it('register -> 6-digit code -> verified account with a wallet, the invite applied and a valid session', async () => {
    const referrer = await one<{ referral_code: string; id: string }>(`insert into users (telegram_id) values (424242) returning id, referral_code`)
    const r1 = await run({ action: 'REGISTER', email: 'new@example.com', password: 'new-password-1', referralCode: referrer.referral_code, lang: 'uk' })
    expect(r1).toEqual({ status: 200, body: { success: true, codeSent: true, email: 'new@example.com', expiresInSeconds: 600 } })
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ to: 'new@example.com', purpose: 'register_verify', lang: 'uk' })
    // nothing exists until the code is proved; the code is stored only as a hash
    expect(await one(`select 1 from users where email = 'new@example.com'`)).toBeUndefined()
    const stored = await one<{ code_hash: string; pending_password_hash: string }>(`select code_hash, pending_password_hash from email_auth_codes where email = 'new@example.com'`)
    expect(stored.code_hash).not.toContain(inbox[0].code)
    expect(stored.pending_password_hash).toMatch(/^pbkdf2_sha256\$/)

    const r2 = await run({ action: 'VERIFY_CODE', email: 'new@example.com', code: inbox[0].code, purpose: 'register_verify' })
    expect(r2.status).toBe(200)
    expect(r2.body).toMatchObject({ success: true, created: true, referralApplied: true, wallet: { balance: 0 } })
    const claims = await verifyJwt(r2.body.token as string, SECRET)
    const user = await one<{ id: string; email_verified_at: string | null; telegram_id: null; referred_by: string }>(`select id, email_verified_at, telegram_id, referred_by from users where email = 'new@example.com'`)
    expect(claims).toMatchObject({ sub: user.id, role: 'authenticated', aud: 'authenticated', telegram_id: null })
    expect(user.email_verified_at).not.toBeNull()
    expect(user.telegram_id).toBeNull()
    expect(user.referred_by).toBe(referrer.id)
    // the code is single-use
    expect((await run({ action: 'VERIFY_CODE', email: 'new@example.com', code: inbox[0].code, purpose: 'register_verify' })).body).toMatchObject({ error: 'code_invalid' })
  })

  it('registering a taken address answers the same and sends nothing (no address discovery)', async () => {
    await age('new@example.com')
    const r = await run({ action: 'REGISTER', email: 'new@example.com', password: 'whatever-123', referralCode: null, lang: null })
    expect(r).toEqual({ status: 200, body: { success: true, codeSent: true, email: 'new@example.com', expiresInSeconds: 600 } })
    expect(inbox).toHaveLength(0)
  })

  it('five wrong codes lock the code; even the right one is refused afterwards', async () => {
    await run({ action: 'REGISTER', email: 'brute@example.com', password: 'brute-force-1', referralCode: null, lang: null })
    const good = lastCode('brute@example.com')
    const wrong = good === '000000' ? '111111' : '000000'
    const left: unknown[] = []
    for (let i = 0; i < 4; i++) {
      const r = await run({ action: 'VERIFY_CODE', email: 'brute@example.com', code: wrong, purpose: 'register_verify' })
      expect(r.body.error).toBe('code_invalid')
      left.push(r.body.attemptsLeft)
    }
    expect(left).toEqual([4, 3, 2, 1])
    expect((await run({ action: 'VERIFY_CODE', email: 'brute@example.com', code: wrong, purpose: 'register_verify' })).body.error).toBe('code_locked')
    expect((await run({ action: 'VERIFY_CODE', email: 'brute@example.com', code: good, purpose: 'register_verify' })).body.error).toBe('code_locked')
    expect(await one(`select 1 from users where email = 'brute@example.com'`)).toBeUndefined()
  })

  it('an expired code is refused', async () => {
    await age('brute@example.com')
    await run({ action: 'REGISTER', email: 'brute@example.com', password: 'brute-force-1', referralCode: null, lang: null })
    await q(`update email_auth_codes set expires_at = now() - interval '1 second' where email = 'brute@example.com' and consumed_at is null`)
    expect((await run({ action: 'VERIFY_CODE', email: 'brute@example.com', code: lastCode('brute@example.com'), purpose: 'register_verify' })).body.error).toBe('code_expired')
  })

  it('one code a minute and five an hour per address', async () => {
    await run({ action: 'REGISTER', email: 'flood@example.com', password: 'flood-pass-1', referralCode: null, lang: null })
    const again = await run({ action: 'REGISTER', email: 'flood@example.com', password: 'flood-pass-1', referralCode: null, lang: null })
    expect(again).toMatchObject({ status: 429, body: { error: 'code_cooldown' } })
    for (let i = 0; i < 4; i++) { await age('flood@example.com'); expect((await run({ action: 'REGISTER', email: 'flood@example.com', password: 'flood-pass-1', referralCode: null, lang: null })).status).toBe(200) }
    await age('flood@example.com')
    expect(await run({ action: 'REGISTER', email: 'flood@example.com', password: 'flood-pass-1', referralCode: null, lang: null })).toMatchObject({ status: 429, body: { error: 'rate_limited' } })
    expect(inbox).toHaveLength(5)
  })

  it('a client address is limited across all actions', async () => {
    for (let i = 0; i < LIMITS.ip.limit; i++) await run({ action: 'LOGIN_PASSWORD', email: `x${i}@example.com`, password: 'whatever-1' })
    expect(await run({ action: 'LOGIN_PASSWORD', email: 'y@example.com', password: 'whatever-1' })).toMatchObject({ status: 429, body: { error: 'rate_limited' } })
  })

  it('password sign-in: right password -> session; wrong password and unknown address get the same answer', async () => {
    const ok = await run({ action: 'LOGIN_PASSWORD', email: 'new@example.com', password: 'new-password-1' })
    expect(ok.status).toBe(200)
    expect(await verifyJwt(ok.body.token as string, SECRET)).toMatchObject({ role: 'authenticated' })
    const wrong = await run({ action: 'LOGIN_PASSWORD', email: 'new@example.com', password: 'not-the-password' })
    const unknown = await run({ action: 'LOGIN_PASSWORD', email: 'nobody@example.com', password: 'not-the-password' })
    expect(wrong).toEqual({ status: 401, body: { success: false, error: 'invalid_credentials', message: 'Wrong e-mail or password.' } })
    expect(unknown).toEqual(wrong)
  })

  it('too many password attempts on one account pause password sign-in for it', async () => {
    for (let i = 0; i < LIMITS.passwordFailures.limit; i++) {
      ipKey = `spread-${i}` // different client addresses: the per-account limit still applies
      await run({ action: 'LOGIN_PASSWORD', email: 'brute@example.com', password: `guess-${i}-xx` })
    }
    ipKey = 'spread-last'
    expect(await run({ action: 'LOGIN_PASSWORD', email: 'brute@example.com', password: 'guess-last' })).toMatchObject({ status: 429, body: { error: 'rate_limited' } })
  })

  it('passwordless sign-in with a code; an unknown address gets the same answer and no e-mail', async () => {
    expect(await run({ action: 'REQUEST_CODE', email: 'ghost@example.com', purpose: 'login_code', lang: null })).toMatchObject({ status: 200, body: { codeSent: true } })
    expect(inbox).toHaveLength(0)
    await run({ action: 'REQUEST_CODE', email: 'new@example.com', purpose: 'login_code', lang: 'ru' })
    expect(inbox).toHaveLength(1)
    const r = await run({ action: 'VERIFY_CODE', email: 'new@example.com', code: lastCode('new@example.com'), purpose: 'login_code' })
    expect(r).toMatchObject({ status: 200, body: { success: true, created: false } })
  })

  it('password reset: the code sets a new password, the old one stops working', async () => {
    await age('new@example.com')
    await run({ action: 'REQUEST_CODE', email: 'new@example.com', purpose: 'reset_password', lang: null })
    const code = lastCode('new@example.com')
    const r = await run({ action: 'RESET_PASSWORD', email: 'new@example.com', code, newPassword: 'brand-new-pass-2' })
    expect(r).toMatchObject({ status: 200, body: { success: true, passwordChanged: true } })
    expect((await run({ action: 'LOGIN_PASSWORD', email: 'new@example.com', password: 'new-password-1' })).status).toBe(401)
    expect((await run({ action: 'LOGIN_PASSWORD', email: 'new@example.com', password: 'brand-new-pass-2' })).status).toBe(200)
    expect((await run({ action: 'RESET_PASSWORD', email: 'new@example.com', code, newPassword: 'again-new-pass-3' })).body.error).toBe('code_invalid')
  })

  it('a suspended account cannot sign in by any route, and gets no codes', async () => {
    await q(`update users set is_banned = true where email = 'new@example.com'`)
    expect(await run({ action: 'LOGIN_PASSWORD', email: 'new@example.com', password: 'brand-new-pass-2' })).toMatchObject({ status: 403, body: { error: 'user_banned' } })
    await age('new@example.com')
    expect(await run({ action: 'REQUEST_CODE', email: 'new@example.com', purpose: 'login_code', lang: null })).toMatchObject({ status: 200, body: { codeSent: true } })
    expect(inbox).toHaveLength(0)
    await q(`update users set is_banned = false where email = 'new@example.com'`)
  })

  it('Telegram widget sign-in creates or finds the Telegram account; a forged one is refused', async () => {
    const nowMs = Date.now()
    const w = await signWidget({ id: 990001, first_name: 'Web', username: 'webby', auth_date: Math.floor(nowMs / 1000) - 5 })
    const r = await run({ action: 'TELEGRAM_WIDGET_LOGIN', widget: w })
    expect(r.status).toBe(200)
    expect(await one(`select username from users where telegram_id = 990001`)).toEqual({ username: 'webby' })
    expect(await run({ action: 'TELEGRAM_WIDGET_LOGIN', widget: { ...w, id: 990002 } })).toMatchObject({ status: 401, body: { error: 'telegram_invalid' } })
  })

  it('closed sign-ups: no new e-mail registrations (existing accounts still sign in)', async () => {
    await q('update platform_settings set global_signups_enabled = false where id = 1')
    await expect(run({ action: 'REGISTER', email: 'late@example.com', password: 'late-pass-11', referralCode: null, lang: null })).rejects.toThrow(/signups_paused/)
    expect((await run({ action: 'LOGIN_PASSWORD', email: 'new@example.com', password: 'brand-new-pass-2' })).status).toBe(200)
    await q('update platform_settings set global_signups_enabled = true where id = 1')
  })

  it('without an e-mail provider the flow says so instead of issuing an undeliverable code', async () => {
    expect(await run({ action: 'REQUEST_CODE', email: 'new@example.com', purpose: 'login_code', lang: null }, { emailReady: false }))
      .toMatchObject({ status: 503, body: { error: 'email_unavailable' } })
  })

  it('admins find web accounts by e-mail and see it', async () => {
    const admin = await one<{ id: string }>(`insert into users (telegram_id, is_admin) values (1, true) returning id`)
    await q(`select set_config('request.jwt.sub', $1, false)`, [admin.id])
    const found = (await one<{ r: Record<string, unknown>[] }>(`select admin_find_users('new@exa') r`)).r
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ email: 'new@example.com', telegram_id: null })
    await q(`select set_config('request.jwt.sub', '', false)`)
  })
})

// ---- the browser client --------------------------------------------------------------------------------------------------------

describe('web-auth client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    localStorage.clear()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))

  it('posts each action to web-auth without any Authorization header', async () => {
    reply(200, { success: true, codeSent: true, email: 'a@b.co', expiresInSeconds: 600 })
    const { registerWithEmail } = await import('../src/services/api/web-auth')
    await registerWithEmail('a@b.co', 'password-1', { referralCode: 'ref_abc123', lang: 'ru' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/web-auth')
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(init.body)).toEqual({ action: 'REGISTER', email: 'a@b.co', password: 'password-1', referralCode: 'ref_abc123', lang: 'ru' })
  })

  it('maps refusals with their details', async () => {
    reply(400, { success: false, error: 'code_invalid', message: 'The code is not correct.', attemptsLeft: 3 })
    reply(429, { success: false, error: 'code_cooldown', message: 'wait', retryAfter: 42 })
    reply(500, { success: false, error: 'boom', message: 'internal detail' })
    const { verifyEmailCode, requestEmailCode, loginWithPassword } = await import('../src/services/api/web-auth')
    expect(await verifyEmailCode('a@b.co', '000000', 'login_code').catch((e) => e)).toMatchObject({ code: 'code_invalid', attemptsLeft: 3 })
    expect(await requestEmailCode('a@b.co', 'login_code').catch((e) => e)).toMatchObject({ code: 'code_cooldown', retryAfter: 42 })
    const e = (await loginWithPassword('a@b.co', 'x').catch((x) => x)) as Error
    expect(e).toMatchObject({ code: 'server' })
    expect(e.message).not.toContain('internal detail')
  })

  it('a web session is remembered in a browser and dropped when expired or malformed', async () => {
    const { saveWebSession, loadWebSession, clearWebSession, WEB_SESSION_KEY } = await import('../src/services/api/web-auth')
    const session = { token: 't', expiresAt: Date.now() / 1000 + 3600, user: { id: 'u', telegramId: null, email: 'a@b.co', username: null, firstName: null, languageCode: null, isAdmin: false }, wallet: { balance: 1, currency: 'USD' }, isMock: false }
    saveWebSession(session)
    expect(loadWebSession()).toEqual(session)
    expect(loadWebSession(session.expiresAt - 30)).toBeNull() // under a minute left: forgotten
    expect(localStorage.getItem(WEB_SESSION_KEY)).toBeNull()
    localStorage.setItem(WEB_SESSION_KEY, '{not json')
    expect(loadWebSession()).toBeNull()
    saveWebSession({ ...session, isMock: true })
    expect(localStorage.getItem(WEB_SESSION_KEY)).toBeNull() // the dev mock is never persisted
    saveWebSession(session)
    clearWebSession()
    expect(loadWebSession()).toBeNull()
  })
})
