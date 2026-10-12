// Password hashing, one-time codes and input rules of the web sign-in (Web Crypto only: Deno and Node).
//
//   passwords   PBKDF2-HMAC-SHA-256, 210 000 iterations (OWASP 2023), 16 random bytes of salt, 32-byte key, stored as
//               "pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>"; verified in constant time. The iteration count travels with the
//               hash, so it can be raised later without invalidating old passwords (needsRehash tells when).
//   codes       6 decimal digits from the CSPRNG without modulo bias; only HMAC-SHA-256(secret, purpose|email|code) is stored, so a
//               database leak does not reveal live codes (10^6 values would be trivial to brute-force from a plain hash).

import { timingSafeEqual } from './telegram.ts'

export const PBKDF2_ITERATIONS = 210_000
const SALT_BYTES = 16
const KEY_BYTES = 32
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128
export const CODE_LENGTH = 6

const encoder = new TextEncoder()

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function unb64(text: string): Uint8Array {
  const bin = atob(text)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Constant-time comparison of two strings (length differences included). */
export const safeEq = (a: string, b: string): boolean => timingSafeEqual(encoder.encode(a), encoder.encode(b))

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, KEY_BYTES * 8)
  return new Uint8Array(bits)
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  return `pbkdf2_sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`
}

const STORED = /^pbkdf2_sha256\$(\d{6,7})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/

/** True when `password` matches the stored hash. A malformed hash is simply "no". */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const m = STORED.exec(stored ?? '')
  if (!m) return false
  const iterations = Number(m[1])
  if (iterations < 100_000 || iterations > 5_000_000) return false
  try {
    const actual = await pbkdf2(password, unb64(m[2]), iterations)
    return timingSafeEqual(actual, unb64(m[3]))
  } catch {
    return false
  }
}

/** Spends the same time as a real check: used when there is no account, so timing does not tell whether one exists. */
let dummyHash: Promise<string> | null = null
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing')
  await verifyPassword(password, await dummyHash)
}

export const needsRehash = (stored: string): boolean => Number(STORED.exec(stored)?.[1] ?? 0) < PBKDF2_ITERATIONS

/** A uniformly random 6-digit code (leading zeros kept). */
export function generateOtpCode(): string {
  const limit = 4_294_000_000 // largest multiple of 10^6 below 2^32: values above it are redrawn (no modulo bias)
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(CODE_LENGTH, '0')
  }
}

export type CodePurpose = 'register_verify' | 'login_code' | 'reset_password' | 'link_email'

/** HMAC-SHA-256 of purpose|email|code under a server secret, hex. The same code for another address or purpose hashes differently. */
export async function hashOtpCode(email: string, purpose: CodePurpose, code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}|${normalizeEmail(email)}|${code}`) as BufferSource)
  return hex(new Uint8Array(mac))
}

export const isOtpCode = (v: unknown): v is string => typeof v === 'string' && /^\d{6}$/.test(v)

/** Trimmed and lower-cased (addresses are compared case-insensitively everywhere). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** A practical, strict address rule (the database applies the same one): local@domain.tld, ASCII, at most 254 characters. */
export function isValidEmail(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const email = normalizeEmail(raw)
  if (email.length < 6 || email.length > 254) return false
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return false
  const [local, domain] = email.split('@')
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  return domain.split('.').every((label) => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'))
}

/** null when the password is acceptable, else the reason. */
export function passwordProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Password must be text.'
  if (raw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`
  if (raw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`
  if (raw.trim().length === 0) return 'Password must not be only spaces.'
  return null
}
