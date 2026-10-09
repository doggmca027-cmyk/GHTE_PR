import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { eventFor, isReady, runOutbox, type OutboxRow, type RunDeps } from '../supabase/functions/_shared/notification-outbox'
import { buildMessage } from '../supabase/functions/_shared/telegram-notify'
import { signupGate } from '../supabase/functions/_shared/signup-gate'
import { mapReferralError } from '../supabase/functions/_shared/referrals'

const ROOT = path.resolve(__dirname, '..')
const TOKEN = '123456:TEST-TOKEN'

describe('admin alerts and the quarantine vectors, in the database', () => {
  let db: PGlite
  let admin1: string, admin2: string, bannedAdmin: string, customer: string
  let svc: string, offer: { id: string; provider_id: string; provider_service_id: string }
  let n = 0

  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, any>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  const call = async (sql: string, p: unknown[] = []) => (await db.query<{ r: any }>(`select ${sql} r`, p)).rows[0].r
  const sweep = () => call(`notify_admin_anomalies()`)
  const alerts = () => rows(`select user_id, dedupe_key, payload, status::text status from notification_outbox where kind = 'admin_alert' order by created_at, dedupe_key`)
  const clearAlerts = async () => { await db.exec(`delete from notification_outbox where kind = 'admin_alert'; delete from reconciliation_case_alerts; delete from reconciliation_cases;`) }

  const newUser = async (opts: { admin?: boolean; banned?: boolean; funds?: number } = {}) => {
    const id = await one<string>(`insert into users(telegram_id, is_admin, is_banned, language_code) values ($1, $2, $3, 'en') returning id v`, [7000 + ++n, !!opts.admin, !!opts.banned])
    if (opts.funds) await db.query(`select process_wallet_transaction($1::uuid, 'deposit', $2::numeric, null, 'fund', $3)`, [id, opts.funds, `fund-${id}`])
    return id
  }
  const caseAged = async (age: string, reason = 'order stuck at provider', entity = `ord-${++n}`) =>
    one<string>(`insert into reconciliation_cases(entity_type, entity_id, reason, created_at) values ('order', $1, $2, now() - $3::interval) returning id v`, [entity, reason, age])
  const placeOrder = async (u: string) =>
    one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, $6)`, [u, svc, offer.id, offer.provider_id, offer.provider_service_id, `k-${++n}`])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin1 = await newUser({ admin: true })
    admin2 = await newUser({ admin: true })
    bannedAdmin = await newUser({ admin: true, banned: true })
    customer = await newUser({ funds: 500 })
    const provider = await one<string>(`insert into providers(name, api_url) values ('Panel', 'https://p.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'Views', 2, 1, 1000000) returning id v`, [provider])
    svc = await one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'Views', $2, 4, 1, 1000000) returning id v`, [cat, ps])
    const o = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [svc]))[0]
    offer = { id: o.id, provider_id: o.provider_id, provider_service_id: o.provider_service_id }
  }, 180_000)

  describe('notify_admin_anomalies: reconciliation cases', () => {
    it('a case younger than 15 minutes is not worth a message yet', async () => {
      await clearAlerts()
      await caseAged('14 minutes')
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 0 })
      expect(await alerts()).toHaveLength(0)
    })

    it('a stale case produces one message per ACTIVE admin (not the banned admin, not customers) with the age and the reason', async () => {
      await clearAlerts()
      await caseAged('20 minutes', 'timeout: add: no response within 10000ms')
      expect(await sweep()).toEqual({ cases_announced: 1, dead_announced: 0 })
      const a = await alerts()
      expect(a.map((r) => r.user_id).sort()).toEqual([admin1, admin2].sort())
      expect(a.every((r) => r.status === 'pending')).toBe(true)
      expect(a[0].payload.headline).toBe('1 reconciliation case(s) need attention')
      expect(a[0].payload.detail).toContain('20 min')
      expect(a[0].payload.detail).toContain('timeout: add: no response within 10000ms')
      expect(a.map((r) => r.user_id)).not.toContain(bannedAdmin)
      expect(a.map((r) => r.user_id)).not.toContain(customer)
    })

    it('running it again finds nothing new: the same case does not produce a second message', async () => {
      const before = (await alerts()).length
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 0 })
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 0 })
      expect(await alerts()).toHaveLength(before)
    })

    it('several cases in one sweep are ONE digest per admin, not a flood', async () => {
      await clearAlerts()
      for (let i = 0; i < 5; i++) await caseAged(`${20 + i} minutes`, `reason ${i}`)
      expect(await sweep()).toMatchObject({ cases_announced: 5 })
      const a = await alerts()
      expect(a).toHaveLength(2)
      expect(a[0].payload.headline).toBe('5 reconciliation case(s) need attention')
    })

    it('a case that stays open is announced again at 2 hours and at 24 hours, and only then', async () => {
      await clearAlerts()
      const id = await caseAged('20 minutes')
      expect((await sweep()).cases_announced).toBe(1)
      expect((await sweep()).cases_announced).toBe(0)
      await db.query(`update reconciliation_cases set created_at = now() - interval '3 hours' where id = $1`, [id])
      expect((await sweep()).cases_announced).toBe(1)
      expect((await sweep()).cases_announced).toBe(0)
      await db.query(`update reconciliation_cases set created_at = now() - interval '25 hours' where id = $1`, [id])
      expect((await sweep()).cases_announced).toBe(1)
      expect((await sweep()).cases_announced).toBe(0)
      expect(await rows(`select step from reconciliation_case_alerts where case_id = $1 order by step`, [id])).toEqual([{ step: '15m' }, { step: '24h' }, { step: '2h' }])
      expect(await alerts()).toHaveLength(6) // three announcements x two admins
    })

    it('a resolved case is never announced', async () => {
      await clearAlerts()
      const id = await caseAged('2 hours')
      await db.query(`update reconciliation_cases set status = 'resolved', resolution = 'manual', resolved_at = now() where id = $1`, [id])
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 0 })
    })

    it('no active admin: the cases are still recorded as announced, no message is invented, nothing crashes', async () => {
      await clearAlerts()
      await db.exec(`update users set is_admin = false where id in ('${admin1}', '${admin2}')`)
      await caseAged('30 minutes')
      await expect(sweep()).resolves.toMatchObject({ cases_announced: 1 })
      expect(await alerts()).toHaveLength(0)
      await db.exec(`update users set is_admin = true where id in ('${admin1}', '${admin2}')`)
    })
  })

  describe('notify_admin_anomalies: notifications that died', () => {
    const dead = async (kind: 'completed' | 'canceled' = 'completed') => {
      const o = await placeOrder(customer)
      return one<string>(`insert into notification_outbox(order_id, user_id, kind, dedupe_key, status, attempts, finished_at) values ($1, $2, $3, $4, 'dead', 8, now()) returning id v`, [o, customer, kind, `dead:${++n}:${o}`])
    }

    it('dead messages are announced once, as one digest per admin', async () => {
      await clearAlerts()
      await db.exec(`delete from notification_outbox`)
      await dead(); await dead(); await dead('canceled')
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 3 })
      const a = await alerts()
      expect(a).toHaveLength(2)
      expect(a[0].payload.headline).toBe('3 notification(s) could not be delivered')
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 0 })
      expect(await alerts()).toHaveLength(2)
    })

    it('no alert about alerts: an alert row that dies itself is not reported again', async () => {
      await clearAlerts()
      await db.exec(`update notification_outbox set alerted_at = now() where status = 'dead'`)
      await caseAged('20 minutes')
      await sweep()
      await db.exec(`update notification_outbox set status = 'dead', finished_at = now() where kind = 'admin_alert'`)
      expect(await sweep()).toEqual({ cases_announced: 0, dead_announced: 0 })
      expect((await alerts()).length).toBe(2)
    })
  })

  describe('the outbox keeps its shape', () => {
    it('an alert needs a payload and no order; an order notification needs an order and no payload', async () => {
      const o = await placeOrder(customer)
      const insert = (sql: string, p: unknown[]) => db.query(sql, p)
      await expect(insert(`insert into notification_outbox(user_id, kind, dedupe_key) values ($1, 'admin_alert', 'bad-1')`, [admin1])).rejects.toThrow(/notification_outbox_shape/)
      await expect(insert(`insert into notification_outbox(user_id, kind, dedupe_key, payload, order_id) values ($1, 'admin_alert', 'bad-2', '{}'::jsonb, $2)`, [admin1, o])).rejects.toThrow(/notification_outbox_shape/)
      await expect(insert(`insert into notification_outbox(user_id, kind, dedupe_key) values ($1, 'completed', 'bad-3')`, [customer])).rejects.toThrow(/notification_outbox_shape/)
      await expect(insert(`insert into notification_outbox(user_id, kind, dedupe_key, order_id, payload) values ($1, 'completed', 'bad-4', $2, '{}'::jsonb)`, [customer, o])).rejects.toThrow(/notification_outbox_shape/)
      await expect(insert(`insert into notification_outbox(user_id, kind, dedupe_key, payload) values ($1, 'mystery', 'bad-5', '{}'::jsonb)`, [admin1])).rejects.toThrow()
    })

    it('alerts and customer notifications share the claim function: an alert comes out with its payload and the admin\'s chat', async () => {
      await clearAlerts()
      await db.exec(`update notification_outbox set next_attempt_at = now() + interval '1 day' where kind <> 'admin_alert'`)
      await caseAged('20 minutes')
      await sweep()
      const batch = (await call(`claim_notification_batch(50)`)) as any[]
      const mine = batch.filter((b) => b.kind === 'admin_alert')
      expect(mine).toHaveLength(2)
      expect(mine[0]).toMatchObject({ order_id: null, order_status: null, service_name: null, notifications_enabled: true })
      expect(mine[0].payload.headline).toContain('reconciliation case')
      expect(String(mine[0].telegram_id)).toMatch(/^7\d{3}$/)
    })
  })

  describe('the notifier delivers an alert end to end', () => {
    it('sent to every active admin, once, with the alert text; a repeat run sends nothing', async () => {
      await clearAlerts()
      await db.exec(`update notification_outbox set next_attempt_at = now() + interval '1 day' where kind <> 'admin_alert'`)
      await caseAged('45 minutes', 'orders waiting')
      await sweep()

      const told = new Set<string>()
      const sent: Array<{ chatId: number; text: string }> = []
      const deps: RunDeps = {
        claimBatch: async (limit) => ((await call(`claim_notification_batch($1)`, [limit])) as OutboxRow[]).filter((r) => r.kind === 'admin_alert'),
        complete: async (id, c) => void (await db.query(`select complete_notification($1::uuid, $2, $3::int, $4)`, [id, c.outcome, 'retryAfterSeconds' in c ? c.retryAfterSeconds ?? null : null, 'error' in c ? c.error : null])),
        dedupe: { claim: async (k) => (told.has(k) ? false : (told.add(k), true)), release: async (k) => void told.delete(k) },
        botToken: TOKEN,
        send: async (o) => { sent.push({ chatId: Number(o.chatId), text: o.text }); return { ok: true } },
        sleep: async () => {},
        log: { info: () => {}, warn: () => {} },
      }
      expect(await runOutbox(deps)).toMatchObject({ claimed: 2, sent: 2, errors: 0 })
      expect(sent).toHaveLength(2)
      expect(sent[0].text).toContain('🚨')
      expect(sent[0].text).toContain('1 reconciliation case(s) need attention')
      expect(sent[0].text).toContain('orders waiting')
      expect(await rows(`select status::text s from notification_outbox where kind = 'admin_alert'`)).toEqual([{ s: 'sent' }, { s: 'sent' }])
      expect(await runOutbox(deps)).toMatchObject({ claimed: 0, sent: 0 })
      expect(sent).toHaveLength(2)
    })

    it('an admin who muted the bot or blocked it is skipped, not retried forever', async () => {
      await clearAlerts()
      await db.exec(`update notification_outbox set next_attempt_at = now() + interval '1 day' where kind <> 'admin_alert'`)
      await db.query(`update users set notifications_enabled = false where id = $1`, [admin2])
      await caseAged('45 minutes')
      await sweep()
      const sent: number[] = []
      const deps: RunDeps = {
        claimBatch: async (limit) => ((await call(`claim_notification_batch($1)`, [limit])) as OutboxRow[]).filter((r) => r.kind === 'admin_alert'),
        complete: async (id, c) => void (await db.query(`select complete_notification($1::uuid, $2, $3::int, $4)`, [id, c.outcome, 'retryAfterSeconds' in c ? c.retryAfterSeconds ?? null : null, 'error' in c ? c.error : null])),
        dedupe: { claim: async () => true, release: async () => {} },
        botToken: TOKEN,
        send: async (o) => { sent.push(Number(o.chatId)); return { ok: true } },
        sleep: async () => {},
        log: { info: () => {}, warn: () => {} },
      }
      expect(await runOutbox(deps)).toMatchObject({ claimed: 2, sent: 1, skipped: 1 })
      await db.query(`update users set notifications_enabled = true where id = $1`, [admin2])
    })
  })

  describe('the Telegram side of an alert (pure)', () => {
    const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
      id: 'r', kind: 'admin_alert', dedupe_key: 'alert:1', attempts: 1, order_id: null, order_status: null, quantity: null, remains: null,
      charge_amount: null, partial_refund_amount: null, payload: { headline: 'H', detail: 'D' }, service_name: null, user_id: 'u', telegram_id: 1,
      language_code: 'en', notifications_enabled: true, bot_blocked_recently: false, ...over,
    })

    it('eventFor builds an admin_alert from the payload, clipped and defaulted', () => {
      expect(eventFor(row())).toEqual({ type: 'admin_alert', headline: 'H', detail: 'D' })
      expect(eventFor(row({ payload: null }))).toEqual({ type: 'admin_alert', headline: 'Alert', detail: '' })
      const long = eventFor(row({ payload: { headline: 'x'.repeat(500), detail: 'y'.repeat(5000) } })) as { headline: string; detail: string }
      expect([long.headline.length, long.detail.length]).toEqual([120, 600])
    })

    it('an alert is always ready (it does not wait for an order)', () => {
      expect(isReady(row())).toBe(true)
    })

    it('English and Ukrainian templates exist and escape the text (an alert can carry a provider\'s error message)', () => {
      for (const lang of ['en', 'uk'] as const) {
        const text = buildMessage({ type: 'admin_alert', headline: 'A <b>bad</b> & "case"', detail: '<script>x</script>' }, lang)
        expect(text).toContain('🚨')
        expect(text).not.toContain('<script>')
        expect(text).toContain('&lt;script&gt;')
        expect(text).toContain('&amp;')
      }
    })
  })

  describe('quarantine now stops the newer vectors too', () => {
    const quarantine = () => db.exec(fs.readFileSync(path.join(ROOT, 'supabase/scripts/emergency_quarantine.sql'), 'utf8'))
    const lift = () => db.exec((fs.readFileSync(path.join(ROOT, 'docs/RUNBOOK.md'), 'utf8').match(/-- runbook-test: lift-quarantine\n([\s\S]*?)```/) ?? [])[1])
    const flags = async () => (await rows(`select global_tickets_enabled t, global_referral_transfers_enabled r, global_signups_enabled s from platform_settings where id = 1`))[0]
    const ticket = (u: string, key = 'help') => call(`support_create_ticket($1::uuid, $2, 'something is wrong with my order', null)`, [u, key])

    async function earnedReferrer(amount = 1) {
      const referrer = await newUser()
      const buyer = await newUser({ funds: 100 })
      const o = await placeOrder(buyer)
      await db.query(`insert into referral_ledger(user_id, referred_user_id, order_id, transaction_type, amount, base_amount, percentage, available_at, idempotency_key)
                      values ($1, $2, $3, 'reward', $4, 4, 5, now() - interval '1 day', $5)`, [referrer, buyer, o, amount, `reward:${o}`])
      return referrer
    }

    it('everything is on by default', async () => {
      expect(await flags()).toEqual({ t: true, r: true, s: true })
    })

    it('the script switches tickets, referral transfers and sign-ups off; lifting it puts them back', async () => {
      await quarantine()
      expect(await flags()).toEqual({ t: false, r: false, s: false })
      await lift()
      expect(await flags()).toEqual({ t: true, r: true, s: true })
    })

    it('a restore point written before these switches existed lifts to ON, not NULL (which would be a not-null violation)', async () => {
      // the audit log is append-only, so the old-format point is added as the newest one (the lift block takes the latest)
      await db.exec(`insert into admin_audit_log(admin_id, action, target_id, details) values (null, 'emergency_quarantine', 'platform_settings',
        '{"previous": {"global_orders_enabled": true, "global_payments_enabled": true, "maintenance_mode": false, "minimum_treasury_reserve": 25}}'::jsonb)`)
      await db.exec(`update platform_settings set global_tickets_enabled = false, global_referral_transfers_enabled = false, global_signups_enabled = false where id = 1`)
      await lift()
      expect(await flags()).toEqual({ t: true, r: true, s: true })
    })

    it('while quarantined a NEW ticket is refused with feature_paused, and works again afterwards', async () => {
      await quarantine()
      await expect(ticket(customer)).rejects.toThrow(/feature_paused/)
      expect(await rows(`select 1 from support_tickets where user_id = $1`, [customer])).toHaveLength(0)
      await lift()
      expect(await ticket(customer)).toBeTruthy()
    })

    it('replying on a ticket that already exists is not blocked (customers can still talk to support during an incident)', async () => {
      const t = await ticket(customer, 'before')
      const id = t.id ?? t.ticket?.id
      expect(id).toBeTruthy()
      await quarantine()
      await expect(call(`support_add_message($1::uuid, $2::uuid, 'still here')`, [customer, id])).resolves.toBeTruthy()
      await lift()
    })

    it('while quarantined affiliate earnings cannot be moved to a wallet; afterwards they can, once', async () => {
      const ref = await earnedReferrer(1)
      await quarantine()
      await expect(call(`transfer_affiliate_balance_to_wallet($1::uuid, null, 'q-key-0001')`, [ref])).rejects.toThrow(/feature_paused/)
      expect(await one(`select balance::text v from wallets where user_id = $1`, [ref])).toBe('0.0000')
      await lift()
      expect(await call(`transfer_affiliate_balance_to_wallet($1::uuid, null, 'q-key-0001')`, [ref])).toMatchObject({ transferred: 1, replayed: false })
    })

    it('a transfer that already happened is still answered while quarantined (a client retry gets its answer, nothing moves twice)', async () => {
      const ref = await earnedReferrer(2)
      await call(`transfer_affiliate_balance_to_wallet($1::uuid, null, 'q-key-0002')`, [ref])
      await quarantine()
      expect(await call(`transfer_affiliate_balance_to_wallet($1::uuid, null, 'q-key-0002')`, [ref])).toMatchObject({ transferred: 2, replayed: true })
      expect(await one(`select balance::text v from wallets where user_id = $1`, [ref])).toBe('2.0000')
      await lift()
    })
  })

  describe('the application side of the switches (pure)', () => {
    it('signupGate: existing customers always get in; newcomers only when the switch is explicitly on (fail closed)', () => {
      expect(signupGate(true, false)).toBe('allow')
      expect(signupGate(true, null)).toBe('allow')
      expect(signupGate(false, true)).toBe('allow')
      expect(signupGate(false, false)).toBe('paused')
      expect(signupGate(false, null)).toBe('paused')
      expect(signupGate(false, undefined)).toBe('paused')
    })

    it('feature_paused from the database becomes a 503 for tickets and transfers', () => {
      expect(mapReferralError('feature_paused: affiliate transfers are temporarily switched off')).toMatchObject({ status: 503, error: 'feature_paused' })
    })

    it('telegram-auth answers 403 signups_paused only for newcomers, and the app maps it to its own error (source check)', () => {
      const fn = fs.readFileSync(path.join(ROOT, 'supabase/functions/telegram-auth/index.ts'), 'utf8')
      expect(fn).toContain("signupGate(false, gate?.global_signups_enabled)")
      expect(fn).toContain("error: 'signups_paused'")
      expect(fs.readFileSync(path.join(ROOT, 'src/services/api/auth.ts'), 'utf8')).toContain("code === 'signups_paused'")
      expect(fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/tickets.ts'), 'utf8')).toContain('feature_paused')
    })
  })
})
