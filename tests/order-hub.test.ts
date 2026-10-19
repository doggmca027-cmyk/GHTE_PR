// The order hub (migration 20261218000000): an order its provider cannot pay for waits instead of failing, the admins are told on Telegram
// which provider to top up and by how much (with buttons), the waiting orders go out by themselves after the top-up, and a panel that says
// "not enough funds" puts the order back in the hub instead of refunding it. Real SQL on PGlite, the pure flow and messages, the bot buttons.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProviderHub, type FundedOrder } from '../supabase/functions/_shared/funded-orders.ts'
import { hubMessage, hubRunReply, parseHubCallback, usd } from '../supabase/functions/_shared/order-hub.ts'
import { submitClaimedOrder, type OrderRecord, type PlaceOrderPorts } from '../supabase/functions/_shared/place-order-flow.ts'
import { deliver, type OutboxRow } from '../supabase/functions/_shared/notification-outbox.ts'
import { SMMProviderError } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import { handleBotUpdate, type BotPorts } from '../supabase/functions/_shared/telegram-bot.ts'

const quiet = { warn() {}, error() {}, info() {} }
const A = '00000000-0000-0000-0000-0000000000a2'
const B = '00000000-0000-0000-0000-0000000000b2'
const PS_A = '00000000-0000-0000-0000-000000000a01'
const PS_B = '00000000-0000-0000-0000-000000000b01'
const OFFER_A = '00000000-0000-0000-0000-00000000aa01'
const OFFER_B = '00000000-0000-0000-0000-00000000bb01'
const SVC = '00000000-0000-0000-0000-0000000000f1'
const CAT = '00000000-0000-0000-0000-0000000000c1'

async function world() {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;`)
  const dir = path.resolve(__dirname, '../supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  // JAP sells at 1.00 per 1000 (the cheapest), the primary at 2.00; the customer pays 4.00 per 1000: 10,000 cost 10.00 at JAP, 40.00 for the customer
  await db.exec(`
    insert into providers(id, name, api_url, routing_enabled, health_status, is_active, provider_balance, last_balance_sync) values
      ('${A}', 'JAP', 'https://a', true, 'healthy', true, 3, now()),
      ('${B}', 'SMM Center', 'https://b', true, 'healthy', true, 0, now());
    insert into categories(id, platform_id, name, slug) values ('${CAT}', (select id from platforms where slug = 'telegram'), 'Views', 'views');
    insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
      ('${PS_A}', '${A}', '77', 'A views', 1.0, 100, 100000), ('${PS_B}', '${B}', '88', 'B views', 2.0, 100, 100000);
    insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
      values ('${SVC}', '${CAT}', 'Telegram Post Views', '${PS_B}', 4.0, 100, 100000);
    delete from provider_service_offers;
    insert into provider_service_offers(id, service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, routing_score) values
      ('${OFFER_A}', '${SVC}', '${A}', '${PS_A}', 1.0, 100, 100000, 0), ('${OFFER_B}', '${SVC}', '${B}', '${PS_B}', 2.0, 100, 100000, 0);`)
  return db
}

describe('the order hub (real SQL)', () => {
  let db: PGlite
  const q = async <T = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await q<{ v: T }>(sql, p))[0].v
  const user = async (tg: number, o: { admin?: boolean; funds?: number; username?: string } = {}) => {
    const id = await one<string>(`insert into users(telegram_id, is_admin, username) values ($1, $2, $3) returning id v`, [tg, o.admin ?? false, o.username ?? null])
    if ((o.funds ?? 1000) > 0) await db.query(`select process_wallet_transaction($1::uuid,'deposit',$2::numeric,null,'fund','fund-'||$1::text)`, [id, o.funds ?? 1000])
    return id
  }
  const place = (u: string, key: string) => db.query<Record<string, any>>(
    `select * from place_order($1::uuid, '${SVC}', 'https://t.me/x', 10000, '${OFFER_A}', '${A}', '${PS_A}', 10.0, $2::text, null, true)`, [u, key]).then((r) => r.rows[0])
  const hubRows = async (event: string) => q<{ user_id: string; payload: Record<string, any> }>(`select user_id, payload from notification_outbox where kind = 'admin_hub' and payload->>'event' = $1 order by created_at`, [event])
  let admin: string

  beforeEach(async () => {
    db = await world()
    admin = await user(500, { admin: true, funds: 0 })
    await user(501, { admin: true, funds: 0 }).then((id) => db.query(`update users set telegram_id = null, email = 'admin2@example.com', email_verified_at = now() where id = $1`, [id])) // an admin without Telegram is not written to
  }, 180_000)

  it('is on: an order JAP cannot pay for yet is charged and waits on JAP (the cheapest), never fails', async () => {
    const u = await user(1)
    const o = await place(u, 'k1')
    expect(o).toMatchObject({ status: 'paid', provider_id: A })
    expect(o.awaiting_funds_since).not.toBeNull()
    expect(o.hub_entered_at).not.toBeNull()
    expect(Number(await one<string>(`select balance::text v from wallets where user_id = $1`, [u]))).toBe(960)
  })

  it('the admins are told which provider to top up, by how much, for all its waiting orders; only admins on Telegram', async () => {
    const u = await user(1)
    await place(u, 'k1')
    await place(u, 'k2')
    const rows = await hubRows('waiting')
    expect(rows.map((r) => r.user_id)).toEqual([admin, admin])
    expect(rows[1].payload).toMatchObject({ provider: 'JAP', provider_id: A, service: 'Telegram Post Views', quantity: 10000, charge: 40, cost: 10, balance: 3, needed: 20, waiting: 2 })
    const text = hubMessage(rows[1].payload as never).text
    expect(text).toContain('🏢 Провайдер: <b>JAP</b>')
    expect(text).toContain('💵 Оплатил клиент: $40.00 | Закуп: $10.00 | Чистая прибыль: +$30.00')
    expect(text).toContain('🏦 Баланс JAP: $3.00 (Нужно пополнить минимум на: <b>$17.00</b> для всех ждущих заказов этого провайдера: 2 на $20.00)')
    expect(hubMessage(rows[1].payload as never).replyMarkup?.inline_keyboard.flat()).toEqual([
      { text: '🚀 Я пополнил — запустить очередь', callback_data: `hub_retry:${A}` },
      { text: '🔀 Отправить через другой оффер', callback_data: `hub_fallback:${rows[1].payload.order_id}` },
    ])
  })

  it('after the top-up the worker claims the waiting orders oldest first; each one sent is announced "from the hub"', async () => {
    const u = await user(1)
    const first = await place(u, 'k1')
    await place(u, 'k2')
    await db.query(`update providers set provider_balance = 15 where id = $1`, [A]) // enough for one of the two
    const claimed = (await q<{ r: FundedOrder[] }>(`select claim_funded_orders(10, array['${A}']::uuid[]) r`))[0].r
    expect(claimed.map((c) => c.id)).toEqual([first.id]) // FIFO; the second waits for more money
    await db.query(`update orders set status = 'submitted', provider_order_id = 'p-1', error_message = null where id = $1`, [first.id])
    const sent = await hubRows('sent')
    expect(sent[0].payload).toMatchObject({ provider: 'JAP', from_hub: true, charge: 40, cost: 10, balance: 5 })
    expect(hubMessage(sent[0].payload as never).text).toContain('отправлен в JAP</b> (из Хаба)')
  })

  it('an order sent at once is announced too, with the margin and what is left at the provider', async () => {
    await db.query(`update providers set provider_balance = 50 where id = $1`, [A])
    const u = await user(1)
    const o = await place(u, 'k1')
    expect(o.awaiting_funds_since).toBeNull()
    await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
    await db.query(`update orders set status = 'submitted', provider_order_id = 'p-2' where id = $1`, [o.id])
    const [sent] = await hubRows('sent')
    expect(sent.payload).toMatchObject({ from_hub: false })
    expect(hubMessage(sent.payload as never).text).toBe('✅ <b>Заказ #' + String(o.id).slice(0, 8) + ' отправлен в JAP</b>\n📦 Telegram Post Views × 10,000 | Клиент: $40.00 → Закуп: $10.00 (Маржа: +$30.00)\n🏦 Остаток на JAP: $40.00')
  })

  it('"not enough funds" at the panel: the claimed order goes back to the hub (no refund), and only through that function', async () => {
    await db.query(`update providers set provider_balance = 50 where id = $1`, [A])
    const u = await user(1)
    const o = await place(u, 'k1')
    await db.query(`update orders set status = 'processing' where id = $1`, [o.id])
    await expect(db.query(`update orders set status = 'paid' where id = $1`, [o.id])).rejects.toThrow(/illegal order status transition/)
    const back = (await q<{ r: Record<string, any> }>(`select return_order_to_hub($1, 'not enough funds') r`, [o.id]))[0].r
    expect(back).toMatchObject({ status: 'paid', provider_reservation: 0 })
    expect(back.awaiting_funds_since).not.toBeNull()
    expect(Number(await one<string>(`select provider_balance::text v from providers where id = $1`, [A]))).toBe(0)
    expect(Number(await one<string>(`select balance::text v from wallets where user_id = $1`, [u]))).toBe(960) // still charged, still the customer's order
  })

  it('🔀: a waiting order moves to another provider of the card that can pay now; never one that cannot', async () => {
    const u = await user(1)
    const o = await place(u, 'k1')
    expect((await q<{ r: Record<string, any> }>(`select hub_reroute_order($1) r`, [o.id]))[0].r).toEqual({ ok: false, reason: 'no_funded_provider' })
    await db.query(`update providers set provider_balance = 100 where id = $1`, [B])
    const r = (await q<{ r: Record<string, any> }>(`select hub_reroute_order($1) r`, [o.id]))[0].r
    expect(r).toMatchObject({ ok: true, provider_id: B, provider: 'SMM Center', cost: 20 })
    const moved = (await q(`select provider_id, provider_offer_id, cost_amount::float8 cost, profit_amount::float8 profit, charge_amount::float8 charge from orders where id = $1`, [o.id]))[0]
    expect(moved).toEqual({ provider_id: B, provider_offer_id: OFFER_B, cost: 20, profit: 20, charge: 40 })
    // and the guard still keeps the commercial terms of any other order
    await expect(db.query(`update orders set provider_offer_id = $2 where id = $1`, [o.id, OFFER_A])).rejects.toThrow(/immutable/)
  })

  it('a customer\'s top-up is announced to the admins', async () => {
    const u = await user(2, { username: 'anna' })
    const dep = await one<string>(`insert into deposits (user_id, amount_usd, amount_crypto, rate_usd, memo, recipient_address, valid_until)
      values ($1, 12.5, 2.5, 5, 'dep_${'a'.repeat(32)}', 'UQ', now() + interval '1 hour') returning id v`, [u])
    await db.query(`update deposits set status = 'completed', tx_hash = normalize_ton_tx_hash('${'b'.repeat(64)}'), completed_at = now() where id = $1`, [dep])
    const [row] = await hubRows('deposit')
    expect(hubMessage(row.payload as never).text).toBe('💰 <b>Пополнение баланса: +$12.50</b> (клиент @anna)')
  })
})

describe('the flow: "not enough funds" from the panel', () => {
  const order: OrderRecord = { id: 'o1', user_id: 'u', service_id: 's', target_url: 'https://t.me/x', quantity: 1000, charge_amount: 4, status: 'processing', provider_order_id: null, error_message: null }
  const ports = (hub: OrderRecord | null) => {
    const calls = { refund: 0, hub: 0 }
    const p = {
      placeOrder: vi.fn(), claim: vi.fn(), get: vi.fn(),
      update: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...order, ...patch })),
      refund: vi.fn(async () => { calls.refund++; return { ...order, status: 'refunded' } }),
      releaseReservation: vi.fn(async () => {}),
      returnToHub: vi.fn(async () => { calls.hub++; return hub }),
    } as unknown as PlaceOrderPorts
    return { p, calls }
  }
  const broke = { createOrder: async () => { throw new SMMProviderError('api', 'Not enough funds on balance', { code: 'insufficient_provider_balance' }) } }

  it('goes back to the hub, the customer is not refunded', async () => {
    const { p, calls } = ports({ ...order, status: 'paid', awaiting_funds_since: 'now' })
    const r = await submitClaimedOrder(order, '77', p, broke, quiet)
    expect(r.kind).toBe('awaiting_funds')
    expect(calls).toEqual({ refund: 0, hub: 1 })
  })

  it('with the hub off it is refunded as before; any other refusal is refunded as before', async () => {
    const off = ports(null)
    expect((await submitClaimedOrder(order, '77', off.p, broke, quiet)).kind).toBe('rejected')
    expect(off.calls.refund).toBe(1)
    const other = ports({ ...order })
    const badLink = { createOrder: async () => { throw new SMMProviderError('api', 'Invalid link', { code: 'invalid_link' }) } }
    expect((await submitClaimedOrder(order, '77', other.p, badLink, quiet)).kind).toBe('rejected')
    expect(other.calls.hub).toBe(0)
  })
})

describe('🚀 a provider\'s hub, now', () => {
  it('reads the real balance first, sends the waiting orders, says what is left', async () => {
    const saved: number[] = []
    const r = await runProviderHub({
      provider: { id: 'pa', name: 'JAP' },
      readBalance: async () => 25,
      saveBalance: async (b) => { saved.push(b) },
      funded: {
        expire: async () => { throw new Error('a hub run never refunds') },
        claim: async () => [{ id: 'o1', user_id: 'u', provider_id: 'pa', target_url: 'https://t.me/x', quantity: 1000, charge_amount: 4, external_service_id: '77' }],
        adapters: async () => new Map([['pa', { createOrder: async () => ({ orderId: 'p-1' }) }]]),
        orders: {
          get: async () => ({ id: 'o1', user_id: 'u', service_id: 's', target_url: 'https://t.me/x', quantity: 1000, charge_amount: 4, status: 'processing', provider_order_id: null, error_message: null }),
          update: async (_id: string, patch: Record<string, unknown>) => ({ id: 'o1', ...patch }),
        } as unknown as PlaceOrderPorts,
      },
      needed: async () => ({ count: 1, needed: 12.5 }),
    }, quiet)
    expect(saved).toEqual([25])
    expect(r).toMatchObject({ provider: 'JAP', balance: 25, submitted: 1, waiting: 1, needed: 12.5 })
    expect(hubRunReply(r)).toBe('🏦 <b>JAP</b>: баланс $25.00\n🚀 Отправлено в работу: <b>1</b>\n⏳ Ещё ждут: 1 на $12.50')
  })
})

describe('the admins\' messages and buttons', () => {
  const waiting = { event: 'waiting' as const, order_id: '11111111-2222-4333-8444-555555555555', provider_id: '99999999-2222-4333-8444-555555555555', provider: 'RootPanel', service: 'Roblox <Followers>', quantity: 500, charge: 1.2, cost: 0.4, balance: 0, needed: 3.75 }

  it('a waiting order carries the two buttons; a callback stays within Telegram\'s 64 bytes', () => {
    const m = hubMessage(waiting)
    expect(m.text).toContain('Roblox &lt;Followers&gt;') // escaped
    expect(m.replyMarkup?.inline_keyboard.map((row) => row[0].callback_data)).toEqual([`hub_retry:${waiting.provider_id}`, `hub_fallback:${waiting.order_id}`])
    for (const row of m.replyMarkup!.inline_keyboard) expect(new TextEncoder().encode(row[0].callback_data).length).toBeLessThanOrEqual(64)
    expect(parseHubCallback(`hub_retry:${waiting.provider_id}`)).toEqual({ action: 'retry', providerId: waiting.provider_id })
    expect(parseHubCallback('hub_fallback:not-a-uuid')).toBeNull()
    expect(usd(0.0054)).toBe('$0.0054')
  })

  it('the notifier sends it with the buttons', async () => {
    const sent: Record<string, unknown>[] = []
    const row = { id: 'n1', kind: 'admin_hub', dedupe_key: 'hub:waiting:x:a', attempts: 1, order_id: null, order_status: null, quantity: null, remains: null, charge_amount: null, partial_refund_amount: null, payload: waiting, service_name: null, user_id: 'a', telegram_id: 500, language_code: 'ru', notifications_enabled: true, bot_blocked_recently: false } as unknown as OutboxRow
    const r = await deliver(row, { botToken: 't', claimBatch: async () => [], complete: async () => {}, dedupe: { claim: async () => true, release: async () => {} }, send: async (o) => { sent.push(o as never); return { ok: true } }, log: quiet })
    expect(r.completion).toEqual({ outcome: 'sent' })
    expect(sent[0]).toMatchObject({ chatId: 500, replyMarkup: { inline_keyboard: [[{ callback_data: `hub_retry:${waiting.provider_id}` }], [{ callback_data: `hub_fallback:${waiting.order_id}` }]] } })
    expect(String(sent[0].text)).toContain('RootPanel')
  })

  it('in the bot: an admin\'s 🚀 runs the queue and the result is sent back; anyone else is refused', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const ports: BotPorts = {
      webAppUrl: null,
      telegram: async (method, body) => { calls.push([method, body]) },
      isAdmin: async (id) => id === 500,
      hubRetry: async (providerId) => `ran ${providerId}`,
      hubFallback: async (orderId) => `moved ${orderId}`,
    }
    const press = (from: number, data: string) => handleBotUpdate({ callback_query: { id: 'cb', from: { id: from }, data, message: { chat: { id: from }, message_id: 7 } } }, ports)
    expect(await press(500, `hub_retry:${waiting.provider_id}`)).toBe('hub')
    expect(calls.at(-1)).toEqual(['sendMessage', { chat_id: 500, text: `ran ${waiting.provider_id}`, parse_mode: 'HTML' }])
    expect(await press(500, `hub_fallback:${waiting.order_id}`)).toBe('hub')
    expect(calls.at(-1)?.[1]).toMatchObject({ text: `moved ${waiting.order_id}` })
    calls.length = 0
    expect(await press(777, `hub_retry:${waiting.provider_id}`)).toBe('ignored')
    expect(calls).toEqual([['answerCallbackQuery', { callback_query_id: 'cb', text: 'Только для администратора.', show_alert: true }]])
  })
})
