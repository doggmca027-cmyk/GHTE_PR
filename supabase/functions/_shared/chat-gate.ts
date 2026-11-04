// The AI assistant's hourly limit and its log, as the chat-gate Edge Function needs them. Pure (no I/O besides WebCrypto), so it is tested without a
// network. The function is called by the Vercel function api/chat.ts only, with a shared secret; this module cleans everything that comes in.
//
// PRIVACY BY CONSTRUCTION, like analytics.ts: the identifier is a Telegram ID taken from a token WE signed (a forged id is refused), or a keyed hash
// of the IP address (the address is never stored and cannot be recovered from the hash without the secret); the intent is an allow-list of fields;
// the SKUs must look like SKUs; the prompt is cut to 500 characters. Nothing the Vercel side sends goes to the database as it came.

import { verifyJwt } from './jwt.ts'
import { timingSafeEqual } from './telegram.ts'

/** The window of the limit, and how many questions fit into it (AI_CHAT_HOURLY_LIMIT overrides the count). */
export const WINDOW_SECONDS = 3_600
export const DEFAULT_HOURLY_LIMIT = 20
/** The hour of a paying customer (money on the balance, or a completed ledger line): AI_CHAT_PAYING_LIMIT overrides it. */
export const DEFAULT_PAYING_LIMIT = 100
export const MAX_HOURLY_LIMIT = 1_000
export const MAX_BODY_BYTES = 8_192
/** A shorter secret is not a secret: the function refuses to work with it. */
export const MIN_SECRET_LENGTH = 32

export const PROMPT_MAX = 500
const encoder = new TextEncoder()

/** The number of questions per hour: the env value when it is a whole number from 1 to 1000, else 20. */
export function hourlyLimit(raw: string | undefined | null): number {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n >= 1 && n <= MAX_HOURLY_LIMIT ? n : DEFAULT_HOURLY_LIMIT
}

/** The questions per hour of a paying customer: the setting when it is a whole number from 1 to 1000, else 100. Never below the ordinary limit. */
export function payingLimit(raw: string | undefined | null, ordinary: number = DEFAULT_HOURLY_LIMIT): number {
  const n = Number(raw)
  const value = raw && Number.isInteger(n) && n >= 1 && n <= MAX_HOURLY_LIMIT ? n : DEFAULT_PAYING_LIMIT
  return Math.max(value, ordinary)
}

/** The caller sent the shared secret (constant time). An unset or short secret matches nothing. */
export function gateAuthorized(headers: { get(name: string): string | null }, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false
  const sent = headers.get('x-chat-gate-secret')
  return sent !== null && timingSafeEqual(encoder.encode(sent), encoder.encode(secret))
}

// ---- the request ----------------------------------------------------------------------------------------------------------------------------

export interface GateIntent {
  platform: string | null
  actions: string[]
  cheap: boolean
  refill: boolean
  quality: boolean
  geo: string | null
  geoCue: boolean
  quantity: number | null
  audience: 'network' | 'blog' | null
  dislikes: boolean
  words: string[]
}

export interface GateLogEntry {
  prompt: string
  intent: GateIntent
  matched: string[]
  recommended: string[]
  found: number
  toolCalls: number
  model: string | null
}

export type GateRequest =
  | { action: 'check'; ip: string; token: string | null }
  | { action: 'log'; ip: string; token: string | null; entry: GateLogEntry }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{2,59}$/
const WORD_RE = /^[a-z0-9а-яёіїєґ'’-]{1,30}$/i
const SLUG_RE = /^[a-z0-9_-]{1,30}$/

/** Text with no control characters, one line, cut to `max`: a prompt as it is stored. */
export function cleanText(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function strings(raw: unknown, pattern: RegExp, max: number, upper = false): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = upper ? item.toUpperCase() : item
    if (pattern.test(value) && !out.includes(value)) out.push(value)
    if (out.length >= max) break
  }
  return out
}

const bounded = (raw: unknown, max: number): number => (typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), max) : 0)

/** Only the fields the intent has, each with its own shape; anything else is dropped. */
export function cleanIntent(raw: unknown): GateIntent {
  const i = isRecord(raw) ? raw : {}
  const slug = (v: unknown) => (typeof v === 'string' && SLUG_RE.test(v) ? v : null)
  return {
    platform: slug(i.platform),
    actions: strings(i.actions, SLUG_RE, 10),
    cheap: i.cheap === true,
    refill: i.refill === true,
    quality: i.quality === true,
    geo: slug(i.geo),
    geoCue: i.geoCue === true,
    quantity: typeof i.quantity === 'number' && Number.isFinite(i.quantity) && i.quantity >= 1 && i.quantity <= 1_000_000_000 ? Math.trunc(i.quantity) : null,
    audience: i.audience === 'network' || i.audience === 'blog' ? i.audience : null,
    dislikes: i.dislikes === true,
    words: strings(i.words, WORD_RE, 4),
  }
}

/** One line of the log as it will be stored, or null when there is no question in it. */
export function cleanLogEntry(raw: unknown): GateLogEntry | null {
  if (!isRecord(raw)) return null
  const prompt = cleanText(raw.prompt, PROMPT_MAX)
  if (prompt === '') return null
  return {
    prompt,
    intent: cleanIntent(raw.intent),
    matched: strings(raw.matched, SKU_RE, 20, true),
    recommended: strings(raw.recommended, SKU_RE, 10, true),
    found: bounded(raw.found, 1000),
    toolCalls: bounded(raw.toolCalls, 50),
    model: typeof raw.model === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(raw.model) ? raw.model : null,
  }
}

/** A token: the Bearer prefix off, and nothing that could not be a JWT (an HS256 JWT of this app is well under 1 KB). */
function cleanToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.replace(/^Bearer\s+/i, '').trim()
  return token.length > 0 && token.length <= 2_048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null
}

/** The address as the Vercel side saw it: only what an IPv4 / IPv6 address is made of, or "unknown". It is hashed before it is used for anything. */
function cleanIp(raw: unknown): string {
  const ip = typeof raw === 'string' ? raw.replace(/[^0-9a-fA-F:.]/g, '').slice(0, 45) : ''
  return ip === '' ? 'unknown' : ip.toLowerCase()
}

/** The body of a request to the gate, or null when it is not one. */
export function parseGateRequest(body: unknown): GateRequest | null {
  if (!isRecord(body)) return null
  const common = { ip: cleanIp(body.ip), token: cleanToken(body.token) }
  if (body.action === 'check') return { action: 'check', ...common }
  if (body.action === 'log') {
    const entry = cleanLogEntry(body.entry)
    return entry ? { action: 'log', ...common, entry } : null
  }
  return null
}

// ---- who ------------------------------------------------------------------------------------------------------------------------------------

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** HMAC-SHA256 of `message` under `secret`, as hex. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message) as BufferSource))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The identifier the limit and the log use for this caller:
 *   tg:<id>      a signed-in customer; the id is read from a token the app signed (a made-up token is no token)
 *   user:<uuid>  a signed-in customer who has no Telegram id (a website sign-up)
 *   ip:<hash>    a guest: 64 bits of HMAC-SHA256(secret, address), so the address itself is neither stored nor recoverable
 */
export async function identify(who: { ip: string; token: string | null }, secrets: { jwtSecret?: string; gateSecret: string }): Promise<string> {
  return (await identifyCaller(who, secrets)).identifier
}

/** identify(), and the account id of a signed-in customer (null for a guest): the database uses it to tell a paying customer from one who has not paid. */
export async function identifyCaller(who: { ip: string; token: string | null }, secrets: { jwtSecret?: string; gateSecret: string }): Promise<{ identifier: string; userId: string | null }> {
  if (who.token && secrets.jwtSecret) {
    const claims = await verifyJwt(who.token, secrets.jwtSecret)
    if (claims && UUID_RE.test(claims.sub)) {
      const userId = claims.sub.toLowerCase()
      const telegram = Number(claims.telegram_id)
      return { identifier: Number.isSafeInteger(telegram) && telegram > 0 ? `tg:${telegram}` : `user:${userId}`, userId }
    }
  }
  return { identifier: `ip:${(await hmacHex(secrets.gateSecret, `ip:${who.ip}`)).slice(0, 16)}`, userId: null }
}
