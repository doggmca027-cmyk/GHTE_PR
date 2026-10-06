// Minimal HS256 JWT signer/verifier (Web Crypto only; Deno + Node compatible).

import { timingSafeEqual } from './telegram.ts'

const encoder = new TextEncoder()

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret: string, usage: 'sign'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export interface JwtClaims {
  sub: string
  [claim: string]: unknown
}

export async function signJwt(
  claims: JwtClaims,
  secret: string,
  ttlSeconds: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ttlSeconds
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ ...claims, iat: now, exp: expiresAt }))
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(`${header}.${payload}`)),
  )
  return { token: `${header}.${payload}.${base64url(signature)}`, expiresAt }
}

export interface VerifiedJwt {
  sub: string
  exp: number
  [claim: string]: unknown
}

/**
 * Verifies an HS256 token minted by signJwt(). Returns the payload, or null for ANY problem
 * (malformed, wrong alg incl. "none", bad signature, expired, wrong audience/role, no sub).
 */
export async function verifyJwt(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifiedJwt | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [h, p, s] = parts

    const header = JSON.parse(new TextDecoder().decode(base64urlDecode(h)))
    if (header?.alg !== 'HS256') return null

    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(`${h}.${p}`)),
    )
    if (!timingSafeEqual(expected, base64urlDecode(s))) return null

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(p)))
    if (typeof payload?.sub !== 'string' || payload.sub === '') return null
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null
    if (payload.aud !== 'authenticated' || payload.role !== 'authenticated') return null
    return payload as VerifiedJwt
  } catch {
    return null
  }
}
