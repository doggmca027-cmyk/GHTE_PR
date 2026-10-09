// Pure logic of the admin-promos Edge Function: request parsing and the shape sent back. No I/O here, so it is unit-testable.
// The rules the database enforces (promo_codes checks) are checked here first so the admin gets a clear message instead of a constraint error.

export const PROMO_CODE = /^[A-Z0-9_-]{3,32}$/
export const MAX_PROMO_PERCENT = 90
const MAX_PROMO_FIXED = 10_000
const MAX_PROMO_USES = 1_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// no 0/O/1/I: a code read out loud or typed from a screenshot survives
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface CreatePromoInput {
  code: string
  discountType: 'percentage' | 'fixed'
  /** Percent (1..90) or dollars, rounded to 2 decimals. */
  discountValue: number
  maxUses: number | null
  expiresAt: string | null
}

export type ParsedPromoRequest =
  | { action: 'LIST' }
  | ({ action: 'CREATE' } & CreatePromoInput)
  | { action: 'SET_ACTIVE'; id: string; active: boolean }

/** A readable random code like "PROMO-K7M2QX" (the caller passes the random bytes so tests stay deterministic). */
export function generatePromoCode(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return `PROMO-${out}`
}

/** Validates the request body. Returns an error message (shown to the admin) instead of throwing. */
export function parsePromoRequest(body: unknown, randomBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(6)), now: Date = new Date()): ParsedPromoRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : 'LIST'
  if (action === 'LIST') return { action: 'LIST' }

  if (action === 'SET_ACTIVE') {
    if (typeof b.id !== 'string' || !UUID.test(b.id)) return { error: 'Invalid promo code id.' }
    if (typeof b.active !== 'boolean') return { error: 'active must be true or false.' }
    return { action: 'SET_ACTIVE', id: b.id, active: b.active }
  }
  if (action !== 'CREATE') return { error: 'Unknown action.' }

  const rawCode = typeof b.code === 'string' ? b.code.trim().toUpperCase() : ''
  const code = rawCode === '' ? generatePromoCode(randomBytes()) : rawCode
  if (!PROMO_CODE.test(code)) return { error: 'Code: 3 to 32 characters, only A-Z, 0-9, "_" and "-".' }

  if (b.discountType !== 'percentage' && b.discountType !== 'fixed') return { error: 'discountType must be "percentage" or "fixed".' }
  const max = b.discountType === 'percentage' ? MAX_PROMO_PERCENT : MAX_PROMO_FIXED
  if (typeof b.discountValue !== 'number' || !Number.isFinite(b.discountValue) || b.discountValue <= 0 || b.discountValue > max) {
    return { error: `discountValue must be a number above 0 and at most ${max}.` }
  }
  const discountValue = Math.round(b.discountValue * 100) / 100
  if (discountValue <= 0) return { error: 'discountValue is too small.' }

  let maxUses: number | null = null
  if (b.maxUses !== undefined && b.maxUses !== null && b.maxUses !== '') {
    if (typeof b.maxUses !== 'number' || !Number.isInteger(b.maxUses) || b.maxUses < 1 || b.maxUses > MAX_PROMO_USES) return { error: `maxUses must be a whole number from 1 to ${MAX_PROMO_USES}.` }
    maxUses = b.maxUses
  }

  let expiresAt: string | null = null
  if (b.expiresAt !== undefined && b.expiresAt !== null && b.expiresAt !== '') {
    const t = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN
    if (!Number.isFinite(t)) return { error: 'expiresAt must be a date.' }
    if (t <= now.getTime()) return { error: 'The expiry date is already in the past.' }
    expiresAt = new Date(t).toISOString()
  }

  return { action: 'CREATE', code, discountType: b.discountType, discountValue, maxUses, expiresAt }
}

export interface PromoDto {
  id: string
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  maxUses: number | null
  currentUses: number
  expiresAt: string | null
  isActive: boolean
  createdAt: string
}

export function toPromoDto(r: Record<string, unknown>): PromoDto {
  return {
    id: String(r.id),
    code: String(r.code),
    discountType: r.discount_type === 'fixed' ? 'fixed' : 'percentage',
    discountValue: Number(r.discount_value),
    maxUses: r.max_uses == null ? null : Number(r.max_uses),
    currentUses: Number(r.current_uses ?? 0),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
    isActive: r.is_active === true,
    createdAt: String(r.created_at),
  }
}
