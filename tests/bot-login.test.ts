// Website sign-in confirmed in the Telegram bot: BOT_LOGIN_INIT (web-auth) -> /start auth_<token> and [Confirm] (telegram-bot webhook)
// -> BOT_LOGIN_POLL (web-auth), against the real SQL (all migrations in PGlite).
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleWebAuth, parseWebAuthRequest, sha256Hex, type WebAuthPorts, type WebUser } from '../supabase/functions/_shared/web-auth.ts'
import { botLang, handleBotUpdate, webhookSecretOk, type BotPorts } from '../supabase/functions/_shared/telegram-bot.ts'
import { hasBearer } from '../supabase/functions/_shared/discounts.ts'

let db: PGlite
const calls: { method: string; body: Record<string, unknown> }[] = []
const buckets: string[] = []

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
beforeEach(() => { calls.length = 0; buckets.length = 0 })

const one = async <T>(sql: string, args: unknown[] = []) => (await db.query<{ r: T }>(sql, args)).rows[0].r

const webPorts = (): WebAuthPorts => ({
  async rateHit(bucket) { buckets.push(bucket); return true },
  async issueCode() { throw new Error('not used') },
  async verifyCode() { throw new Error('not used') },
  async findByEmail() { return null },
  async updatePasswordHash() {},
  async upsertTelegramUser(w) {
    return one<WebUser>(`insert into users (telegram_id, username, first_name) values ($1, $2, $3)
      on conflict (telegram_id) do update set username = excluded.username, first_name = excluded.first_name
      returning to_jsonb(users.*) - 'password_hash' r`, [w.id, w.username ?? null, w.first_name ?? null])
  },
  async session(user, method) { return { token: `jwt-${user.id}`, expiresAt: 1, user: { id: user.id, telegramId: Number(user.telegram_id) }, method } },
  async sendEmail() { return { status: 'sent' } as never },
  async createBotLogin(a) { await db.query(`select bot_login_create($1, $2, $3)`, [a.startHash, a.pollHash, a.ttlSeconds]) },
  async pollBotLogin(pollHash) { return one(`select bot_login_poll($1) r`, [pollHash]) },
  botUsername: 'GHTE_PR_BOT',
  emailReady: false,
  codeSecret: 's',
  botToken: 't',
  ipKey: 'ip1',
})

const botPorts: BotPorts = {
  openLogin: (h, u) => one(`select bot_login_open($1, $2, $3) r`, [h, u.id, JSON.stringify(u)]),
  decideLogin: (h, id, approve) => one(`select bot_login_decide($1, $2, $3) r`, [h, id, approve]),
  async telegram(method, body) { calls.push({ method, body }) },
  webAppUrl: 'https://ghte-pr.vercel.app/',
}

const web = async (body: Record<string, unknown>) => {
  const req = parseWebAuthRequest(body)
  if ('error' in req) throw new Error(req.error)
  return handleWebAuth(req, webPorts())
}
const init = async () => {
  const r = await web({ action: 'BOT_LOGIN_INIT' })
  expect(r.status).toBe(200)
  const link = r.body.link as string
  return { link, start: link.split('start=auth_')[1], pollToken: r.body.pollToken as string, body: r.body }
}
const poll = (pollToken: string) => web({ action: 'BOT_LOGIN_POLL', pollToken })
const ALICE = { id: 1001, first_name: 'Alice', username: 'alice', language_code: 'ru' }
const MALLORY = { id: 2002, first_name: 'M', language_code: 'en' }
const startMsg = (from: typeof ALICE | typeof MALLORY, start: string) => ({ message: { chat: { id: from.id, type: 'private' }, from, text: `/start auth_${start}` } })
const press = (from: typeof ALICE | typeof MALLORY, data: string) => ({ callback_query: { id: 'cb1', from, data, message: { chat: { id: from.id }, message_id: 7 } } })

describe('website sign-in confirmed in the bot', () => {
  it('init: a bot link and a separate poll token; the database keeps only their hashes', async () => {
    const { link, start, pollToken, body } = await init()
    expect(link).toMatch(/^https:\/\/t\.me\/GHTE_PR_BOT\?start=auth_[A-Za-z0-9_-]{32}$/)
    expect(`auth_${start}`.length).toBeLessThanOrEqual(64) // Telegram's limit for a start parameter
    expect(pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(link).not.toContain(pollToken)
    expect(body).toMatchObject({ expiresInSeconds: 300, pollSeconds: 2 })
    const row = (await db.query<Record<string, string>>(`select start_hash, poll_hash, status from web_bot_logins where start_hash = $1`, [await sha256Hex(start)])).rows[0]
    expect(row).toMatchObject({ poll_hash: await sha256Hex(pollToken), status: 'pending' })
    expect(JSON.stringify(row)).not.toContain(start)
  })

  it('the full path: /start -> question with Confirm / Cancel -> Confirm by the same account -> the poll signs in, once', async () => {
    const { start, pollToken } = await init()
    expect((await poll(pollToken)).body).toEqual({ success: true, status: 'pending' })

    expect(await handleBotUpdate(startMsg(ALICE, start), botPorts)).toBe('challenge')
    const question = calls.find((c) => c.method === 'sendMessage')!.body
    expect(question.text).toContain('Подтверждение входа')
    expect(question.reply_markup).toEqual({ inline_keyboard: [[
      { text: '✅ Подтвердить', callback_data: `auth_ok:${start}` },
      { text: '❌ Отмена', callback_data: `auth_no:${start}` },
    ]] })
    expect(`auth_ok:${start}`.length).toBeLessThanOrEqual(64) // Telegram's limit for callback data
    expect((await poll(pollToken)).body).toEqual({ success: true, status: 'opened' })

    // someone else pressing the button (a forwarded message) decides nothing
    calls.length = 0
    await handleBotUpdate(press(MALLORY, `auth_ok:${start}`), botPorts)
    expect(calls).toEqual([{ method: 'answerCallbackQuery', body: expect.objectContaining({ text: 'This sign-in request belongs to another Telegram account.', show_alert: true }) }])
    expect((await poll(pollToken)).body.status).toBe('opened')

    calls.length = 0
    expect(await handleBotUpdate(press(ALICE, `auth_ok:${start}`), botPorts)).toBe('decided')
    expect(calls[0]).toEqual({ method: 'answerCallbackQuery', body: { callback_query_id: 'cb1', text: 'Вход подтверждён!', show_alert: false } })
    expect(calls[1]).toEqual({ method: 'editMessageText', body: { chat_id: ALICE.id, message_id: 7, text: '✅ Вы успешно вошли в аккаунт на сайте!' } })

    const signedIn = await poll(pollToken)
    expect(signedIn.body).toMatchObject({ success: true, status: 'confirmed', method: 'telegram_bot', user: { telegramId: ALICE.id } })
    expect((await poll(pollToken)).body).toEqual({ success: true, status: 'consumed' }) // handed out once
    // pressing again later changes nothing
    calls.length = 0
    await handleBotUpdate(press(ALICE, `auth_ok:${start}`), botPorts)
    expect(calls[0].body).toMatchObject({ text: 'Этот запрос на вход уже завершён.' })
  })

  it('Cancel: nobody signs in', async () => {
    const { start, pollToken } = await init()
    await handleBotUpdate(startMsg(ALICE, start), botPorts)
    calls.length = 0
    await handleBotUpdate(press(ALICE, `auth_no:${start}`), botPorts)
    expect(calls[0].body).toMatchObject({ text: 'Вход отменён.' })
    expect(calls[1].body).toMatchObject({ text: '❌ Вход отменён. Никто не получил доступ к вашему аккаунту.' })
    expect((await poll(pollToken)).body).toEqual({ success: true, status: 'cancelled' })
  })

  it('a link opened by one account cannot be taken over by another; an expired one says so', async () => {
    const { start, pollToken } = await init()
    await handleBotUpdate(startMsg(ALICE, start), botPorts)
    calls.length = 0
    await handleBotUpdate(startMsg(MALLORY, start), botPorts)
    expect(calls[0].body.text).toBe('This sign-in request belongs to another Telegram account.')
    await db.query(`update web_bot_logins set expires_at = now() - interval '1 second' where start_hash = $1`, [await sha256Hex(start)])
    expect((await poll(pollToken)).body.status).toBe('expired')
    calls.length = 0
    await handleBotUpdate(press(ALICE, `auth_ok:${start}`), botPorts)
    expect(calls[0].body).toMatchObject({ text: 'Ссылка для входа устарела. Начните вход на сайте заново.' })
    expect((await poll(pollToken)).body.status).toBe('expired')
  })

  it('unknown tokens and strange updates are harmless', async () => {
    expect((await poll('x'.repeat(43))).body).toEqual({ success: true, status: 'unknown' })
    await handleBotUpdate(startMsg(ALICE, 'y'.repeat(32)), botPorts)
    expect(calls[0].body.text).toBe('Ссылка для входа недействительна. Начните вход на сайте заново.')
    expect(await handleBotUpdate({}, botPorts)).toBe('ignored')
    expect(await handleBotUpdate({ message: { chat: { id: 1, type: 'group' }, from: ALICE, text: '/start auth_x' } }, botPorts)).toBe('ignored')
    calls.length = 0
    expect(await handleBotUpdate(press(ALICE, 'something'), botPorts)).toBe('ignored')
    expect(calls).toEqual([{ method: 'answerCallbackQuery', body: { callback_query_id: 'cb1' } }])
    expect(parseWebAuthRequest({ action: 'BOT_LOGIN_POLL', pollToken: 'short' })).toHaveProperty('error')
  })

  it('a plain /start greets with the Mini App button', async () => {
    expect(await handleBotUpdate({ message: { chat: { id: 5, type: 'private' }, from: { id: 5, language_code: 'uk' }, text: '/start' } }, botPorts)).toBe('welcome')
    expect(calls[0].body).toMatchObject({ chat_id: 5, reply_markup: { inline_keyboard: [[{ text: '🚀 Відкрити застосунок', web_app: { url: 'https://ghte-pr.vercel.app/' } }]] } })
  })

  it('the poll has its own limit (it runs every 2 s); every other action shares the address limit', async () => {
    const { pollToken } = await init()
    await poll(pollToken)
    expect(buckets).toEqual(['ip:ip1', 'botpoll:ip1'])
  })

  it('service role only; the webhook only answers Telegram (secret header); guests price without a token', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of ['bot_login_create(text, text, integer)', 'bot_login_open(text, bigint, jsonb)', 'bot_login_decide(text, bigint, boolean)', 'bot_login_poll(text)']) {
        expect(await one<boolean>(`select has_function_privilege('${role}', 'public.${fn}', 'execute') r`)).toBe(false)
      }
      expect(await one<boolean>(`select has_table_privilege('${role}', 'public.web_bot_logins', 'select') r`)).toBe(false)
    }
    expect(webhookSecretOk('s3cr3t-value', 's3cr3t-value')).toBe(true)
    expect(webhookSecretOk('s3cr3t-valuX', 's3cr3t-value')).toBe(false)
    expect(webhookSecretOk(null, 's3cr3t-value')).toBe(false)
    expect(webhookSecretOk('anything', undefined)).toBe(false)
    expect(botLang('uk-UA')).toBe('uk')
    expect(botLang('de')).toBe('en')
    expect(hasBearer(null)).toBe(false)
    expect(hasBearer('Bearer ')).toBe(false)
    expect(hasBearer('Bearer eyJ.x.y')).toBe(true)
  })
})
