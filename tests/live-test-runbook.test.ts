import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { assertReadOnly } from '../scripts/lib/live-smoke'

// docs/LIVE_TEST_RUNBOOK.md is an operating procedure for production, so its commands are executed here exactly as an operator
// would paste them (placeholders replaced), against the real migrations. Only what the Edge Functions and workers do on their own
// (catalogue import, the health monitor, the order submission and the sync worker) is played by this test.
const ROOT = path.resolve(__dirname, '..')
const DOC = fs.readFileSync(path.join(ROOT, 'docs/LIVE_TEST_RUNBOOK.md'), 'utf8')

const BLOCKS = new Map<string, string>(
  [...DOC.matchAll(/^```sql\n-- live-test: ([a-z-]+)\n([\s\S]*?)^```/gm)].map((m) => [m[1], m[2]]),
)

const TG = 777001
const PROVIDER = 'Flight Panel'
const fill = (sql: string, over: Record<string, string> = {}) => {
  const values: Record<string, string> = {
    'YOUR TELEGRAM ID': String(TG), 'PROVIDER NAME': PROVIDER, 'PANEL API URL': 'https://panel.example.com/api/v2', 'PROJECT REF': 'abcdefgh',
    'CUSTOMER RATE PER 1000': '0.15', 'MIN QTY': '100', 'MAX QTY': '1000', 'TEST FUNDS USD': '1.00', 'UNUSED TEST FUNDS USD': '0.60', ...over,
  }
  const out = sql.replace(/<([A-Z][A-Z0-9 ]+[A-Z0-9])>/g, (whole, key: string) => {
    if (!(key in values)) throw new Error(`placeholder ${whole} has no test value`)
    return values[key]
  })
  return out
}

describe('the runbook document', () => {
  it('has every block the procedure refers to', () => {
    expect([...BLOCKS.keys()].sort()).toEqual([
      'add-provider', 'brake', 'candidates', 'category', 'close-orders', 'closeout', 'create-service', 'cron-runs', 'enable-routing', 'fund-wallet', 'lockdown',
      'money-identity', 'open-orders', 'order-history', 'order-state', 'provider-balance', 'provider-health-log', 'provider-state', 'reclaim-funds',
      'service-state', 'side-effects', 'stop-routing', 'test-user', 'wallet-ledger', 'wallet-state', 'worker-state',
    ])
  })

  it('has every step and the three levels of stopping', () => {
    for (const h of ['## Step 0:', '## Step 1:', '## Step 2:', '## Step 3:', '## Step 4:', '## Step 5:', '## Step 6:', '## Abort: stop everything', '**Level 1', '**Level 2', '**Level 3']) {
      expect(DOC, h).toContain(h)
    }
  })

  it('points at the emergency quarantine script and the commands that run it; the script exists', () => {
    expect(DOC).toContain('supabase/scripts/emergency_quarantine.sql')
    expect(DOC).toContain('psql "$DATABASE_URL" -f supabase/scripts/emergency_quarantine.sql')
    expect(DOC).toMatch(/Dashboard -> SQL Editor -> paste -> Run/)
    expect(fs.existsSync(path.join(ROOT, 'supabase/scripts/emergency_quarantine.sql'))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, 'docs/RUNBOOK.md'))).toBe(true)
  })

  it('says where the provider key really lives and never asks for it in SQL, a command line or a log', () => {
    expect(DOC).toMatch(/Edge Function secret/)
    expect(DOC).toMatch(/Get-Clipboard \| npm run secrets:rotate -- provider-key --provider "<PROVIDER NAME>" --store db/)
    for (const [name, sql] of BLOCKS) expect(sql, name).not.toMatch(/api_key_encrypted\s*=|api_key\s*=|apikey/i)
    // the CRON_SECRET is read into a variable and never echoed
    expect(DOC).toContain("$s = (Select-String -Path .env.local -Pattern '^CRON_SECRET=(.*)$')")
  })

  it('names the observer and its exit contract', () => {
    expect(DOC).toContain('npm run observe:live')
    expect(DOC).toContain('RESULT CLEAN')
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['observe:live']).toContain('scripts/observe-live-test.ts')
  })

  it('every verification block of step 5 is a single read-only SELECT (it cannot change anything)', () => {
    for (const name of ['test-user', 'provider-state', 'provider-health-log', 'candidates', 'service-state', 'wallet-state', 'order-state', 'order-history', 'wallet-ledger',
      'money-identity', 'worker-state', 'cron-runs', 'provider-balance', 'side-effects']) {
      // the last statement of a block is the read; blocks of step 5 are exactly one statement
      expect(() => assertReadOnly(fill(BLOCKS.get(name)!, { 'ORDER ID': '00000000-0000-4000-8000-000000000001' }).replace(/;\s*$/, '')), name).not.toThrow()
    }
  })

  it('refers to tables that exist, and not to the ones the original plan assumed', () => {
    for (const [name, sql] of BLOCKS) expect(sql, name).not.toMatch(/wallet_ledger|provider_balance_samples/)
  })
})

describe('the flight test, step by step, on the real schema', () => {
  let db: PGlite
  let admin: string, providerId: string, providerServiceId: string, serviceId: string, orderId: string

  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, any>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v
  /** Runs a block of the document; returns the rows of its LAST statement. */
  const run = async (name: string, over: Record<string, string> = {}) => {
    const results = await db.exec(fill(BLOCKS.get(name)!, over))
    return (results.at(-1)?.rows ?? []) as Record<string, any>[]
  }
  const settings = async () => (await rows(`select global_orders_enabled o, global_payments_enabled p, maintenance_mode m, global_signups_enabled s from platform_settings where id = 1`))[0]

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    // production at the start of the test: you are the only user, orders and sign-ups are on, there is no provider, no category, no service
    admin = await one<string>(`insert into users(telegram_id, is_admin) values ($1, true) returning id v`, [TG])
  }, 180_000)

  it('step 0: the lockdown closes orders and sign-ups, leaves the rest alone and leaves an audit entry', async () => {
    expect(await settings()).toEqual({ o: true, p: true, m: false, s: true })
    await run('lockdown')
    expect(await settings()).toEqual({ o: false, p: true, m: false, s: false })
    expect(await rows(`select 1 from admin_audit_log where action = 'live_test_lockdown'`)).toHaveLength(1)
  })

  it('step 0: the test account is found, an admin, with an empty wallet', async () => {
    const r = await run('test-user')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: admin, telegram_id: TG, is_admin: true, is_banned: false })
    expect(Number(r[0].balance)).toBe(0)
  })

  it('step 1: the provider row is created with routing OFF, and creating it again changes nothing', async () => {
    await run('add-provider')
    const r = await run('add-provider')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ name: PROVIDER, is_active: true, routing_enabled: false, health: 'disabled', has_key: false })
    providerId = r[0].id
    expect(await rows(`select 1 from providers where name = $1`, [PROVIDER])).toHaveLength(1)
  })

  it('step 1: routing cannot be switched on before the key is stored; afterwards it can, and it is audited', async () => {
    await expect(run('enable-routing')).rejects.toThrow(/no_api_key/)
    // 1c, played by `npm run secrets:rotate -- provider-key --store db --apply`: only ciphertext is ever written
    await db.query(`update providers set api_key_encrypted = 'v1:iv:ciphertext' where id = $1`, [providerId])
    await run('enable-routing')
    expect((await rows(`select routing_enabled r from providers where id = $1`, [providerId]))[0].r).toBe(true)
    expect(await rows(`select 1 from admin_audit_log where action = 'set_provider_routing' and target_id = $1`, [providerId])).toHaveLength(1)
  })

  it('step 1: the provider-state block reports what the health monitor wrote', async () => {
    // the health monitor, played: healthy, balance read from the panel
    await db.query(`update providers set health_status = 'healthy', provider_balance = 5, last_balance_sync = now(), last_health_check = now() where id = $1`, [providerId])
    const r = await run('provider-state')
    expect(r[0]).toMatchObject({ name: PROVIDER, routing_enabled: true, health: 'healthy', has_key: true, sync_backoff_until: null, sync_failure_count: 0 })
    expect(Number(r[0].provider_balance)).toBe(5)
    await db.query(`insert into provider_health_log(provider_id, status, previous_status, latency_ms, error_kind) values ($1, 'healthy', 'disabled', 120, null)`, [providerId])
    expect((await run('provider-health-log'))[0]).toMatchObject({ status: 'healthy', latency_ms: 120 })
  })

  it('step 2: the candidate list shows the cheapest Telegram views first', async () => {
    // sync-catalog, played: the panel's services land in provider_services
    await db.query(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
                    values ($1, '201', 'Telegram Post Views Premium', 0.20, 100, 100000), ($1, '101', 'Telegram Post Views', 0.05, 100, 100000), ($1, '301', 'Instagram Likes', 0.01, 10, 5000)`, [providerId])
    const r = await run('candidates')
    expect(r.map((x) => x.name)).toEqual(['Telegram Post Views', 'Telegram Post Views Premium'])
    providerServiceId = r[0].id
  })

  it('step 2: the category is created once; a storefront service needs a rate at or above the panel cost', async () => {
    await run('category')
    expect((await run('category'))).toHaveLength(1)
    await expect(run('create-service', { 'PROVIDER SERVICE ID': providerServiceId, 'CUSTOMER RATE PER 1000': '0.01' })).rejects.toThrow(/below_cost/)
    await expect(run('create-service', { 'PROVIDER SERVICE ID': providerServiceId, 'MAX QTY': '999999' })).rejects.toThrow(/limits_exceed_panel/)
    expect(await rows(`select 1 from services`)).toHaveLength(0)
  })

  it('step 2: exactly one active service with one active offer is created, with the capped limits', async () => {
    const created = await run('create-service', { 'PROVIDER SERVICE ID': providerServiceId })
    serviceId = created[0].admin_create_service_with_offer.service_id
    const r = await run('service-state')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ name: 'Telegram Post Views (flight test)', is_active: true, offer_active: true, anomaly_detected: false, provider: PROVIDER, min_quantity: 100, max_quantity: 1000 })
    expect(Number(r[0].customer_rate_per_1000)).toBe(0.15)
    expect(Number(r[0].cost_per_1000)).toBe(0.05)
    expect(Number(r[0].active_services)).toBe(1)
  })

  it('step 3: funding credits the wallet once through the ledger; a repeat is harmless and a different amount is refused', async () => {
    expect(Number((await run('fund-wallet'))[0].balance)).toBe(1)
    expect(Number((await run('fund-wallet'))[0].balance)).toBe(1) // the same key and amount: the original entry is returned
    await expect(run('fund-wallet', { 'TEST FUNDS USD': '5.00' })).rejects.toThrow(/already used with different parameters/)
    const ledger = await run('wallet-state')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ type: 'manual_adjustment', status: 'completed', description: 'LIVE TEST funding (no TON deposit)' })
    expect(Number(ledger[0].amount)).toBe(1)
    expect(Number(ledger[0].balance_after)).toBe(1)
    expect(Number((await rows(`select balance from wallets where user_id = $1`, [admin]))[0].balance)).toBe(1)
  })

  it('step 4: the order door opens and closes; sign-ups stay closed throughout', async () => {
    await run('open-orders')
    expect(await settings()).toEqual({ o: true, p: true, m: false, s: false })
    await run('close-orders')
    expect(await settings()).toEqual({ o: false, p: true, m: false, s: false })
    await run('open-orders')
  })

  it('step 4 and 5: an order goes through its life and every verification block tells the truth', async () => {
    const offer = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [serviceId]))[0]
    // place-order, played: the database function that charges the wallet
    orderId = await one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/mychannel/7', 100, $3::uuid, $4::uuid, $5::uuid, 0.005::numeric, 'flight-1')`,
      [admin, serviceId, offer.id, offer.provider_id, offer.provider_service_id])
    await run('close-orders')
    await db.query(`update orders set status = 'processing' where id = $1`, [orderId])
    await db.query(`update orders set status = 'submitted', provider_order_id = 'P-8841' where id = $1`, [orderId])
    // sync-order-status, played: one run under the lease, then a heartbeat
    const token = await one<string>(`select try_acquire_worker_lock('sync-order-status', 60) v`)
    await db.query(`update orders set status = 'in_progress', start_count = 12, remains = 100 where id = $1`, [orderId])
    await db.query(`select release_worker_lock('sync-order-status', $1::uuid)`, [token])
    await db.query(`update orders set status = 'completed', remains = 0 where id = $1`, [orderId])
    await db.query(`select record_worker_heartbeat('sync-order-status', true, null, 120)`)
    await db.query(`select record_worker_heartbeat('provider-health-monitor', true, null, 80)`)
    await db.query(`update providers set provider_balance = 4.995, last_balance_sync = now() where id = $1`, [providerId])

    const o = (await run('order-state', { 'ORDER ID': orderId }))[0]
    expect(o).toMatchObject({ status: 'completed', quantity: 100, provider_order_id: 'P-8841', provider: PROVIDER, error_message: null })
    expect([Number(o.charge_amount), Number(o.cost_amount), Number(o.profit_amount)]).toEqual([0.015, 0.005, 0.01])

    const history = await run('order-history', { 'ORDER ID': orderId })
    expect(history.map((h) => h.new_status)).toEqual(['draft', 'awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress', 'completed'])

    const ledger = await run('wallet-ledger', { 'ORDER ID': orderId })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ type: 'purchase', status: 'completed' })
    expect(Number(ledger[0].amount)).toBe(-0.015)

    const money = (await run('money-identity', { 'ORDER ID': orderId }))[0]
    expect(money).toMatchObject({ status: 'completed', profit_adds_up: true })
    expect(Number(money.net_wallet_effect)).toBe(-0.015)

    const workers = await run('worker-state')
    const lease = workers.find((w) => w.kind === 'lease')!
    expect(lease).toMatchObject({ name: 'sync-order-status', held: false })
    expect(workers.filter((w) => w.kind === 'heartbeat').map((w) => w.name)).toEqual(['provider-health-monitor', 'sync-order-status'])

    const prov = (await run('provider-balance'))[0]
    expect(prov).toMatchObject({ name: PROVIDER, health: 'healthy', sync_backoff_until: null, sync_failure_count: 0 })
    expect(Number(prov.provider_balance)).toBeCloseTo(4.995, 4)

    const side = await run('side-effects', { 'ORDER ID': orderId })
    expect(side[0]).toEqual({ what: 'open reconciliation cases', value: '0' })
    expect(side[1].what).toBe('notification completed')
  })

  it('step 5: the money identity for an order the provider canceled: the refund brings the wallet effect back to zero', async () => {
    const offer = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [serviceId]))[0]
    const id = await one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/mychannel/8', 100, $3::uuid, $4::uuid, $5::uuid, 0.005::numeric, 'flight-2')`,
      [admin, serviceId, offer.id, offer.provider_id, offer.provider_service_id])
    await db.query(`update orders set status = 'processing' where id = $1`, [id])
    await db.query(`update orders set status = 'submitted', provider_order_id = 'P-8842' where id = $1`, [id])
    await db.query(`update orders set status = 'canceled', error_message = 'needs_refund: provider canceled order' where id = $1`, [id])
    await db.query(`select refund_order($1::uuid, null, 'provider canceled')`, [id])
    const money = (await run('money-identity', { 'ORDER ID': id }))[0]
    expect(money).toMatchObject({ status: 'refunded', profit_adds_up: true })
    expect(Number(money.net_wallet_effect)).toBe(0)
    const ledger = await run('wallet-ledger', { 'ORDER ID': id })
    expect(ledger.map((l) => l.type)).toEqual(['purchase', 'refund'])
  })

  it('step 6: the close-out deactivates the service, reopens sign-ups, keeps orders off, and the unused funds are taken back once', async () => {
    await run('closeout')
    expect(await settings()).toEqual({ o: false, p: true, m: false, s: true })
    expect((await rows(`select is_active from services where id = $1`, [serviceId]))[0].is_active).toBe(false)
    expect(await rows(`select 1 from admin_audit_log where action = 'live_test_closeout'`)).toHaveLength(1)

    const before = Number((await rows(`select balance from wallets where user_id = $1`, [admin]))[0].balance)
    expect(before).toBeCloseTo(0.985, 4) // 1.00 funded, one order of 0.015 completed, the other refunded
    const r = await run('reclaim-funds')
    expect(Number(r[0].balance)).toBeCloseTo(before - 0.6, 4)
    await run('reclaim-funds')
    expect(Number((await rows(`select balance from wallets where user_id = $1`, [admin]))[0].balance)).toBeCloseTo(before - 0.6, 4) // the second run did nothing
  })

  it('abort level 1: the brake stops orders, payments and opens maintenance in one statement', async () => {
    await db.exec(`update platform_settings set global_orders_enabled = true, global_payments_enabled = true, maintenance_mode = false where id = 1`)
    await run('brake')
    expect(await settings()).toMatchObject({ o: false, p: false, m: true })
    await db.exec(`update platform_settings set global_payments_enabled = true, maintenance_mode = false where id = 1`)
  })

  it('abort level 3: stopping routing leaves the provider row but takes it out of rotation', async () => {
    const r = await run('stop-routing')
    expect(r[0]).toEqual({ name: PROVIDER, routing_enabled: false })
  })

  it('cron-runs needs pg_cron (not present in the test database); its columns are the ones pg_cron has (checked on production)', async () => {
    expect(BLOCKS.get('cron-runs')).toMatch(/cron\.job_run_details/)
    await expect(run('cron-runs')).rejects.toThrow(/cron/)
  })
})
