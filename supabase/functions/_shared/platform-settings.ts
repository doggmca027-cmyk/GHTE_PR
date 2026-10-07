// Platform kill switches (table platform_settings, see migration 20261021000000).
//
// Rules:
//   * The check runs on the SERVER, inside the Edge Function, before any wallet or ledger operation. Nothing here
//     trusts the client.
//   * maintenance_mode blocks everything that starts new money flows (orders and deposits).
//   * Fail closed: if the settings cannot be read (database error, missing or malformed row) the switch is treated as
//     OFF. A health check on one tiny row failing means the database is not in a state to take money anyway.
import { createLogger, newCorrelationId, type Logger } from './logger.ts'

import { ServiceUnavailableError } from './routing.ts'

export interface PlatformSettings {
  globalOrdersEnabled: boolean
  globalPaymentsEnabled: boolean
  maintenanceMode: boolean
  updatedAt: string | null
}

export type KillSwitch = 'orders' | 'payments'

export const PAUSE_MESSAGES: Record<KillSwitch, string> = {
  orders: 'Order processing is temporarily paused. Please try again later.',
  payments: 'Deposits are temporarily disabled. Please try again later.',
}
const UNKNOWN_STATE_MESSAGE = 'This service is temporarily unavailable. Please try again in a moment.'

/** Maps the table row; null when it is missing or any flag is not a real boolean (never guess a default). */
export function settingsFromRow(row: Record<string, unknown> | null | undefined): PlatformSettings | null {
  if (!row) return null
  const { global_orders_enabled: o, global_payments_enabled: p, maintenance_mode: m } = row
  if (typeof o !== 'boolean' || typeof p !== 'boolean' || typeof m !== 'boolean') return null
  return { globalOrdersEnabled: o, globalPaymentsEnabled: p, maintenanceMode: m, updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null }
}

/** Throws ServiceUnavailableError (with a message that is safe to show to users) when the switch is off. */
export function assertSwitchOn(settings: PlatformSettings | null, which: KillSwitch): void {
  if (!settings) throw new ServiceUnavailableError(UNKNOWN_STATE_MESSAGE)
  const on = which === 'orders' ? settings.globalOrdersEnabled : settings.globalPaymentsEnabled
  if (settings.maintenanceMode || !on) throw new ServiceUnavailableError(PAUSE_MESSAGES[which])
}

/** The slice of the supabase-js client used here (structural, so this file has no npm imports). */
// deno-lint-ignore no-explicit-any
type DbLike = { from(table: string): any }

/** One single-row read by primary key. Returns null on any failure (callers fail closed through assertSwitchOn). */
export async function loadPlatformSettings(db: DbLike, log: Pick<Logger, 'error'> = createLogger({ fn: 'platform-settings', correlationId: newCorrelationId() })): Promise<PlatformSettings | null> {
  try {
    const { data, error } = await db
      .from('platform_settings')
      .select('global_orders_enabled, global_payments_enabled, maintenance_mode, updated_at')
      .eq('id', 1)
      .maybeSingle()
    if (error) {
      log.error('platform_settings read failed', { err: error, error_code: 'settings_unreadable' })
      return null
    }
    return settingsFromRow(data)
  } catch (e) {
    log.error('platform_settings read failed', { err: e, error_code: 'settings_unreadable' })
    return null
  }
}

/** Convenience: load + assert. Throws ServiceUnavailableError when paused or unreadable. */
export async function enforceKillSwitch(db: DbLike, which: KillSwitch): Promise<void> {
  assertSwitchOn(await loadPlatformSettings(db), which)
}

// ---------------------------------------------------------------------------
// Admin request (admin-settings Edge Function)
// ---------------------------------------------------------------------------

export type SettingsRequest =
  | { action: 'GET' }
  | { action: 'UPDATE'; ordersEnabled: boolean | null; paymentsEnabled: boolean | null; maintenanceMode: boolean | null }

/** Strict body validation: every switch is a real boolean or absent; an update must change at least one. */
export function parseSettingsRequest(body: unknown): SettingsRequest | { error: string } {
  if (body === null || body === undefined) return { action: 'GET' }
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'GET'
  if (action === 'GET') return { action: 'GET' }
  if (action !== 'UPDATE') return { error: 'Unknown action.' }

  const flag = (key: string): boolean | null | 'invalid' => {
    const v = b[key]
    if (v === undefined || v === null) return null
    return typeof v === 'boolean' ? v : 'invalid'
  }
  const ordersEnabled = flag('ordersEnabled')
  const paymentsEnabled = flag('paymentsEnabled')
  const maintenanceMode = flag('maintenanceMode')
  if (ordersEnabled === 'invalid' || paymentsEnabled === 'invalid' || maintenanceMode === 'invalid') return { error: 'Switches must be true or false.' }
  if (ordersEnabled === null && paymentsEnabled === null && maintenanceMode === null) return { error: 'Nothing to update.' }
  return { action: 'UPDATE', ordersEnabled, paymentsEnabled, maintenanceMode }
}
