// AES-256-GCM envelope for providers.api_key_encrypted.
// Format: "v1:<base64 iv>:<base64 ciphertext+tag>". The master key (32 bytes, base64) lives
// ONLY in the PROVIDER_KEY_SECRET Edge Function secret, never in the database or the repo.

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(masterKeyB64)
  if (raw.length !== 32) throw new Error('PROVIDER_KEY_SECRET must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptSecret(plaintext: string, masterKeyB64: string): Promise<string> {
  const key = await importKey(masterKeyB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext)),
  )
  return `v1:${b64encode(iv)}:${b64encode(ct)}`
}

export async function decryptSecret(payload: string, masterKeyB64: string): Promise<string> {
  const [version, iv, ct] = payload.split(':')
  if (version !== 'v1' || !iv || !ct) throw new Error('unsupported secret format')
  const key = await importKey(masterKeyB64)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(iv) as BufferSource },
    key,
    b64decode(ct) as BufferSource,
  )
  return new TextDecoder().decode(pt)
}

/** Env var name for a provider's plaintext key fallback, e.g. "Secsers Mock" -> PROVIDER_SECSERS_MOCK_API_KEY. */
export function providerKeyEnvName(providerName: string): string {
  return `PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_API_KEY`
}

/** Decrypts providers.api_key_encrypted with PROVIDER_KEY_SECRET, else falls back to PROVIDER_<NAME>_API_KEY. Returns '' if none. */
export async function resolveProviderApiKey(
  provider: { name: string; api_key_encrypted: string | null },
  env: { get(name: string): string | undefined },
): Promise<string> {
  const master = env.get('PROVIDER_KEY_SECRET')
  if (provider.api_key_encrypted && master) return await decryptSecret(provider.api_key_encrypted, master)
  return env.get(providerKeyEnvName(provider.name)) ?? ''
}
