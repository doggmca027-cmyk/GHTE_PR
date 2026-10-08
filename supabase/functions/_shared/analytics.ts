// What the app may report about itself, and how a report is cleaned before it is stored. Pure (no I/O): the track-event function
// feeds it the request body.
//
// PRIVACY BY CONSTRUCTION. This is an allow-list, not a scrubber: an event name that is not listed is dropped, a property that is
// not listed for that event is dropped, and a listed property is kept only if its value has the exact expected shape (a UUID, a
// short slug, a bounded number, a boolean, one of a fixed set). Free text never gets through, so a link, a @handle, an e-mail, an
// IP address or a promo code the customer typed has no way into the database, whatever the client sends.
// Money and account events (user_registered, first_deposit, order_placed, order_refunded, promo_applied) are written by the
// database itself and are NOT accepted from clients: they could otherwise be faked.

type PropSpec = 'uuid' | 'slug' | 'int' | 'amount' | 'bool' | { enum: readonly string[] }

export const CLIENT_EVENTS: Readonly<Record<string, Readonly<Record<string, PropSpec>>>> = {
  app_opened: { platform: 'slug' },
  catalog_view: { platform: 'slug', category_id: 'uuid' },
  service_view: { service_id: 'uuid', category_id: 'uuid' },
  checkout_started: { service_id: 'uuid', quantity: 'int', has_promo: 'bool' },
  promo_entered: { service_id: 'uuid' },
  orders_view: {},
  wallet_view: {},
  deposit_started: { asset: { enum: ['TON', 'USDT'] }, amount_usd: 'amount' },
  referral_view: {},
  settings_view: {},
}

export const MAX_EVENTS_PER_REQUEST = 20
export const MAX_BODY_BYTES = 8_192

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9_-]{1,40}$/

export interface CleanEvent {
  name: string
  properties: Record<string, string | number | boolean>
}

function cleanValue(spec: PropSpec, value: unknown): string | number | boolean | undefined {
  if (spec === 'bool') return typeof value === 'boolean' ? value : undefined
  if (spec === 'uuid') return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : undefined
  if (spec === 'slug') return typeof value === 'string' && SLUG_RE.test(value) ? value : undefined
  if (spec === 'int') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined
  if (spec === 'amount') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? Math.round(value * 10_000) / 10_000 : undefined
  return typeof value === 'string' && spec.enum.includes(value) ? value : undefined
}

/** One reported event -> a clean event, or null when it must not be stored at all. Never throws. */
export function cleanEvent(raw: unknown): CleanEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name : typeof r.event === 'string' ? r.event : ''
  if (!Object.prototype.hasOwnProperty.call(CLIENT_EVENTS, name)) return null
  const specs = CLIENT_EVENTS[name]
  const props = typeof r.properties === 'object' && r.properties !== null && !Array.isArray(r.properties) ? (r.properties as Record<string, unknown>) : {}
  const properties: CleanEvent['properties'] = {}
  for (const key of Object.keys(specs)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue
    const v = cleanValue(specs[key], props[key])
    if (v !== undefined) properties[key] = v
  }
  return { name, properties }
}

export interface CleanBatch {
  events: CleanEvent[]
  /** How many reported events were not stored (unknown name, not an object, over the batch cap). */
  dropped: number
}

/**
 * The request body -> the events to store. Accepts one event ({ name, properties }) or { events: [...] }.
 * Anything else yields an empty batch. Never throws, whatever the input.
 */
export function cleanBatch(body: unknown): CleanBatch {
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { events: [], dropped: 0 }
    const b = body as Record<string, unknown>
    const list = Array.isArray(b.events) ? b.events : [b]
    const events: CleanEvent[] = []
    for (const item of list.slice(0, MAX_EVENTS_PER_REQUEST)) {
      const e = cleanEvent(item)
      if (e) events.push(e)
    }
    return { events, dropped: Math.min(list.length, 10_000) - events.length }
  } catch {
    return { events: [], dropped: 0 }
  }
}

/** A small per-isolate limiter (the database enforces the real, cross-isolate limit). Keyed by user id. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { start: number; count: number }>()
  return (key: string): boolean => {
    const t = now()
    if (hits.size > 5_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k)
    const h = hits.get(key)
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, count: 1 })
      return true
    }
    h.count++
    return h.count <= limit
  }
}
