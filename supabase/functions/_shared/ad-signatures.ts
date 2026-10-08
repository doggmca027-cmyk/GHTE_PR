// Signature checks for ad-network server-to-server postbacks. Dependency-free: Web Crypto (crypto.subtle) for HMAC-SHA-256,
// and a small exact MD5 for the networks that still sign with it (Web Crypto deliberately has no MD5).
//
// Every check compares in constant time and answers a plain boolean: a wrong, malformed or missing signature is simply `false`.
// Nothing here throws on attacker-controlled input and nothing returns the expected value.

import { bytesToHex, timingSafeEqual } from './telegram.ts'

const encoder = new TextEncoder()

/** Compares two hex digests of the same algorithm without leaking where they differ. The expected value is normalised first. */
function hexEqual(actualHex: string, expectedHash: unknown): boolean {
  if (typeof expectedHash !== 'string') return false
  const expected = expectedHash.trim().toLowerCase().replace(/^(sha256|md5)=/, '')
  if (!/^[0-9a-f]+$/.test(expected) || expected.length !== actualHex.length) return false
  return timingSafeEqual(encoder.encode(actualHex), encoder.encode(expected))
}

/** hex(HMAC_SHA256(key = secret, data = payload)) through crypto.subtle. */
export async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))))
}

/** True when `expectedHash` is the hex HMAC-SHA-256 of `payload` under `secret`. An empty secret never verifies. */
export async function verifyHmacSha256(payload: string, secret: string, expectedHash: unknown): Promise<boolean> {
  if (!secret) return false
  return hexEqual(await hmacSha256Hex(payload, secret), expectedHash)
}

/** True when `expectedHash` is the hex MD5 of the whole `payloadString` (networks put the secret inside the signed string). */
export function verifyMd5(payloadString: string, expectedHash: unknown): boolean {
  return hexEqual(md5Hex(payloadString), expectedHash)
}

// ---------------------------------------------------------------------------
// MD5 (RFC 1321). Needed only to check signatures that networks already use; never used to protect anything of ours.
// ---------------------------------------------------------------------------
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

export function md5Hex(text: string): string {
  const bytes = encoder.encode(text)
  const bitLength = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLength >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLength / 2 ** 32), true)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let offset = 0; offset < padded.length; offset += 64) {
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true))
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      f = (f + a + K[i] + m[g]) >>> 0
      a = d; d = c; c = b
      b = (b + (((f << S[i]) | (f >>> (32 - S[i]))) >>> 0)) >>> 0
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
  }
  const out = new DataView(new ArrayBuffer(16))
  out.setUint32(0, a0, true); out.setUint32(4, b0, true); out.setUint32(8, c0, true); out.setUint32(12, d0, true)
  return bytesToHex(new Uint8Array(out.buffer))
}
