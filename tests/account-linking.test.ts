// The website's Telegram sign-in is Telegram's own Login Widget, and a signed-in profile connects its Telegram account and an e-mail
// (web-auth LINK_*, migration 20261223000000), against the real SQL (all migrations in PGlite). The bot sign-in is gone: the bot keeps the
// order hub and the welcome.
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleWebAuth, parseWebAuthRequest, verifyTelegramWidget, type LinkResult, type TelegramWidgetPayload, type WebAuthPorts, type WebUser } from '../supabase/functions/_shared/web-auth.ts'
import { botLang, handleBotUpdate, webhookSecretOk, type BotPorts } from '../supabase/functions/_shared/telegram-bot.ts'
import { hasBearer } from '../supabase/functions/_shared/discounts.ts'

const BOT_TOKEN = '123456:TEST-bot-token'
const NOW = 1_800_000_000

/** Telegram's own algorithm, computed independently (https://core.telegram.org/widgets/login#checking-authorization). */
function signWidget(fields: Record<string, string | number>, token = BOT_TOKEN): TelegramWidgetPayload {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const hash = createHmac('sha256', createHash('sha256').update(token).digest()).update(check).digest('hex')
  return { ...(fields as unknown as TelegramWidgetPayload), hash }
}

let db: PGlite
const mails: { to: string; code: string; purpose: string }[] = []
const calls: { method: string; body: Record<string, unknown> }[] = []

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
}, 180_000)
afterAll(async () => { await db.close() })
beforeEach(() => { mails.length = 0; calls.length = 0 })

const one = async <T>(sql: string, args: unknown[] = []) => (await db.query<{ r: T }>(sql, args)).rows[0].r
const rpc = (fn: string, args: unknown[]) => one<LinkResult>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args)

const ports = (userId: string | null): WebAuthPorts => ({
  async rateHit() { return true },
  async issueCode() { throw new Error('not used') },
  async verifyCode() { throw new Error('not used') },
  async findByEmail() { return null },
  async updatePasswordHash() {},
  async upsertTelegramUser(w) {
    return one<WebUser>(`insert into users (telegram_id, username, first_name) values ($1, $2, $3)
      on conflict (telegram_id) do update set username = excluded.username, first_name = excluded.first_name
      returning to_jsonb(users.*) - 'password_hash' r`, [w.id, w.username ?? null, w.first_name ?? null])
  },
  async session(user, method) { return { token: `jwt-${user.id}`, user: { id: user.id, telegramId: user.telegram_id === null ? null : Number(user.telegram_id), email: user.email }, method } },
  async sendEmail(m) { mails.push({ to: m.to, code: m.code, purpose: m.purpose }); return 'sent' },
  userId,
  linkTelegram: (id, w) => rpc('web_link_telegram', [id, w.id, w.username ?? null, w.first_name ?? null]),
  issueLinkCode: (a) => rpc('web_link_email_issue', [a.userId, a.email, a.codeHash, a.ttlSeconds]),
  verifyLinkCode: (a) => rpc('web_link_email_verify', [a.userId, a.email, a.codeHash, a.passwordHash]),
  emailReady: true,
  codeSecret: 'code-secret',
  botToken: BOT_TOKEN,
  ipKey: 'ip1',
  now: () => NOW * 1000,
})
const web = async (body: Record<string, unknown>, userId: string | null = null) => {
  const req = parseWebAuthRequest(body)
  if ('error' in req) throw new Error(req.error)
  return handleWebAuth(req, ports(userId))
}
const newUser = (o: { telegram?: number; email?: string } = {}) =>
  one<string>(`insert into users (telegram_id, email, email_verified_at) values ($1, $2, case when $2::text is null then null else now() end) returning id r`,
    [o.telegram ?? null, o.email ?? null])

describe('the Telegram Login Widget signature (HMAC-SHA-256 under SHA-256 of the bot token)', () => {
  const fields = { id: 1001, first_name: 'Alice', username: 'alice', photo_url: 'https://t.me/i/userpic/320/a.jpg', auth_date: NOW - 60 }

  it('REQUIRED: accepts exactly what Telegram signed', async () => {
    expect(await verifyTelegramWidget(signWidget(fields), BOT_TOKEN, NOW)).toBe(true)
    expect(await verifyTelegramWidget(signWidget({ id: 7, auth_date: NOW }), BOT_TOKEN, NOW)).toBe(true) // only the required fields
  })

  it('REQUIRED: refuses a changed field, a missing field, another bot\'s signature, a stale or a future payload', async () => {
    expect(await verifyTelegramWidget({ ...signWidget(fields), id: 1002 }, BOT_TOKEN, NOW)).toBe(false)
    expect(await verifyTelegramWidget({ ...signWidget(fields), username: 'mallory' }, BOT_TOKEN, NOW)).toBe(false)
    const { photo_url: _drop, ...noPhoto } = signWidget(fields)
    expect(await verifyTelegramWidget(noPhoto, BOT_TOKEN, NOW)).toBe(false)
    expect(await verifyTelegramWidget(signWidget(fields, '999:other-bot'), BOT_TOKEN, NOW)).toBe(false)
    expect(await verifyTelegramWidget(signWidget({ ...fields, auth_date: NOW - 86_401 }), BOT_TOKEN, NOW)).toBe(false) // older than a day
    expect(await verifyTelegramWidget(signWidget({ ...fields, auth_date: NOW + 120 }), BOT_TOKEN, NOW)).toBe(false)
  })

  it('signs in (the first time creates the profile) and refuses a forged payload', async () => {
    const r = await web({ action: 'TELEGRAM_WIDGET_LOGIN', widget: signWidget({ id: 3003, first_name: 'Bob', auth_date: NOW }) })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, method: 'telegram_widget', user: { telegramId: 3003 } })
    const forged = await web({ action: 'TELEGRAM_WIDGET_LOGIN', widget: { ...signWidget({ id: 3003, auth_date: NOW }), id: 4004 } })
    expect(forged).toMatchObject({ status: 401, body: { error: 'telegram_invalid' } })
  })
})

describe('connected accounts: Telegram', () => {
  it('REQUIRED: an e-mail profile connects its Telegram; the new session carries the Telegram id', async () => {
    const u = await newUser({ email: 'carol@example.com' })
    const r = await web({ action: 'LINK_TELEGRAM', widget: signWidget({ id: 5005, username: 'carol', first_name: 'Carol', auth_date: NOW }) }, u)
    expect(r).toMatchObject({ status: 200, body: { success: true, linked: 'telegram', user: { id: u, telegramId: 5005, email: 'carol@example.com' } } })
    expect(await one(`select json_build_object('tg', telegram_id, 'u', username, 'f', first_name) r from users where id = $1`, [u])).toEqual({ tg: 5005, u: 'carol', f: 'Carol' })
    // the same again is fine (refreshed); another one is not
    expect((await web({ action: 'LINK_TELEGRAM', widget: signWidget({ id: 5005, auth_date: NOW }) }, u)).status).toBe(200)
    expect(await web({ action: 'LINK_TELEGRAM', widget: signWidget({ id: 5006, auth_date: NOW }) }, u)).toMatchObject({ status: 409, body: { error: 'already_linked' } })
  })

  it('REQUIRED: a Telegram account with its own profile is refused (two profiles are never merged)', async () => {
    await newUser({ telegram: 6006 })
    const u = await newUser({ email: 'dave@example.com' })
    expect(await web({ action: 'LINK_TELEGRAM', widget: signWidget({ id: 6006, auth_date: NOW }) }, u)).toMatchObject({ status: 409, body: { error: 'telegram_taken' } })
    expect(await one(`select telegram_id r from users where id = $1`, [u])).toBeNull()
  })

  it('needs the signed-in profile\'s JWT and a genuine widget payload', async () => {
    expect(await web({ action: 'LINK_TELEGRAM', widget: signWidget({ id: 7007, auth_date: NOW }) }, null)).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    const u = await newUser({ email: 'erin@example.com' })
    expect(await web({ action: 'LINK_TELEGRAM', widget: { ...signWidget({ id: 7007, auth_date: NOW }), id: 7008 } }, u)).toMatchObject({ status: 401, body: { error: 'telegram_invalid' } })
  })
})

describe('connected accounts: e-mail', () => {
  it('REQUIRED: a Telegram profile connects an e-mail with a code (and an optional password): verified, signs in with it later', async () => {
    const u = await newUser({ telegram: 8008 })
    const sent = await web({ action: 'LINK_EMAIL_REQUEST', email: 'Frank@Example.com', lang: 'ru' }, u)
    expect(sent).toMatchObject({ status: 200, body: { codeSent: true, email: 'frank@example.com' } })
    expect(mails).toEqual([{ to: 'frank@example.com', code: expect.stringMatching(/^\d{6}$/), purpose: 'link_email' }])
    const wrong = await web({ action: 'LINK_EMAIL_VERIFY', email: 'frank@example.com', code: mails[0].code === '000000' ? '111111' : '000000' }, u)
    expect(wrong).toMatchObject({ status: 400, body: { error: 'code_invalid', attemptsLeft: 4 } })
    const ok = await web({ action: 'LINK_EMAIL_VERIFY', email: 'frank@example.com', code: mails[0].code, password: 'correct horse' }, u)
    expect(ok).toMatchObject({ status: 200, body: { linked: 'email', user: { id: u, telegramId: 8008, email: 'frank@example.com' } } })
    const row = await one<{ email: string; verified: boolean; pw: boolean }>(`select json_build_object('email', email, 'verified', email_verified_at is not null, 'pw', password_hash like 'pbkdf2_sha256$%') r from users where id = $1`, [u])
    expect(row).toEqual({ email: 'frank@example.com', verified: true, pw: true })
    expect(await web({ action: 'LINK_EMAIL_REQUEST', email: 'other@example.com' }, u)).toMatchObject({ status: 409, body: { error: 'already_linked' } })
  })

  it('REQUIRED: an address with its own profile is refused; a code sent to one profile cannot be redeemed by another', async () => {
    await newUser({ email: 'grace@example.com' })
    const u = await newUser({ telegram: 9009 })
    expect(await web({ action: 'LINK_EMAIL_REQUEST', email: 'grace@example.com' }, u)).toMatchObject({ status: 409, body: { error: 'email_taken' } })
    expect(mails).toEqual([])

    await web({ action: 'LINK_EMAIL_REQUEST', email: 'heidi@example.com' }, u)
    const thief = await newUser({ telegram: 9010 })
    expect(await web({ action: 'LINK_EMAIL_VERIFY', email: 'heidi@example.com', code: mails[0].code }, thief)).toMatchObject({ status: 400, body: { error: 'code_invalid' } })
    expect(await one(`select email r from users where id = $1`, [thief])).toBeNull()
    // one code a minute per address
    expect(await web({ action: 'LINK_EMAIL_REQUEST', email: 'heidi@example.com' }, u)).toMatchObject({ status: 429, body: { error: 'code_cooldown' } })
  })

  it('needs the JWT; a short password is refused before anything', async () => {
    expect(await web({ action: 'LINK_EMAIL_REQUEST', email: 'ivan@example.com' }, null)).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    expect(parseWebAuthRequest({ action: 'LINK_EMAIL_VERIFY', email: 'ivan@example.com', code: '123456', password: 'short' })).toHaveProperty('error')
    expect(parseWebAuthRequest({ action: 'LINK_EMAIL_VERIFY', email: 'ivan@example.com', code: '123456' })).toMatchObject({ password: null })
  })
})

describe('the bot without the sign-in', () => {
  const botPorts: BotPorts = { async telegram(method, body) { calls.push({ method, body }) }, webAppUrl: 'https://ghte-pr.vercel.app/' }

  it('a plain /start, and an old sign-in link, greet with the Mini App button', async () => {
    expect(await handleBotUpdate({ message: { chat: { id: 5, type: 'private' }, from: { id: 5, language_code: 'uk' }, text: '/start' } }, botPorts)).toBe('welcome')
    expect(calls[0].body).toMatchObject({ chat_id: 5, reply_markup: { inline_keyboard: [[{ text: '🚀 Відкрити застосунок', web_app: { url: 'https://ghte-pr.vercel.app/' } }]] } })
    expect(await handleBotUpdate({ message: { chat: { id: 5, type: 'private' }, from: { id: 5 }, text: `/start auth_${'x'.repeat(32)}` } }, botPorts)).toBe('welcome')
  })

  it('a button of an old sign-in question only stops its spinner; strange updates are harmless', async () => {
    expect(await handleBotUpdate({ callback_query: { id: 'cb1', from: { id: 5 }, data: `auth_ok:${'x'.repeat(32)}` } }, botPorts)).toBe('ignored')
    expect(calls).toEqual([{ method: 'answerCallbackQuery', body: { callback_query_id: 'cb1' } }])
    expect(await handleBotUpdate({}, botPorts)).toBe('ignored')
    expect(await handleBotUpdate({ message: { chat: { id: 1, type: 'group' }, from: { id: 1 }, text: '/start' } }, botPorts)).toBe('ignored')
  })

  it('server only; the bot sign-in is gone from the database; the webhook only answers Telegram', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['web_link_telegram(uuid, bigint, text, text)', 'web_link_email_issue(uuid, text, text, integer)', 'web_link_email_verify(uuid, text, text, text)']) {
        expect(await one<boolean>(`select has_function_privilege('${role}', 'public.${fn}', 'execute') r`)).toBe(false)
      }
    }
    expect(await one(`select to_regclass('public.web_bot_logins') r`)).toBeNull()
    expect(await one(`select count(*)::int r from pg_proc where proname like 'bot_login_%'`)).toBe(0)
    expect(webhookSecretOk('s3cr3t-value', 's3cr3t-value')).toBe(true)
    expect(webhookSecretOk('s3cr3t-valuX', 's3cr3t-value')).toBe(false)
    expect(webhookSecretOk(null, 's3cr3t-value')).toBe(false)
    expect(webhookSecretOk('anything', undefined)).toBe(false)
    expect(botLang('uk-UA')).toBe('uk')
    expect(botLang('de')).toBe('en')
    expect(hasBearer(null)).toBe(false)
    expect(hasBearer('Bearer eyJ.x.y')).toBe(true)
    expect(parseWebAuthRequest({ action: 'BOT_LOGIN_INIT' })).toHaveProperty('error')
  })
})
