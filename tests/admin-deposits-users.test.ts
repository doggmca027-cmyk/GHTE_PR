// @vitest-environment jsdom
// Admin UI for the two RPCs that were only called by hand: admin_resolve_deposit (credit / dismiss a deposit case) and
// admin_set_user_ban (suspend / restore a customer), plus admin_find_users and the deposit block of list_reconciliation_cases.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminActionError, depositCaseFacts, isTxHash, tonToNano } from '../src/lib/deposit-case'
import { createMockAdmin } from '../src/services/api/mock-admin'
import type { AuthSession } from '../src/services/api/auth'
import type { ReconCase } from '../src/types/admin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HASH = 'kq3Zk9mWvB0d7rM5tq1nqZ1y8hYQe7Q3x9vKpQ2l1cA='
const memoryStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } }
const session = (over: Partial<AuthSession> = {}): AuthSession => ({
  token: 'jwt', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' },
  user: { id: 'admin-1', telegramId: 1, username: 'boss', firstName: 'B', languageCode: 'ru', isAdmin: true }, ...over,
})

describe('deposit case helpers', () => {
  it('reads what the verifier wrote: the issue, the transaction and what arrived', () => {
    expect(depositCaseFacts(`underpaid: received 4.5 TON of 5 in tx ${HASH}`)).toEqual({ issue: 'underpaid', txHash: HASH, receivedTon: 4.5 })
    expect(depositCaseFacts('overpaid: received 3000000000 nanoton, quoted 2000000000 (credited 10 USD only)')).toEqual({ issue: 'overpaid', txHash: null, receivedTon: 3 })
    expect(depositCaseFacts(`underpaid (database check) in tx ${'ab'.repeat(32)}`)).toMatchObject({ issue: 'underpaid', txHash: 'ab'.repeat(32), receivedTon: null })
    expect(depositCaseFacts('payment arrived outside the window')).toMatchObject({ issue: 'outside_window' })
    expect(depositCaseFacts('something odd')).toMatchObject({ issue: 'other', txHash: null })
  })

  it('TON -> nanoton exactly, refusing what is not a positive amount', () => {
    expect(tonToNano('4.1')).toBe(4_100_000_000)
    expect(tonToNano('0,000000001')).toBe(1)
    expect(tonToNano('2')).toBe(2_000_000_000)
    for (const bad of ['', '0', '-1', '1.2.3', 'abc', '1.0000000001']) expect(tonToNano(bad), bad).toBeNull()
  })

  it('a transaction hash is base64 / base64url / hex of 32 bytes', () => {
    expect(isTxHash(HASH)).toBe(true)
    expect(isTxHash('ab'.repeat(32))).toBe(true)
    expect(isTxHash('TX-1')).toBe(false)
  })

  it('the server refusals become Russian sentences; anything else is kept', () => {
    expect(adminActionError('transaction already credited to another deposit')).toMatch(/другой депозит/)
    expect(adminActionError('a note is required to dismiss a deposit case')).toMatch(/причину/)
    expect(adminActionError('you cannot ban or unban yourself')).toMatch(/самого себя/)
    expect(adminActionError('weird')).toBe('weird')
  })
})

describe('admin client: resolveDeposit / findUsers / setUserBan', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
  const call = (i: number) => ({ url: fetchMock.mock.calls[i][0] as string, auth: fetchMock.mock.calls[i][1].headers.Authorization, body: JSON.parse(fetchMock.mock.calls[i][1].body) })

  it('credit sends the transaction, the nanoton and the note to admin_resolve_deposit with the admin JWT', async () => {
    reply(200, { deposit_id: 'd1', status: 'completed', credited: 22.5, action: 'credit' })
    const { resolveDeposit } = await import('../src/services/api/admin')
    const r = await resolveDeposit(session(), 'd1', { action: 'credit', txHash: ` ${HASH} `, receivedNano: 4_500_000_000, note: ' checked ' })
    expect(r).toEqual({ depositId: 'd1', status: 'completed', credited: 22.5, action: 'credit', replayed: false })
    expect(call(0)).toEqual({
      url: 'https://proj.supabase.co/rest/v1/rpc/admin_resolve_deposit', auth: 'Bearer jwt',
      body: { p_deposit_id: 'd1', p_action: 'credit', p_tx_hash: HASH, p_received_nano: 4_500_000_000, p_note: 'checked' },
    })
  })

  it('dismiss sends the note only; a refusal comes back as a readable error', async () => {
    reply(200, { deposit_id: 'd1', status: 'pending', credited: 0, action: 'dismiss' })
    reply(400, { code: '22023', message: 'invalid_parameter_value: a note is required to dismiss a deposit case' })
    const { resolveDeposit } = await import('../src/services/api/admin')
    await resolveDeposit(session(), 'd1', { action: 'dismiss', note: 'returned by hand' })
    expect(call(0).body).toEqual({ p_deposit_id: 'd1', p_action: 'dismiss', p_tx_hash: null, p_received_nano: null, p_note: 'returned by hand' })
    const e = (await resolveDeposit(session(), 'd1', { action: 'dismiss', note: ' ' }).catch((x) => x)) as { code: string; message: string }
    expect(e.code).toBe('invalid_input')
    expect(adminActionError(e.message)).toMatch(/причину/)
  })

  it('findUsers maps the rows; setUserBan sends the user, the flag and the reason', async () => {
    reply(200, [{ id: 'u1', telegram_id: 910001, username: 'alice', first_name: 'Alice', is_banned: false, is_admin: false, created_at: 't', balance: '12.5', orders: 3, is_you: false }])
    reply(200, { user_id: 'u1', is_banned: true })
    const { findUsers, setUserBan } = await import('../src/services/api/admin')
    expect(await findUsers(session(), ' @alice ')).toEqual([{ id: 'u1', telegramId: 910001, email: null, username: 'alice', firstName: 'Alice', isBanned: false, isAdmin: false, createdAt: 't', balance: 12.5, orders: 3, isYou: false }])
    expect(call(0).body).toEqual({ p_query: '@alice' })
    expect(await setUserBan(session(), 'u1', true, ' fraud ')).toEqual({ userId: 'u1', isBanned: true })
    expect(call(1)).toMatchObject({ url: 'https://proj.supabase.co/rest/v1/rpc/admin_set_user_ban', body: { p_user_id: 'u1', p_is_banned: true, p_reason: 'fraud' } })
  })
})

describe('dev mock follows the server rules', () => {
  it('deposit cases: credit pro rata, dismiss needs a note, a decided case leaves the queue', () => {
    const m = createMockAdmin(memoryStorage())
    const deposits = m.getCases().filter((c) => c.entityType === 'deposit')
    expect(deposits).toHaveLength(2)
    expect(deposits[0].deposit).toMatchObject({ amountUsd: 25, amountCrypto: 5, username: 'alice_demo' })
    expect(() => m.resolveDeposit('dep-002', { action: 'dismiss', note: ' ' })).toThrow(/note is required/)
    expect(m.resolveDeposit('dep-001', { action: 'credit', txHash: HASH, receivedNano: 4_500_000_000 })).toMatchObject({ credited: 22.5, action: 'credit' })
    expect(m.resolveDeposit('dep-002', { action: 'dismiss', note: 'returned the extra 1 TON' })).toMatchObject({ credited: 0 })
    expect(m.getCases().some((c) => c.entityType === 'deposit')).toBe(false)
  })

  it('users: search by @name / Telegram id; ban and unban', () => {
    const m = createMockAdmin(memoryStorage())
    expect(m.findUsers('@ali').map((u) => u.username)).toEqual(['alice_demo'])
    expect(m.findUsers('910002').map((u) => u.username)).toEqual(['bob_demo'])
    expect(() => m.findUsers('a')).toThrow()
    m.setUserBan('demo-user-910001', true)
    expect(m.findUsers('alice')[0].isBanned).toBe(true)
    expect(m.getCases().find((c) => c.order?.username === 'alice_demo')?.order?.userBanned).toBe(true)
  })
})

describe('SQL: admin_find_users and the deposit block of list_reconciliation_cases', () => {
  let db: PGlite
  let admin: string, alice: string, other: string
  const asUser = (id: string | null) => db.query(`select set_config('request.jwt.sub', $1, false)`, [id ?? ''])
  const find = async (q: string) => (await db.query<{ r: Record<string, unknown>[] }>(`select admin_find_users($1) r`, [q])).rows[0].r

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin = (await db.query<{ id: string }>(`insert into users(telegram_id, username, is_admin) values (1, 'boss', true) returning id`)).rows[0].id
    alice = (await db.query<{ id: string }>(`insert into users(telegram_id, username) values (910001, 'alice_x') returning id`)).rows[0].id
    other = (await db.query<{ id: string }>(`insert into users(telegram_id, username) values (910002, 'alicexy') returning id`)).rows[0].id
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('is a client RPC for admins only (authenticated may call it, anon may not; require_admin inside)', async () => {
    const g = (await db.query<{ a: boolean; u: boolean }>(`select has_function_privilege('anon', 'admin_find_users(text)', 'execute') a, has_function_privilege('authenticated', 'admin_find_users(text)', 'execute') u`)).rows[0]
    expect([g.a, g.u]).toEqual([false, true])
    await asUser(alice)
    await expect(find('alice')).rejects.toThrow()
    await asUser(null)
  })

  it('finds by Telegram id, user id and the start of a username; LIKE wildcards are literal', async () => {
    await asUser(admin)
    expect((await find('910001')).map((u) => u.username)).toEqual(['alice_x'])
    expect((await find(alice)).map((u) => u.username)).toEqual(['alice_x'])
    expect((await find('@alice')).map((u) => u.username).sort()).toEqual(['alice_x', 'alicexy'])
    expect((await find('alice_')).map((u) => u.username)).toEqual(['alice_x']) // "_" is not "any character"
    expect((await find('%'.repeat(3)))).toEqual([])
    expect((await find('boss'))[0]).toMatchObject({ is_you: true, is_admin: true })
    await expect(find('a')).rejects.toThrow(/2 to 64 characters/)
    await asUser(null)
  })

  it('a deposit case carries the deposit and its customer; banning from it is admin_set_user_ban', async () => {
    const dep = (await db.query<{ id: string }>(
      `insert into deposits (user_id, amount_usd, amount_crypto, rate_usd, memo, recipient_address, valid_until)
       values ($1, 25, 5, 5, $2, 'UQr', now() + interval '30 minutes') returning id`, [alice, `dep_${'a'.repeat(32)}`])).rows[0].id
    await db.query(`insert into reconciliation_cases (entity_type, entity_id, reason) values ('deposit', $1, $2)`, [dep, `underpaid: received 4.5 TON of 5 in tx ${HASH}`])
    const cases = (await db.query<{ r: Record<string, unknown>[] }>(`select list_reconciliation_cases() r`)).rows[0].r
    const c = cases.find((x) => x.entity_type === 'deposit')!
    expect(c.deposit).toMatchObject({ status: 'pending', amount_usd: 25, amount_crypto: 5, username: 'alice_x', telegram_id: 910001, user_id: alice, user_banned: false })
    expect(c.order).toBeNull()

    await asUser(admin)
    await db.query(`select admin_set_user_ban($1, true, 'fraud')`, [alice])
    await db.query(`select admin_resolve_deposit($1::uuid, 'credit', $2, 4500000000, 'checked')`, [dep, HASH])
    await asUser(null)
    const after = (await db.query<{ r: Record<string, unknown>[] }>(`select list_reconciliation_cases() r`)).rows[0].r
    expect(after.some((x) => x.entity_type === 'deposit')).toBe(false) // credited: the case is closed
    expect((await db.query<{ b: string }>(`select balance::text b from wallets where user_id = $1`, [alice])).rows[0].b).toBe('22.5000')
    expect((await db.query(`select 1 from admin_audit_log where action = 'ban_user' and target_id = $1 and details->>'reason' = 'fraud'`, [alice])).rows).toHaveLength(1)
    expect(other).toBeTruthy()
  })
})

describe('DepositCaseCard', () => {
  let root: Root
  let host: HTMLElement
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

  const kase: ReconCase = {
    id: 'case-1', entityType: 'deposit', entityId: 'dep-1', reason: `underpaid: received 4.5 TON of 5 in tx ${HASH}`, createdAt: new Date().toISOString(),
    order: null, payment: null,
    deposit: { status: 'pending', amountUsd: 25, amountCrypto: 5, asset: 'TON', network: 'mainnet', memo: null, txHash: null, receivedNano: null, validUntil: null,
      createdAt: new Date().toISOString(), username: 'alice', telegramId: 910001, userId: 'u-alice', userBanned: false },
  }
  const click = (text: string) => act(() => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!.click())

  it('credit is prefilled from the case, shows the pro-rata amount and calls resolveDeposit', async () => {
    const api = await import('../src/services/api/admin')
    const spy = vi.spyOn(api, 'resolveDeposit').mockResolvedValue({ depositId: 'dep-1', status: 'completed', credited: 22.5, action: 'credit', replayed: false })
    const { DepositCaseCard } = await import('../src/components/admin/DepositCaseCard')
    const done: string[] = []
    act(() => root.render(createElement(DepositCaseCard, { kase, session: session(), severityBorder: '', severityBadge: { label: 'Важно', className: '' }, onDone: (m: string) => done.push(m) })))
    expect(host.textContent).toContain('Недоплата')
    click('Зачесть на баланс')
    const inputs = host.querySelectorAll('input')
    expect((inputs[0] as HTMLInputElement).value).toBe(HASH)
    expect((inputs[1] as HTMLInputElement).value).toBe('4.5')
    expect(host.textContent).toContain('Клиенту будет зачислено $22.50 (пропорционально полученному)')
    await act(async () => { click('Зачислить') })
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'dep-1', { action: 'credit', txHash: HASH, receivedNano: 4_500_000_000, note: undefined })
    expect(done).toEqual(['Зачислено клиенту: $22.50.'])
  })

  it('dismiss needs a reason; ban needs a reason too', async () => {
    const api = await import('../src/services/api/admin')
    const resolve = vi.spyOn(api, 'resolveDeposit').mockResolvedValue({ depositId: 'dep-1', status: 'pending', credited: 0, action: 'dismiss', replayed: false })
    const ban = vi.spyOn(api, 'setUserBan').mockResolvedValue({ userId: 'u-alice', isBanned: true })
    const { DepositCaseCard } = await import('../src/components/admin/DepositCaseCard')
    act(() => root.render(createElement(DepositCaseCard, { kase, session: session(), severityBorder: '', severityBadge: { label: 'Важно', className: '' }, onDone: () => {} })))
    click('Закрыть кейс')
    const submit = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Закрыть кейс')!
    expect(submit.disabled).toBe(true)
    const type = (input: HTMLInputElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    type(host.querySelector('input')!, 'returned by hand')
    await act(async () => { submit.click() })
    expect(resolve).toHaveBeenCalledWith(expect.anything(), 'dep-1', { action: 'dismiss', note: 'returned by hand' })

    click('Заблокировать @alice')
    const confirm = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Заблокировать')!
    expect(confirm.disabled).toBe(true) // a reason is required
    const reason = [...host.querySelectorAll('input')].at(-1)!
    type(reason, 'fraud')
    await act(async () => { confirm.click() })
    expect(ban).toHaveBeenCalledWith(expect.anything(), 'u-alice', true, 'fraud')
    expect(host.textContent).toContain('Разблокировать @alice')
  })
})
