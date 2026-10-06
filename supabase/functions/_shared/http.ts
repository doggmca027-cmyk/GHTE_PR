// Small helpers shared by user-facing Edge Functions (Deno).
import { verifyJwt } from './jwt.ts'

// Deno global accessed loosely so this file also type-checks under Node (tests / tsc).
const denoEnv = (globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }).Deno?.env

export const corsHeaders = {
  'Access-Control-Allow-Origin': denoEnv?.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
