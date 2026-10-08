// The business-intelligence half of the admin-analytics function: request parsing, the four SQL aggregations queried together, and
// the camelCase answer. All I/O is injected (adminCheck, rpc, clock), so the access rules are unit-tested without a server.
//
// Access: the caller is the JWT's user; adminCheck must say they are an admin BEFORE anything is queried, otherwise 403 and the
// database is never touched. The bi_* SQL functions are service-role only, so even a leaked client token cannot call them directly.

export const BI_RANGES = [7, 30, 90] as const
export type BiRange = (typeof BI_RANGES)[number]
export const BI_RETENTION_DAYS = [1, 7]
export const BI_TOP_SERVICES = 10

export type BiRequest = { ok: true; days: BiRange } | { ok: false; message: string }

/** { action: 'BI', days?: 7 | 30 | 90 } (default 30). */
export function parseBiRequest(body: unknown): BiRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: 'Body must be a JSON object.' }
  const days = (body as Record<string, unknown>).days
  if (days === undefined || days === null) return { ok: true, days: 30 }
  if (typeof days !== 'number' || !(BI_RANGES as readonly number[]).includes(days)) return { ok: false, message: 'days must be 7, 30 or 90.' }
  return { ok: true, days: days as BiRange }
}

/** The window: the last `days` full-and-current UTC days, ending now. */
export function biWindow(days: BiRange, now: Date): { from: string; to: string } {
  const to = new Date(now.getTime() + 1_000) // include the current second
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)))
  return { from: from.toISOString(), to: to.toISOString() }
}

// ---------------------------------------------------------------------------
// Answer shapes
// ---------------------------------------------------------------------------
type Obj = Record<string, unknown>
const n = (v: unknown) => Number(v ?? 0)
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => typeof x === 'object' && x !== null && !Array.isArray(x)) as Obj[]) : [])

export interface FunnelStep { step: string; users: number; rateFromPrevious: number | null; rateFromFirst: number | null }
export interface RevenueDay { day: string; orders: number; revenue: number; cost: number; margin: number; aov: number | null }
export interface RetentionCohort { cohort: string; size: number; retention: { day: number; users: number | null; rate: number | null }[] }
export interface TopService { serviceId: string; name: string; orders: number; units: number; revenue: number; margin: number; aov: number }

export const toFunnel = (r: unknown): FunnelStep[] =>
  arr((r as Obj)?.steps).map((s) => ({ step: String(s.step), users: n(s.users), rateFromPrevious: nn(s.rate_from_previous), rateFromFirst: nn(s.rate_from_first) }))
export const toRevenue = (r: unknown): RevenueDay[] =>
  arr(r).map((d) => ({ day: String(d.day), orders: n(d.orders), revenue: n(d.revenue), cost: n(d.cost), margin: n(d.margin), aov: nn(d.aov) }))
export const toRetention = (r: unknown): RetentionCohort[] =>
  arr(r).map((c) => ({
    cohort: String(c.cohort), size: n(c.size),
    retention: arr(c.retention).map((x) => ({ day: n(x.day), users: nn(x.users), rate: nn(x.rate) })),
  }))
export const toTopServices = (r: unknown): TopService[] =>
  arr(r).map((s) => ({ serviceId: String(s.service_id), name: String(s.name), orders: n(s.orders), units: n(s.units), revenue: n(s.revenue), margin: n(s.margin), aov: n(s.aov) }))

export type Section<T> = { data: T } | { error: string }

export interface BiResponse {
  success: true
  days: BiRange
  from: string
  to: string
  funnel: Section<FunnelStep[]>
  revenue: Section<RevenueDay[]>
  retention: Section<RetentionCohort[]>
  topServices: Section<TopService[]>
}

export interface BiDeps {
  /** True only for a signed-in, non-banned admin. Called first; nothing else runs if it is false. */
  adminCheck: () => Promise<boolean>
  /** The service-role RPC call. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  now?: () => Date
}

export type BiResult =
  | { status: 200; body: BiResponse }
  | { status: 400 | 403 | 500; body: { success: false; error: string; message: string } }

const failure = (status: 400 | 403 | 500, error: string, message: string): BiResult => ({ status, body: { success: false, error, message } })

/**
 * Admin check first (403 and no query for anyone else), then the four aggregations are queried TOGETHER (they are independent
 * reads, so the dashboard costs one round of latency, not four). Each section succeeds or fails on its own: a broken query shows
 * as an error on its card while the rest of the dashboard still loads. Only when all four fail is the request itself a 500.
 */
export async function handleAdminBi(body: unknown, deps: BiDeps): Promise<BiResult> {
  let isAdmin: boolean
  try {
    isAdmin = await deps.adminCheck()
  } catch {
    return failure(500, 'server_error', 'Something went wrong. Please try again.')
  }
  if (!isAdmin) return failure(403, 'forbidden', 'Admin access required.')

  const req = parseBiRequest(body)
  if (!req.ok) return failure(400, 'invalid_input', req.message)

  const { from, to } = biWindow(req.days, (deps.now ?? (() => new Date()))())
  const range = { p_from: from, p_to: to }
  const run = <T,>(fn: string, args: Record<string, unknown>, map: (data: unknown) => T): Promise<Section<T>> =>
    deps.rpc(fn, args).then(
      ({ data, error }): Section<T> => (error ? { error: 'This section could not be loaded.' } : { data: map(data) }),
      (): Section<T> => ({ error: 'This section could not be loaded.' }),
    )

  const [funnel, revenue, retention, topServices] = await Promise.all([
    run('bi_funnel', range, toFunnel),
    run('bi_revenue_daily', range, toRevenue),
    run('bi_retention', { ...range, p_days: BI_RETENTION_DAYS }, toRetention),
    run('bi_top_services', { ...range, p_limit: BI_TOP_SERVICES }, toTopServices),
  ])
  if ([funnel, revenue, retention, topServices].every((s) => 'error' in s)) return failure(500, 'server_error', 'Something went wrong. Please try again.')
  return { status: 200, body: { success: true, days: req.days, from, to, funnel, revenue, retention, topServices } }
}
