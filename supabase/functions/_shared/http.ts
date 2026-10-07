// Small helpers shared by user-facing Edge Functions (Deno).
import { verifyJwt } from './jwt.ts'
import { CORRELATION_HEADER, correlationIdFrom, createLogger, type Logger } from './logger.ts'

// Deno global accessed loosely so this file also type-checks under Node (tests / tsc).
const denoEnv = (globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }).Deno?.env

export const corsHeaders = {
  'Access-Control-Allow-Origin': denoEnv?.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': `authorization, x-client-info, apikey, content-type, ${CORRELATION_HEADER}`,
  'Access-Control-Expose-Headers': CORRELATION_HEADER,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** What every instrumented handler receives next to the request. */
export interface RequestContext {
  /** Structured logger bound to this request: every line carries the correlation id. */
  log: Logger
  /** Taken from a well-formed inbound `x-correlation-id`, else generated. Sent on to SMM provider calls and echoed in the response. */
  correlationId: string
}

export type InstrumentedHandler = (req: Request, ctx: RequestContext) => Promise<Response>

export interface InstrumentOptions {
  /** Test seam: build the logger (e.g. with a capturing sink). */
  makeLogger?: (fn: string, correlationId: string) => Logger
  now?: () => number
}

/**
 * Wraps an Edge Function handler: resolves the correlation id, gives the handler a bound logger, sets
 * `x-correlation-id` on the response, writes one summary line per request (method, status, duration) and turns an
 * escaped exception into a generic 500 (nothing internal in the body). The handler's own behaviour is unchanged.
 */
export function instrument(fn: string, handler: InstrumentedHandler, opts: InstrumentOptions = {}): (req: Request) => Promise<Response> {
  const now = opts.now ?? Date.now
  return async (req) => {
    const started = now()
    const correlationId = correlationIdFrom(req.headers)
    const log = opts.makeLogger ? opts.makeLogger(fn, correlationId) : createLogger({ fn, correlationId })
    let res: Response
    try {
      res = await handler(req, { log, correlationId })
    } catch (e) {
      log.error('unhandled exception', { err: e, error_code: 'unhandled' })
      res = fail(500, 'server_error', 'Something went wrong. Please try again.')
    }
    const headers = new Headers(res.headers)
    headers.set(CORRELATION_HEADER, correlationId)
    const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    if (req.method !== 'OPTIONS') {
      const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info'
      log[level]('request', { method: req.method, status: res.status, duration_ms: now() - started })
    }
    return out
  }
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response =>
  json({ success: false, error, message, ...extra }, status)

/** User id from the Bearer JWT issued by telegram-auth, or null. The body is never trusted for identity. */
export async function authenticate(req: Request, jwtSecret: string): Promise<string | null> {
  const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const claims = token ? await verifyJwt(token, jwtSecret) : null
  return claims?.sub ?? null
}

/** Reads and parses a small JSON body. Returns null on any problem. */
export async function readJson(req: Request, maxBytes = 4096): Promise<unknown | null> {
  const raw = await req.text()
  if (raw.length > maxBytes) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
