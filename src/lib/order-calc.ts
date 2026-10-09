// DISPLAY-ONLY order maths. The authoritative total is computed by the database
// (place_order: round(customer_rate_per_1000 * quantity / 1000, 4)) - this module
// mirrors that formula so what the user sees equals what is charged, but the client
// total is never sent to or trusted by the server.
//
// Money is handled as integer "units" of 1e-4 (the precision of NUMERIC(14,4)) to avoid
// floating-point drift.

// Same validators the place-order Edge Function runs: the server result is the one that counts.
export {
  MAX_URL_LENGTH,
  formatInt,
  validateQuantity,
  validateTargetUrl,
  type Validation,
} from '../../supabase/functions/_shared/order-validation.ts'

export const UNITS_PER_CURRENCY = 10_000

export const toUnits = (amount: number): number => Math.round(amount * UNITS_PER_CURRENCY)

/** round-half-up(quantity * rate / 1000) at 4 decimals, in units. Matches PostgreSQL round(numeric, 4). */
export function calcTotalUnits(quantity: number, ratePer1000: number): number {
  const rateUnits = toUnits(ratePer1000)
  return Math.floor((quantity * rateUnits * 2 + 1000) / 2000)
}

/** "$2.40", "$0.0825" - always at least 2 decimals, up to 4 when the cents are not exact. */
export function formatUnits(units: number): string {
  const sign = units < 0 ? '-' : ''
  const abs = Math.abs(units)
  const whole = Math.floor(abs / UNITS_PER_CURRENCY)
  let frac = String(abs % UNITS_PER_CURRENCY).padStart(4, '0')
  if (frac.endsWith('00')) frac = frac.slice(0, 2)
  else if (frac.endsWith('0')) frac = frac.slice(0, 3)
  return `${sign}$${whole.toLocaleString('en-US')}.${frac}`
}

export const formatMoneyAmount = (amount: number): string => formatUnits(toUnits(amount))

/** 1000000 -> "1M", 50000 -> "50K", 750 -> "750" */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`
  return String(n)
}

export interface BalanceCheck {
  sufficient: boolean
  /** How much is missing, in units (0 when sufficient). */
  shortfallUnits: number
}

export function checkBalance(balance: number, totalUnits: number): BalanceCheck {
  const shortfallUnits = Math.max(0, totalUnits - toUnits(balance))
  return { sufficient: shortfallUnits === 0, shortfallUnits }
}

/** Quantity quick-picks that fit the service limits (always includes the minimum). */
export function quantityPresets(min: number, max: number): number[] {
  const candidates = [min, 1_000, 5_000, 10_000, 50_000]
  return [...new Set(candidates.filter((q) => q >= min && q <= max))].slice(0, 4)
}

import { tr } from '@/i18n'

export type Speed = 'Instant' | 'Fast' | 'Slow' | 'Standard'

/** The labels a service's speed can show (display: t(speed)). */
export const SPEED_LABELS = [tr('Instant'), tr('Fast'), tr('Slow'), tr('Standard')] as const

/** Panels encode speed in the service title, e.g. "Views [Instant]". */
export function deriveSpeed(name: string): Speed {
  if (/\binstant\b/i.test(name)) return 'Instant'
  if (/\bfast\b/i.test(name)) return 'Fast'
  if (/\bslow\b/i.test(name)) return 'Slow'
  return 'Standard'
}

// Same exact partial-refund formula the sync worker's database function uses.
export { calcPartialRefund } from '../../supabase/functions/_shared/order-sync.ts'
