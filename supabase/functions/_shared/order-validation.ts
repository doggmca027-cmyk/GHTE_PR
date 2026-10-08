// Order input validation shared by the place-order Edge Function and the frontend
// (src/lib/order-calc.ts re-exports these). The server result is the one that counts.

export const MAX_URL_LENGTH = 2048

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

export const formatInt = (n: number): string => n.toLocaleString('en-US')

export function validateQuantity(raw: string, min: number, max: number): Validation<number> {
  const cleaned = raw.replace(/[\s,]/g, '')
  if (cleaned === '') return { ok: false, error: 'Enter a quantity' }
  if (!/^\d+$/.test(cleaned)) return { ok: false, error: 'Use whole numbers only' }
  const value = Number(cleaned)
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'Quantity is too large' }
  if (value < min) return { ok: false, error: `Minimum is ${formatInt(min)}` }
  if (value > max) return { ok: false, error: `Maximum is ${formatInt(max)}` }
  return { ok: true, value }
}

/**
 * Accepts http(s) links, and bare "t.me/channel"-style links (normalised to https).
 * Rejects whitespace, embedded credentials, single-label hosts and other schemes.
 */
export function validateTargetUrl(raw: string): Validation<string> {
  const text = raw.trim()
  if (text === '') return { ok: false, error: 'Paste the link to promote' }
  if (text.length > MAX_URL_LENGTH) return { ok: false, error: 'Link is too long' }
  if (/\s/.test(text)) return { ok: false, error: 'Link must not contain spaces' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'Link contains invalid characters' }

  const candidate = /^https?:\/\//i.test(text) ? text : /^[\w-]+(\.[\w-]+)+\/\S+/.test(text) ? `https://${text}` : null
  const invalid = { ok: false, error: 'Enter a valid link, e.g. https://t.me/channel' } as const
  if (!candidate) return invalid
  try {
    const url = new URL(candidate)
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return invalid
    if (url.username || url.password) return { ok: false, error: 'Link must not contain a username or password' }
    return { ok: true, value: url.toString() }
  } catch {
    return invalid
  }
}

// ---------------------------------------------------------------------------
// place-order request body
// ---------------------------------------------------------------------------

export interface PlaceOrderInput {
  serviceId: string
  targetUrl: string
  quantity: number
  /** Client-supplied dedupe key (validated), if any. */
  clientKey?: string
  /** A promo code typed by the customer (upper-cased); the database decides whether and how much it takes off. */
  promoCode?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/
const PROMO_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/

export type BodyError = { ok: false; error: 'invalid_input'; message: string }

/**
 * Parses and validates the request body. Only serviceId / targetUrl / quantity /
 * idempotencyKey are read: any client-supplied price, rate, total or user id is ignored.
 */
export function parsePlaceOrderBody(raw: unknown): { ok: true; value: PlaceOrderInput } | BodyError {
  const fail = (message: string): BodyError => ({ ok: false, error: 'invalid_input', message })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('Request body must be a JSON object')
  const body = raw as Record<string, unknown>

  if (typeof body.serviceId !== 'string' || !UUID_RE.test(body.serviceId)) return fail('serviceId must be a UUID')
  if (typeof body.targetUrl !== 'string') return fail('targetUrl is required')
  const url = validateTargetUrl(body.targetUrl)
  if (!url.ok) return fail(url.error)
  if (typeof body.quantity !== 'number' || !Number.isSafeInteger(body.quantity) || body.quantity <= 0) {
    return fail('quantity must be a positive whole number')
  }
  let clientKey: string | undefined
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
    if (typeof body.idempotencyKey !== 'string' || !CLIENT_KEY_RE.test(body.idempotencyKey)) {
      return fail('idempotencyKey must be 8-64 characters of A-Z a-z 0-9 _ -')
    }
    clientKey = body.idempotencyKey
  }
  let promoCode: string | undefined
  if (body.promoCode !== undefined && body.promoCode !== null && body.promoCode !== '') {
    if (typeof body.promoCode !== 'string' || !PROMO_CODE_RE.test(body.promoCode.trim())) return fail('promoCode must be 3-32 characters of A-Z a-z 0-9 _ -')
    promoCode = body.promoCode.trim().toUpperCase()
  }
  return { ok: true, value: { serviceId: body.serviceId.toLowerCase(), targetUrl: url.value, quantity: body.quantity, clientKey, ...(promoCode ? { promoCode } : {}) } }
}

/**
 * The database key is namespaced by user, so one user can never collide with (or probe)
 * another user's keys. Without a client key every request is unique (no dedupe possible).
 */
export function deriveIdempotencyKey(userId: string, clientKey?: string): string {
  return clientKey ? `po:${userId}:${clientKey}` : `po:${userId}:auto:${crypto.randomUUID()}`
}
