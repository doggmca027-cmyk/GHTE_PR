// Structured JSON logger with request correlation (Deno Edge Functions; also runs under Node for tests).
//
// One line of JSON per event:
//   {"ts":"2026-10-07T13:50:00.041Z","level":"error","fn":"place-order","correlation_id":"…","msg":"…",
//    "userId":"…","orderId":"…","providerId":"…","error_code":"…", …more context, "err":{"name","code","message"}}
//
// Rules:
//   * SANITIZED. Nothing sensitive can leave through a log line: values under secret-looking keys, bearer tokens, JWTs,
//     Telegram initData, URLs with credentials, `key=`/`token=` query parameters, any registered secret value
//     (registerSecret) and long opaque tokens are replaced by "[redacted]". Wallet addresses and transaction hashes
//     are shortened ("EQDtFp…p4q2"), never printed in full. Strings, arrays, objects and depth are capped.
//   * NON-BLOCKING and NEVER THROWS. One synchronous console call per event, no I/O, no awaits; any failure while
//     building a line is swallowed (logging must not be able to break a request). Levels below LOG_LEVEL do no work.
//   * The correlation id ties the lines of one request together and travels to the SMM provider calls
//     (x-correlation-id header) and back to the caller (response header).

export type LogLevel = 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }

/** Fields that identify what an event is about. Anything else goes in as extra context. */
export interface LogContext {
  userId?: string | null
  orderId?: string | null
  providerId?: string | null
  /** Machine label of a failure, e.g. `insufficient_provider_balance`, `timeout`, `http_503`. */
  error_code?: string | null
  /** An Error / database error / anything thrown; serialised as { name, code, message } (message sanitized, no stack). */
  err?: unknown
  [field: string]: unknown
}

export interface Logger {
  readonly correlationId: string
  readonly fn: string
  info(msg: string, ctx?: LogContext): void
  warn(msg: string, ctx?: LogContext): void
  error(msg: string, ctx?: LogContext): void
  /** Adds context to every later line of this logger (e.g. userId once the caller is authenticated). */
  bind(ctx: LogContext): Logger
  /** A logger for the same request with extra fixed context (the parent is not changed). */
  child(ctx: LogContext): Logger
}

export interface LoggerOptions {
  fn: string
  correlationId: string
  /** Receives (level, one JSON line). Defaults to console.log / console.warn / console.error. */
  sink?: (level: LogLevel, line: string) => void
  /** Lowest level written. Defaults to the LOG_LEVEL env var, else "info". */
  minLevel?: LogLevel
  now?: () => number
  base?: LogContext
}

// ---------------------------------------------------------------------------
// Correlation id
// ---------------------------------------------------------------------------

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/
export const CORRELATION_HEADER = 'x-correlation-id'

export const isCorrelationId = (v: unknown): v is string => typeof v === 'string' && CORRELATION_ID.test(v)

/** A well-formed inbound id is kept (so a caller can follow its request); anything else is replaced, never echoed. */
export function correlationIdFrom(headers: Pick<Headers, 'get'> | null | undefined): string {
  const inbound = headers?.get(CORRELATION_HEADER)?.trim()
  return inbound && CORRELATION_ID.test(inbound) ? inbound : newCorrelationId()
}

export function newCorrelationId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  }
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

export const REDACTED = '[redacted]'
const MAX_STRING = 500
const MAX_ITEMS = 20
const MAX_KEYS = 40
const MAX_DEPTH = 4

/** Exact secret values (service key, JWT secret, decrypted provider keys...) scrubbed wherever they appear in text. */
const secrets = new Set<string>()
const MAX_SECRETS = 64

/** Registers a secret so it is replaced by [redacted] in every later log line. Short values (< 8) are ignored. */
export function registerSecret(...values: (string | null | undefined)[]): void {
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 8 && secrets.size < MAX_SECRETS) secrets.add(v)
  }
}

/** Test helper. */
export function clearSecrets(): void {
  secrets.clear()
}

// Keys whose value is never printed. Compared after lower-casing and dropping `_`, `-` and spaces.
const SECRET_KEY =
  /(authorization|cookie|token|secret|password|passwd|passphrase|mnemonic|seed|credential|signature|initdata|servicerole|jwt|bearer|key$)/
// ...except these look secret but are public identifiers (a transaction hash is printed shortened, see SHORTEN_KEY).
const SAFE_KEY = /^(idempotencykey|correlationid|publickey|keyname)$/
const SHORTEN_KEY = /(wallet|address|txhash|transactionhash|destination|sender|recipient)$/

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi
const SECRET_PARAM = /([?&;\s]|^)(api[_-]?key|key|token|access[_-]?token|secret|password|auth|signature|hash|init[_-]?data)=[^&\s"']+/gi
const INIT_DATA = /\b(query_id|auth_date)=[^\s]*&[^\s]*/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const LONG_TOKEN = /[A-Za-z0-9_+/=-]{32,}/g

const shorten = (s: string, head = 6, tail = 4): string => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`)

/** Scrubs one piece of text. Exported for tests. */
export function sanitizeText(input: string): string {
  let s = input
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(REDACTED)
  s = s.replace(JWT, REDACTED).replace(BEARER, `$1 ${REDACTED}`).replace(URL_CREDENTIALS, `$1${REDACTED}@`)
  s = s.replace(INIT_DATA, REDACTED).replace(SECRET_PARAM, `$1$2=${REDACTED}`)
  // opaque tokens: long runs without separators. UUIDs (ids, idempotency keys) are fine and kept.
  const uuids: string[] = []
  s = s.replace(UUID, (m) => `\u0000${uuids.push(m) - 1}\u0000`)
  s = s.replace(LONG_TOKEN, (m) => (m.includes('\u0000') ? m : REDACTED))
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => uuids[Number(i)])
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s
}

const normalizeKey = (k: string) => k.toLowerCase().replace(/[\s_-]/g, '')

function sanitizeValue(key: string | null, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (key !== null) {
    const nk = normalizeKey(key)
    if (!SAFE_KEY.test(nk)) {
      if (SHORTEN_KEY.test(nk) && typeof value === 'string') return shorten(value)
      if (SECRET_KEY.test(nk)) return value === null || value === undefined ? value : REDACTED
    }
  }
  switch (typeof value) {
    case 'string':
      return sanitizeText(value)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
    case 'undefined':
      return value
    case 'bigint':
      return value.toString()
    case 'function':
    case 'symbol':
      return undefined
  }
  if (value === null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Error) return serializeError(value)
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => sanitizeValue(null, v, depth + 1, seen))
    return value.length > MAX_ITEMS ? [...items, `…${value.length - MAX_ITEMS} more`] : items
  }
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= MAX_KEYS) {
      out['…'] = 'more keys omitted'
      break
    }
    out[k] = sanitizeValue(k, v, depth + 1, seen)
  }
  return out
}

/** Error-like things (Error, PostgREST / database errors, plain strings) -> { name, code, message }; no stack, no raw objects. */
export function serializeError(e: unknown): { name?: string; code?: string; message: string } {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return { name: e.name, ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}), message: sanitizeText(e.message) }
  }
  if (typeof e === 'object' && e !== null) {
    const o = e as { message?: unknown; code?: unknown; name?: unknown }
    return {
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.code === 'string' || typeof o.code === 'number' ? { code: String(o.code) } : {}),
      message: sanitizeText(typeof o.message === 'string' ? o.message : 'non-error object thrown'),
    }
  }
  return { message: sanitizeText(String(e)) }
}

/** Public for tests: the sanitized copy of any value (what a log line would contain for it). */
export const sanitize = (value: unknown): unknown => sanitizeValue(null, value, 0, new WeakSet())

// ---------------------------------------------------------------------------
// The logger
// ---------------------------------------------------------------------------

const denoEnv = (globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }).Deno?.env

function defaultMinLevel(): LogLevel {
  let raw: string | undefined
  try {
    raw = denoEnv?.get('LOG_LEVEL') ?? (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL
  } catch {
    raw = undefined // env access can be denied; default to info
  }
  const level = raw?.toLowerCase()
  return level === 'warn' || level === 'error' ? level : 'info'
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? defaultSink
  const minRank = LEVEL_RANK[opts.minLevel ?? defaultMinLevel()]
  const now = opts.now ?? Date.now
  const context: LogContext = { ...(opts.base ?? {}) }

  const write = (level: LogLevel, msg: string, ctx?: LogContext): void => {
    if (LEVEL_RANK[level] < minRank) return
    try {
      const merged = { ...context, ...(ctx ?? {}) }
      const { err, ...rest } = merged
      const entry: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        level,
        fn: opts.fn,
        correlation_id: opts.correlationId,
        msg: sanitizeText(String(msg)),
      }
      const clean = sanitizeValue(null, rest, 0, new WeakSet()) as Record<string, unknown>
      for (const [k, v] of Object.entries(clean)) if (v !== undefined && !(k in entry)) entry[k] = v
      if (err !== undefined && err !== null) entry.err = serializeError(err)
      sink(level, JSON.stringify(entry))
    } catch {
      // a log line must never break the request it describes
    }
  }

  const logger: Logger = {
    correlationId: opts.correlationId,
    fn: opts.fn,
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    bind(ctx) {
      Object.assign(context, ctx)
      return logger
    },
    child(ctx) {
      return createLogger({ ...opts, base: { ...context, ...ctx } })
    },
  }
  return logger
}

/** A logger that writes nothing (tests, optional parameters). */
export const silentLogger: Logger = createLogger({ fn: 'silent', correlationId: 'silent-logger', sink: () => {} })
