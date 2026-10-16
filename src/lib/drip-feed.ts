// Drip-feed (gradual delivery) in the order form: the customer types the quantity of ONE delivery, the number of deliveries (runs) and
// the minutes between two; the order's quantity is their product. The bounds are the server's (order-validation.ts): the client check
// only saves a round trip, place-order and place_order decide.
import { MAX_DRIP_INTERVAL_MINUTES, MAX_DRIP_RUNS } from '../../supabase/functions/_shared/order-validation.ts'

export { MAX_DRIP_INTERVAL_MINUTES, MAX_DRIP_RUNS }

export const DEFAULT_DRIP_RUNS = 2
export const DEFAULT_DRIP_INTERVAL_MINUTES = 30

export type DripSchedule =
  | { ok: true; runs: number; interval: number }
  /** Which field is wrong (the form shows the bound next to it). */
  | { ok: false; field: 'runs' | 'interval' }

const whole = (raw: string): number | null => {
  const cleaned = raw.replace(/[\s,]/g, '')
  return /^\d{1,7}$/.test(cleaned) ? Number(cleaned) : null
}

/** Runs: 2 .. MAX_DRIP_RUNS (1 would be a plain order). Interval: 1 .. MAX_DRIP_INTERVAL_MINUTES minutes. */
export function validateDripSchedule(runs: string, interval: string): DripSchedule {
  const r = whole(runs)
  if (r === null || r < 2 || r > MAX_DRIP_RUNS) return { ok: false, field: 'runs' }
  const i = whole(interval)
  if (i === null || i < 1 || i > MAX_DRIP_INTERVAL_MINUTES) return { ok: false, field: 'interval' }
  return { ok: true, runs: r, interval: i }
}

/**
 * What the form sends: the TOTAL quantity, plus runs / interval for a drip-feed order. `perRun` is the validated quantity of one delivery
 * (or of the whole order when drip-feed is off); null while something is invalid.
 */
export function orderShape(perRun: number | null, drip: boolean, schedule: DripSchedule): { quantity: number; runs: number; interval: number } | null {
  if (perRun === null) return null
  if (!drip) return { quantity: perRun, runs: 1, interval: 0 }
  if (!schedule.ok) return null
  const quantity = perRun * schedule.runs
  return Number.isSafeInteger(quantity) ? { quantity, runs: schedule.runs, interval: schedule.interval } : null
}
