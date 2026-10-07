// Secret rotation, pure part (no process, no network): every step goes through an injected Supabase port, so the whole
// procedure is unit-tested. scripts/rotate-secrets.ts wires it to the Supabase Management API.
//
// Rules for every rotation:
//   * a secret value is NEVER printed: plans and logs carry names and a short SHA-256 fingerprint only;
//   * everything that can fail is checked BEFORE the first write (decrypting every stored key, reading the vault, ...);
//   * multi-row database changes are one statement / one transaction (compare-and-set: nothing half-rotated);
//   * the caller decides apply vs dry run; a dry run reads but never writes.

import { createHash, randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, providerKeyEnvName } from '../../supabase/functions/_shared/secrets.ts'

export interface SupabasePort {
  /** Sets Edge Function secrets (Management API POST /v1/projects/{ref}/secrets). */
  setSecrets(secrets: Record<string, string>): Promise<void>
  /** Runs SQL as the database owner (Management API POST /v1/projects/{ref}/database/query). */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>
}

export interface RotationResult {
  /** Human-readable steps, values never included. */
  steps: string[]
  /** Values to write back into the local .env.local, so a later `npm run secrets:push` cannot restore the old ones. */
  envUpdates: Record<string, string>
}

export class RotationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RotationError'
  }
}

/** Short, non-reversible id of a value: lets an operator tell two secrets apart without seeing either. */
export const fingerprint = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 10)}`

/** Cryptographically random secret. base64url: safe in headers, env files and SQL literals. */
export function newRandomSecret(bytes = 32, encoding: 'base64' | 'base64url' = 'base64url'): string {
  return randomBytes(bytes).toString(encoding)
}

/** A SQL string literal; doubles quotes. Values are additionally restricted by the callers' validators. */
export const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`

const SAFE_TOKEN = /^[A-Za-z0-9_\-+/=.:~]{16,512}$/

function assertToken(name: string, value: string): void {
  if (!SAFE_TOKEN.test(value)) throw new RotationError(`${name}: the new value must be 16-512 characters of letters, digits and _-+/=.:~ (no spaces or quotes).`)
}

// ---------------------------------------------------------------------------
// CRON_SECRET: the Edge Function secret AND the Vault copy pg_cron sends (they must match)
// ---------------------------------------------------------------------------

export async function rotateCronSecret(api: SupabasePort, opts: { apply: boolean; newValue?: string }): Promise<RotationResult> {
  const value = opts.newValue ?? newRandomSecret(32)
  assertToken('CRON_SECRET', value)
  const steps: string[] = []
  const vault = await api.query<{ n: number }>(`select count(*)::int as n from vault.secrets where name = 'cron_secret'`)
  const inVault = Number(vault[0]?.n ?? 0) > 0
  steps.push(`new CRON_SECRET ${fingerprint(value)}`)
  steps.push(inVault ? 'update the Vault secret "cron_secret" (read by the pg_cron jobs)' : 'create the Vault secret "cron_secret" (it did not exist)')
  steps.push('set the Edge Function secret CRON_SECRET')
  if (opts.apply) {
    // Vault first, function secret right after: the few seconds in between can cost one worker tick (401), never data.
    await api.query(inVault
      ? `select vault.update_secret(id, ${sqlString(value)}) from vault.secrets where name = 'cron_secret'`
      : `select vault.create_secret(${sqlString(value)}, 'cron_secret')`)
    await api.setSecrets({ CRON_SECRET: value })
  }
  return { steps, envUpdates: { CRON_SECRET: value } }
}

// ---------------------------------------------------------------------------
// PROVIDER_KEY_SECRET: the AES-256 master key of providers.api_key_encrypted. Every stored key is re-encrypted.
// ---------------------------------------------------------------------------

interface EncryptedRow {
  id: string
  name: string
  api_key_encrypted: string
}

export async function rotateProviderKeySecret(
  api: SupabasePort,
  opts: { apply: boolean; oldMaster: string | undefined; newMaster?: string },
): Promise<RotationResult> {
  const newMaster = opts.newMaster ?? newRandomSecret(32, 'base64')
  if (Buffer.from(newMaster, 'base64').length !== 32) throw new RotationError('PROVIDER_KEY_SECRET must be 32 random bytes, base64-encoded.')
  if (opts.oldMaster !== undefined && opts.oldMaster === newMaster) throw new RotationError('The new PROVIDER_KEY_SECRET equals the current one.')
  const rows = await api.query<EncryptedRow>(`select id::text as id, name, api_key_encrypted from providers where api_key_encrypted is not null order by name`)
  const steps = [`new PROVIDER_KEY_SECRET ${fingerprint(newMaster)}`]

  // Everything is decrypted and re-encrypted in memory first: one unreadable key aborts before anything is written.
  const rewritten: { id: string; old: string; next: string }[] = []
  if (rows.length > 0) {
    if (!opts.oldMaster) throw new RotationError(`${rows.length} provider key(s) are stored encrypted, but the current PROVIDER_KEY_SECRET is not in .env.local: nothing was changed.`)
    for (const r of rows) {
      let plain: string
      try {
        plain = await decryptSecret(r.api_key_encrypted, opts.oldMaster)
      } catch {
        throw new RotationError(`The stored key of provider "${r.name}" cannot be decrypted with the current PROVIDER_KEY_SECRET (is .env.local up to date?). Nothing was changed.`)
      }
      rewritten.push({ id: r.id, old: r.api_key_encrypted, next: await encryptSecret(plain, newMaster) })
    }
    steps.push(`re-encrypt ${rows.length} stored provider key(s) in one transaction: ${rows.map((r) => r.name).join(', ')}`)
  } else {
    steps.push('no provider key is stored encrypted: only the master key changes')
  }
  steps.push('set the Edge Function secret PROVIDER_KEY_SECRET')

  if (opts.apply) {
    if (rewritten.length > 0) await api.query(reencryptSql(rewritten))
    await api.setSecrets({ PROVIDER_KEY_SECRET: newMaster })
  }
  return { steps, envUpdates: { PROVIDER_KEY_SECRET: newMaster } }
}

/**
 * One atomic statement. Compare-and-set on the old ciphertext: if any row changed since it was read (someone saved a key
 * meanwhile), the whole block raises and NOTHING is rewritten.
 */
export function reencryptSql(rows: { id: string; old: string; next: string }[]): string {
  const uuid = /^[0-9a-f-]{36}$/i
  const cipher = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/
  for (const r of rows) if (!uuid.test(r.id) || !cipher.test(r.old) || !cipher.test(r.next)) throw new RotationError('unexpected provider key format; nothing was changed.')
  const values = rows.map((r) => `(${sqlString(r.id)}, ${sqlString(r.old)}, ${sqlString(r.next)})`).join(',\n      ')
  return `do $rotate$
declare
  v_count integer;
begin
  update public.providers p
     set api_key_encrypted = v.new_ct
    from (values
      ${values}
    ) as v(id, old_ct, new_ct)
   where p.id = v.id::uuid and p.api_key_encrypted = v.old_ct;
  get diagnostics v_count = row_count;
  if v_count <> ${rows.length} then
    raise exception 'rotation aborted: % of ${rows.length} provider keys matched (a key changed meanwhile); nothing was rewritten', v_count;
  end if;
end
$rotate$;`
}

// ---------------------------------------------------------------------------
// One SMM provider's API key
// ---------------------------------------------------------------------------

export async function rotateProviderApiKey(
  api: SupabasePort,
  opts: { apply: boolean; provider: string; newKey: string; master: string | undefined; store: 'auto' | 'db' | 'env' },
): Promise<RotationResult> {
  assertToken('provider API key', opts.newKey)
  const found = await api.query<{ id: string; name: string; encrypted: boolean }>(
    `select id::text as id, name, api_key_encrypted is not null as encrypted from providers where lower(name) = lower(${sqlString(opts.provider)})`)
  if (found.length === 0) throw new RotationError(`No provider is named "${opts.provider}".`)
  if (found.length > 1) throw new RotationError(`Several providers are named "${opts.provider}"; rename one first.`)
  const p = found[0]
  // resolveProviderApiKey prefers the encrypted copy whenever PROVIDER_KEY_SECRET is set: an env-only update would be ignored.
  const store = opts.store === 'auto' ? (p.encrypted ? 'db' : 'env') : opts.store
  if (store === 'env' && p.encrypted) throw new RotationError(`"${p.name}" has an encrypted key in the database, which takes precedence: rotate it with --store db.`)
  const steps = [`new API key for "${p.name}" ${fingerprint(opts.newKey)}`]

  if (store === 'db') {
    if (!opts.master) throw new RotationError('--store db needs PROVIDER_KEY_SECRET in .env.local to encrypt the key.')
    const ciphertext = await encryptSecret(opts.newKey, opts.master)
    steps.push(`store it encrypted in providers.api_key_encrypted (AES-256-GCM, current PROVIDER_KEY_SECRET ${fingerprint(opts.master)})`)
    if (opts.apply) {
      const rows = await api.query(`update providers set api_key_encrypted = ${sqlString(ciphertext)} where id = ${sqlString(p.id)}::uuid returning id`)
      if (rows.length !== 1) throw new RotationError('the provider row was not updated.')
    }
    return { steps, envUpdates: {} }
  }
  const name = providerKeyEnvName(p.name)
  steps.push(`set the Edge Function secret ${name}`)
  if (opts.apply) await api.setSecrets({ [name]: opts.newKey })
  return { steps, envUpdates: { [name]: opts.newKey } }
}

// ---------------------------------------------------------------------------
// A value issued elsewhere (JWT secret after a dashboard rotation, a new bot token, ...)
// ---------------------------------------------------------------------------

/** Secrets that are generated outside this script and only need to reach the Edge Functions. */
export const SETTABLE = ['JWT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TONCENTER_API_KEY'] as const
export type Settable = (typeof SETTABLE)[number]

export async function setIssuedSecret(api: SupabasePort, opts: { apply: boolean; name: string; value: string }): Promise<RotationResult> {
  if (!(SETTABLE as readonly string[]).includes(opts.name)) throw new RotationError(`set: only ${SETTABLE.join(', ')} can be set this way.`)
  assertToken(opts.name, opts.value)
  if (opts.name === 'JWT_SECRET' && opts.value.length < 32) throw new RotationError('JWT_SECRET must be at least 32 characters (copy it from Dashboard -> Settings -> API).')
  const steps = [`set the Edge Function secret ${opts.name} ${fingerprint(opts.value)}`]
  if (opts.apply) await api.setSecrets({ [opts.name]: opts.value })
  return { steps, envUpdates: { [opts.name]: opts.value } }
}

// ---------------------------------------------------------------------------
// .env.local write-back
// ---------------------------------------------------------------------------

/** Replaces (or appends) NAME=value lines; every other line, comment and blank stays as it was. */
export function applyEnvUpdates(text: string, updates: Record<string, string>): string {
  const lines = text.split(/\r?\n/)
  const done = new Set<string>()
  const out = lines.map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line)
    if (m && m[1] in updates) {
      done.add(m[1])
      return `${m[1]}=${updates[m[1]]}`
    }
    return line
  })
  const missing = Object.keys(updates).filter((k) => !done.has(k))
  if (missing.length > 0) {
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    out.push('', '# rotated by scripts/rotate-secrets.ts', ...missing.map((k) => `${k}=${updates[k]}`), '')
  }
  return out.join('\n')
}
