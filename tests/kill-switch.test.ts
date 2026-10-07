import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  PAUSE_MESSAGES,
  assertSwitchOn,
  enforceKillSwitch,
  loadPlatformSettings,
  parseSettingsRequest,
  settingsFromRow,
  type PlatformSettings,
} from '../supabase/functions/_shared/platform-settings.ts'
import { ServiceUnavailableError } from '../supabase/functions/_shared/routing.ts'
import { createMockSettings } from '../src/services/api/mock-settings'
import { AdminApiError } from '../src/services/api/mock-admin'

const settings = (over: Partial<PlatformSettings> = {}): PlatformSettings => ({
  globalOrdersEnabled: true, globalPaymentsEnabled: true, maintenanceMode: false, updatedAt: null, ...over,
})

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

describe('assertSwitchOn', () => {
  it('lets everything through by default', () => {
    expect(() => assertSwitchOn(settings(), 'orders')).not.toThrow()
    expect(() => assertSwitchOn(settings(), 'payments')).not.toThrow()
  })

  it('global_orders_enabled = false blocks orders only', () => {
    const s = settings({ globalOrdersEnabled: false })
    expect(() => assertSwitchOn(s, 'orders')).toThrow(ServiceUnavailableError)
    expect(() => assertSwitchOn(s, 'orders')).toThrow(PAUSE_MESSAGES.orders)
    expect(() => assertSwitchOn(s, 'payments')).not.toThrow()
  })

  it('global_payments_enabled = false blocks deposits only', () => {
    const s = settings({ globalPaymentsEnabled: false })
    expect(() => assertSwitchOn(s, 'payments')).toThrow(ServiceUnavailableError)
    expect(() => assertSwitchOn(s, 'payments')).toThrow(PAUSE_MESSAGES.payments)
    expect(() => assertSwitchOn(s, 'orders')).not.toThrow()
  })

  it('maintenance_mode blocks both, whatever the other switches say', () => {
    for (const [o, p] of [[true, true], [true, false], [false, true], [false, false]]) {
      const s = settings({ maintenanceMode: true, globalOrdersEnabled: o, globalPaymentsEnabled: p })
      expect(() => assertSwitchOn(s, 'orders')).toThrow(ServiceUnavailableError)
      expect(() => assertSwitchOn(s, 'payments')).toThrow(ServiceUnavailableError)
    }
  })

  it('fails CLOSED when the settings are unknown', () => {
    for (const which of ['orders', 'payments'] as const) {
      expect(() => assertSwitchOn(null, which)).toThrow(ServiceUnavailableError)
    }
  })

  it('uses messages that are safe to show to customers', () => {
    expect(PAUSE_MESSAGES.orders).toMatch(/^Order processing is temporarily paused/)
    expect(PAUSE_MESSAGES.payments).toMatch(/^Deposits are temporarily disabled/)
  })
})

describe('settingsFromRow', () => {
  it('maps a good row', () => {
    expect(settingsFromRow({ global_orders_enabled: true, global_payments_enabled: false, maintenance_mode: true, updated_at: 't' }))
      .toEqual({ globalOrdersEnabled: true, globalPaymentsEnabled: false, maintenanceMode: true, updatedAt: 't' })
  })
  it('never guesses: a missing row or a non-boolean flag is "unknown"', () => {
    expect(settingsFromRow(null)).toBeNull()
    expect(settingsFromRow(undefined)).toBeNull()
    expect(settingsFromRow({ global_orders_enabled: 'true', global_payments_enabled: true, maintenance_mode: false })).toBeNull()
    expect(settingsFromRow({ global_orders_enabled: true, global_payments_enabled: null, maintenance_mode: false })).toBeNull()
    expect(settingsFromRow({ global_orders_enabled: true, global_payments_enabled: true })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Loading it
// ---------------------------------------------------------------------------

/** A fake supabase-js chain: from().select().eq().maybeSingle(). */
const fakeDb = (result: () => Promise<{ data: unknown; error: unknown }>, calls: string[] = []) => ({
  from(table: string) {
    calls.push(`from:${table}`)
    const chain = {
      select: () => chain,
      eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return chain },
      maybeSingle: () => result(),
    }
    return chain
  },
})

describe('loadPlatformSettings', () => {
  it('reads the single row by primary key, in one query', async () => {
    const calls: string[] = []
    const s = await loadPlatformSettings(fakeDb(async () => ({ data: { global_orders_enabled: true, global_payments_enabled: true, maintenance_mode: false, updated_at: null }, error: null }), calls))
    expect(s).toMatchObject({ globalOrdersEnabled: true })
    expect(calls).toEqual(['from:platform_settings', 'eq:id=1'])
  })

  it('returns null on a database error, a thrown error, or an empty table', async () => {
    expect(await loadPlatformSettings(fakeDb(async () => ({ data: null, error: { message: 'boom' } })))).toBeNull()
    expect(await loadPlatformSettings(fakeDb(async () => { throw new Error('network') }))).toBeNull()
    expect(await loadPlatformSettings(fakeDb(async () => ({ data: null, error: null })))).toBeNull()
  })

  it('enforceKillSwitch refuses when the read fails (fail closed)', async () => {
    await expect(enforceKillSwitch(fakeDb(async () => ({ data: null, error: { message: 'down' } })), 'orders')).rejects.toBeInstanceOf(ServiceUnavailableError)
  })
})

// ---------------------------------------------------------------------------
// The functions really call it, in the right place
// ---------------------------------------------------------------------------

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

describe('enforcement inside the Edge Functions (source order)', () => {
  it('place-order checks the switch before routing, charging or touching the wallet', () => {
    const src = read('supabase/functions/place-order/index.ts')
    const check = src.indexOf("assertSwitchOn(settings, 'orders')")
    expect(check).toBeGreaterThan(0)
    for (const later of ['buildCandidates(', 'resolveOffer(', 'executePlaceOrder(', 'buildPorts(db)', "from('provider_service_offers')"]) {
      const at = src.indexOf(later, src.indexOf('Deno.serve'))
      expect(at, later).toBeGreaterThan(check)
    }
    expect(src).toMatch(/fail\(503, 'service_unavailable', e\.message\)/)
  })

  it('create-deposit checks the switch before quoting or writing a deposit intent', () => {
    const src = read('supabase/functions/create-deposit/index.ts')
    const check = src.indexOf("assertSwitchOn(settings, 'payments')")
    expect(check).toBeGreaterThan(0)
    for (const later of ['quoteDeposit(', "from('deposits')", '.insert(']) {
      const at = src.indexOf(later, src.indexOf('Deno.serve'))
      expect(at, later).toBeGreaterThan(check)
    }
    expect(src).toMatch(/fail\(503, 'deposits_unavailable', e\.message\)/)
  })

  it('the settings are fetched in parallel with an existing lookup (no extra round trip)', () => {
    expect(read('supabase/functions/place-order/index.ts')).toMatch(/Promise\.all\(\[\s*loadPlatformSettings\(db, log\),\s*db\.from\('services'\)/)
    expect(read('supabase/functions/create-deposit/index.ts')).toMatch(/Promise\.all\(\[loadPlatformSettings\(db, log\), getTonUsdRate\(log\)\]\)/)
  })

  it('verify-deposit is deliberately NOT gated: paid deposits must still be credited', () => {
    expect(read('supabase/functions/verify-deposit/index.ts')).not.toContain('platform-settings')
  })

  it('the frontend is not trusted: the client bundle code never imports the enforcement', () => {
    for (const f of ['src/services/api/orders.ts', 'src/services/api/deposits.ts']) expect(read(f)).not.toContain('platform-settings')
  })
})

// ---------------------------------------------------------------------------
// Admin request parsing
// ---------------------------------------------------------------------------

describe('parseSettingsRequest', () => {
  it('defaults to GET', () => {
    expect(parseSettingsRequest(null)).toEqual({ action: 'GET' })
    expect(parseSettingsRequest({})).toEqual({ action: 'GET' })
    expect(parseSettingsRequest({ action: 'get' })).toEqual({ action: 'GET' })
  })
  it('accepts partial updates; absent switches stay null (unchanged)', () => {
    expect(parseSettingsRequest({ action: 'UPDATE', ordersEnabled: false })).toEqual({ action: 'UPDATE', ordersEnabled: false, paymentsEnabled: null, maintenanceMode: null })
    expect(parseSettingsRequest({ action: 'update', maintenanceMode: true, paymentsEnabled: true })).toEqual({ action: 'UPDATE', ordersEnabled: null, paymentsEnabled: true, maintenanceMode: true })
  })
  it.each([
    [[]], ['x'], [{ action: 'DROP' }], [{ action: 'UPDATE' }], [{ action: 'UPDATE', ordersEnabled: 'false' }], [{ action: 'UPDATE', maintenanceMode: 1 }],
    [{ action: 'UPDATE', ordersEnabled: null }],
  ])('rejects %j', (body) => {
    expect(parseSettingsRequest(body)).toHaveProperty('error')
  })
})

describe('mock settings (dev mode)', () => {
  it('starts fully open, changes one switch at a time, refuses empty updates', () => {
    const m = createMockSettings()
    expect(m.get()).toMatchObject({ globalOrdersEnabled: true, globalPaymentsEnabled: true, maintenanceMode: false })
    expect(m.update({ ordersEnabled: false })).toMatchObject({ globalOrdersEnabled: false, globalPaymentsEnabled: true, maintenanceMode: false })
    expect(m.update({ maintenanceMode: true })).toMatchObject({ globalOrdersEnabled: false, maintenanceMode: true })
    expect(() => m.update({})).toThrow(AdminApiError)
  })
})

// ---------------------------------------------------------------------------
// The table and the admin RPC (real SQL), and the whole chain end to end
// ---------------------------------------------------------------------------

describe('platform_settings (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  const asUser = (id: string) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${id}',false)`)
  const update = async (o: boolean | null, p: boolean | null, m: boolean | null) => {
    await asUser(admin)
    try {
      return (await db.query<{ r: Record<string, unknown> }>(`select update_platform_settings($1::boolean, $2::boolean, $3::boolean) r`, [o, p, m])).rows[0].r
    } finally {
      await db.exec('reset role')
    }
  }
  const row = async () => (await db.query<{ o: boolean; p: boolean; m: boolean; by: string | null }>(
    `select global_orders_enabled o, global_payments_enabled p, maintenance_mode m, updated_by::text by from platform_settings`)).rows[0]

  /** supabase-js-shaped client over the real table, so the production load + assert code runs against real data. */
  const shim = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          const r = await db.query(`select global_orders_enabled, global_payments_enabled, maintenance_mode, updated_at::text from ${table} where id = 1`)
          return { data: r.rows[0] ?? null, error: null }
        },
      }
      return chain
    },
  }

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    user = await q(`insert into users(telegram_id) values (2) returning id`)
    banned = await q(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`)
  }, 120_000)

  it('is created with the default row: everything on, maintenance off', async () => {
    expect((await db.query(`select * from platform_settings`)).rows).toHaveLength(1)
    expect(await row()).toMatchObject({ o: true, p: true, m: false })
  })

  it('can only ever hold one row', async () => {
    await expect(db.exec(`insert into platform_settings(id) values (2)`)).rejects.toThrow()
    await expect(db.exec(`insert into platform_settings(id) values (1)`)).rejects.toThrow()
    await expect(db.exec(`delete from platform_settings`)).rejects.toThrow(/append-only/)
    await expect(db.exec(`truncate platform_settings`)).rejects.toThrow(/append-only/)
  })

  it('an admin can flip each switch on its own, leaving the others alone', async () => {
    await update(false, null, null)
    expect(await row()).toMatchObject({ o: false, p: true, m: false, by: admin })
    await update(null, false, null)
    expect(await row()).toMatchObject({ o: false, p: false, m: false })
    await update(null, null, true)
    expect(await row()).toMatchObject({ o: false, p: false, m: true })
    const r = await update(true, true, false)
    expect(r).toMatchObject({ global_orders_enabled: true, global_payments_enabled: true, maintenance_mode: false })
    expect(await row()).toMatchObject({ o: true, p: true, m: false })
  })

  it('refuses an empty update', async () => {
    await asUser(admin)
    await expect(db.query(`select update_platform_settings()`)).rejects.toThrow(/nothing to update/)
    await db.exec('reset role')
  })

  it('audits every change with old and new values', async () => {
    await update(false, null, true)
    const a = (await db.query<{ admin_id: string; details: Record<string, boolean[]> }>(`select admin_id, details from admin_audit_log where action = 'update_platform_settings'`)).rows
    expect(a).toHaveLength(1)
    expect(a[0].admin_id).toBe(admin)
    expect(a[0].details).toMatchObject({ global_orders_enabled: [true, false], global_payments_enabled: [true, true], maintenance_mode: [false, true] })
  })

  it('is admin-only: users, banned admins, signed-out callers and anon are refused and nothing changes', async () => {
    for (const id of [user, banned, '']) {
      await asUser(id)
      await expect(db.query(`select update_platform_settings(false, false, true)`)).rejects.toThrow(/forbidden/)
    }
    await db.exec(`reset role; set role anon`)
    await expect(db.query(`select update_platform_settings(false, false, true)`)).rejects.toThrow()
    await db.exec('reset role')
    expect(await row()).toMatchObject({ o: true, p: true, m: false })
  })

  it('clients can neither read nor write the table directly', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`)
      await expect(db.query(`select * from platform_settings`)).rejects.toThrow()
      await expect(db.query(`update platform_settings set maintenance_mode = true`)).rejects.toThrow()
    }
    await db.exec('reset role')
    expect(await row()).toMatchObject({ m: false })
  })

  describe('end to end: toggling a switch blocks the guarded call', () => {
    const blocked = (which: 'orders' | 'payments') => enforceKillSwitch(shim, which).then(() => false, (e) => e instanceof ServiceUnavailableError)

    it('everything is open by default', async () => {
      expect(await blocked('orders')).toBe(false)
      expect(await blocked('payments')).toBe(false)
    })

    it('stopping orders blocks place-order only; a deposit still goes through', async () => {
      await update(false, null, null)
      expect(await blocked('orders')).toBe(true)
      expect(await blocked('payments')).toBe(false)
    })

    it('stopping payments blocks create-deposit (a deposit fails) but not orders', async () => {
      await update(null, false, null)
      expect(await blocked('payments')).toBe(true)
      expect(await blocked('orders')).toBe(false)
    })

    it('maintenance mode blocks both even though both individual switches are on', async () => {
      await update(true, true, true)
      expect(await blocked('orders')).toBe(true)
      expect(await blocked('payments')).toBe(true)
    })

    it('re-enabling takes effect on the very next call', async () => {
      await update(false, false, null)
      expect(await blocked('orders')).toBe(true)
      await update(true, true, null)
      expect(await blocked('orders')).toBe(false)
      expect(await blocked('payments')).toBe(false)
    })

    it('a missing row (should never happen) fails closed', async () => {
      await db.exec(`alter table platform_settings disable trigger trg_platform_settings_no_delete`)
      await db.exec(`delete from platform_settings`)
      expect(await blocked('orders')).toBe(true)
      expect(await blocked('payments')).toBe(true)
    })
  })
})
