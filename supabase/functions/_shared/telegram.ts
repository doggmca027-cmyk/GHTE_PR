// Telegram WebApp initData verification.
// Uses only Web Crypto + URLSearchParams, so it runs unchanged in Deno (Edge
// Functions) and Node (vitest). Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

export type TelegramAuthErrorCode =
  | 'missing_init_data'
  | 'malformed_init_data'
  | 'missing_hash'
  | 'invalid_hash'
  | 'invalid_signature'
  | 'invalid_auth_date'
  | 'expired'
  | 'invalid_user'

export class TelegramAuthError extends Error {
  readonly code: TelegramAuthErrorCode
  constructor(code: TelegramAuthErrorCode, message: string) {
    super(message)
    this.name = 'TelegramAuthError'
    this.code = code
  }
}

export interface TelegramUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
}

export interface VerifiedInitData {
  user: TelegramUser
  authDate: number
  queryId?: string
}

export interface VerifyOptions {
  /** Max accepted age of auth_date, in seconds. Default: 24h. */
  maxAgeSeconds?: number
  /** Current unix time in seconds (injectable for tests). */
  now?: number
  /** Tolerated clock skew for auth_date in the future, in seconds. */
  clockSkewSeconds?: number
}

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60
const encoder = new TextEncoder()

async function hmacSha256(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Constant-time comparison: always walks max(a, b) bytes and folds the length
 * difference into the accumulator, so timing leaks neither content nor length.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** Telegram's data-check-string: all fields except `hash`, sorted by key, `key=value`, joined by \n. */
export function buildDataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** hex(HMAC_SHA256(key = HMAC_SHA256("WebAppData", botToken), data = dataCheckString)) */
export async function computeInitDataHash(dataCheckString: string, botToken: string): Promise<string> {
  const secretKey = await hmacSha256('WebAppData', botToken)
  return bytesToHex(await hmacSha256(secretKey, dataCheckString))
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  options: VerifyOptions = {},
): Promise<VerifiedInitData> {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const skew = options.clockSkewSeconds ?? 60
  const now = options.now ?? Math.floor(Date.now() / 1000)

  if (!initData) throw new TelegramAuthError('missing_init_data', 'initData is empty')
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured')

  const params = new URLSearchParams(initData)
  const keys = [...params.keys()]
  if (new Set(keys).size !== keys.length) {
    throw new TelegramAuthError('malformed_init_data', 'duplicate fields in initData')
  }

  const receivedHash = params.get('hash')
  if (!receivedHash) throw new TelegramAuthError('missing_hash', 'hash is missing')
  if (!/^[0-9a-f]{64}$/i.test(receivedHash)) {
    throw new TelegramAuthError('invalid_hash', 'hash must be 64 hex characters')
  }

  // 1. Signature (constant-time) - checked before anything else is trusted.
  const expected = await computeInitDataHash(buildDataCheckString(params), botToken)
  if (!timingSafeEqual(hexToBytes(expected), hexToBytes(receivedHash.toLowerCase()))) {
    throw new TelegramAuthError('invalid_signature', 'signature mismatch')
  }

  // 2. Freshness.
  const authDateRaw = params.get('auth_date')
  const authDate = authDateRaw && /^\d{1,12}$/.test(authDateRaw) ? Number(authDateRaw) : NaN
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new TelegramAuthError('invalid_auth_date', 'auth_date is missing or invalid')
  }
  if (authDate - now > skew) throw new TelegramAuthError('invalid_auth_date', 'auth_date is in the future')
  if (now - authDate > maxAge) throw new TelegramAuthError('expired', 'initData has expired')

  // 3. User payload.
  let user: TelegramUser
  try {
    user = JSON.parse(params.get('user') ?? '') as TelegramUser
  } catch {
    throw new TelegramAuthError('invalid_user', 'user is missing or not valid JSON')
  }
  if (!user || typeof user !== 'object' || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new TelegramAuthError('invalid_user', 'user.id is invalid')
  }

  return { user, authDate, queryId: params.get('query_id') ?? undefined }
}
