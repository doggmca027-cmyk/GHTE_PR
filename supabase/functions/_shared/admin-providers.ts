// Pure logic of the admin-providers Edge Function: request parsing and mapping database errors to HTTP answers.
// No I/O here, so it is unit-testable. The writes are three guarded SQL functions
// (admin_providers_list, admin_upsert_provider, admin_set_provider_routing); the API key is encrypted by the function
// (secrets.ts, AES-256-GCM) before it reaches SQL, so the database only ever sees ciphertext.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface UpsertProviderInput {
  /** null = create a new provider. */
  id: string | null
  name: string | null
  apiUrl: string | null
  /** The RAW key. null = keep the stored one. Must be encrypted and then dropped by the caller; never logged or echoed. */
  apiKey: string | null
  apiVersion: string | null
  priority: number | null
  isActive: boolean | null
  currency: string | null
}

export type ParsedProviderRequest =
  | { action: 'LIST_PROVIDERS' }
  | ({ action: 'UPSERT_PROVIDER' } & UpsertProviderInput)
  | { action: 'TOGGLE_ROUTING'; id: string; enabled: boolean }

type Obj = Record<string, unknown>

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const absent = (v: unknown) => v === undefined || v === null || v === ''

/**
 * A provider URL is called by our servers, so it must not be a way to reach our own network: https only, no credentials in
 * the URL, and no localhost / private / link-local literal addresses. Returns the normalised URL (no trailing slash) or an error.
 */
export function validateProviderUrl(raw: string): { url: string } | { error: string } {
  const text = raw.trim()
  if (text.length > 300) return { error: 'apiUrl must be at most 300 characters.' }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { error: 'apiUrl must be a valid URL.' }
  }
  if (u.protocol !== 'https:') return { error: 'apiUrl must start with https://.' }
  if (u.username || u.password) return { error: 'apiUrl must not contain a username or password.' }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  const privateV4 = v4 && (() => {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  })()
  const blockedName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')
  const blockedV6 = host.includes(':')
  if (privateV4 || blockedName || blockedV6) return { error: 'apiUrl must point to a public host name.' }
  return { url: `${u.origin}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}${u.search}` }
}

/** Validates the request body. Returns an error message instead of throwing. Unknown fields are ignored. */
export function parseProviderRequest(body: unknown): ParsedProviderRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : ''

  if (action === 'LIST_PROVIDERS') return { action }

  if (action === 'TOGGLE_ROUTING') {
    if (!isUuid(b.id)) return { error: 'id must be a UUID.' }
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false.' }
    return { action, id: b.id, enabled: b.enabled }
  }

  if (action === 'UPSERT_PROVIDER') {
    if (!absent(b.id) && !isUuid(b.id)) return { error: 'id must be a UUID.' }
    const id = absent(b.id) ? null : (b.id as string)

    let name: string | null = null
    if (!absent(b.name)) {
      if (typeof b.name !== 'string') return { error: 'name must be text.' }
      name = b.name.trim()
      if (name.length < 1 || name.length > 80) return { error: 'name must be 1 to 80 characters.' }
    }

    let apiUrl: string | null = null
    if (!absent(b.apiUrl)) {
      if (typeof b.apiUrl !== 'string') return { error: 'apiUrl must be text.' }
      const v = validateProviderUrl(b.apiUrl)
      if ('error' in v) return v
      apiUrl = v.url
    }

    // An empty key means "keep the current one" (the admin only edited the name or the URL).
    let apiKey: string | null = null
    if (!absent(b.apiKey)) {
      if (typeof b.apiKey !== 'string') return { error: 'apiKey must be text.' }
      apiKey = b.apiKey.trim()
      if (apiKey.length < 8 || apiKey.length > 512) return { error: 'apiKey must be 8 to 512 characters.' }
      if (/\s/.test(apiKey)) return { error: 'apiKey must not contain spaces.' }
    }

    let apiVersion: string | null = null
    if (!absent(b.apiVersion)) {
      if (typeof b.apiVersion !== 'string' || !/^v[0-9]+$/.test(b.apiVersion.trim())) return { error: 'apiVersion must look like v2.' }
      apiVersion = b.apiVersion.trim()
    }

    let priority: number | null = null
    if (!absent(b.priority)) {
      if (typeof b.priority !== 'number' || !Number.isInteger(b.priority) || Math.abs(b.priority) > 10_000) return { error: 'priority must be an integer from -10000 to 10000.' }
      priority = b.priority
    }

    let isActive: boolean | null = null
    if (!absent(b.isActive)) {
      if (typeof b.isActive !== 'boolean') return { error: 'isActive must be true or false.' }
      isActive = b.isActive
    }

    let currency: string | null = null
    if (!absent(b.currency)) {
      if (typeof b.currency !== 'string' || !/^[A-Za-z]{3,10}$/.test(b.currency.trim())) return { error: 'currency must be 3 to 10 letters.' }
      currency = b.currency.trim().toUpperCase()
    }

    if (id === null && (name === null || apiUrl === null)) return { error: 'name and apiUrl are required for a new provider.' }
    if (id !== null && [name, apiUrl, apiKey, apiVersion, priority, isActive, currency].every((v) => v === null)) return { error: 'Nothing to update.' }
    return { action, id, name, apiUrl, apiKey, apiVersion, priority, isActive, currency }
  }

  return { error: 'Unknown action.' }
}

/** A database error (message of the SQL exception) -> the HTTP answer. 500 means "not a business error". */
export function mapProviderError(message: string): { status: number; error: string; message: string } {
  if (/^forbidden:|actor is not an admin/.test(message)) return { status: 403, error: 'forbidden', message: 'Admin access required.' }
  if (/provider_not_found/.test(message)) return { status: 404, error: 'provider_not_found', message: 'Provider not found.' }
  if (/name_taken/.test(message)) return { status: 409, error: 'name_taken', message: 'A provider with this name already exists.' }
  if (/provider_inactive/.test(message)) return { status: 409, error: 'provider_inactive', message: 'An inactive provider cannot receive orders.' }
  if (/no_api_key/.test(message)) return { status: 409, error: 'no_api_key', message: 'Save the API key of the provider before switching routing on.' }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: message.replace(/^.*invalid_parameter_value: ?/, '') || 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

/** What the API returns for a provider: the SQL view's columns in camelCase. There is deliberately no key field, not even encrypted. */
export function toProviderDto(r: Record<string, unknown>) {
  return {
    id: r.id, name: r.name, slug: r.slug, apiUrl: r.api_url, apiVersion: r.api_version,
    isActive: r.is_active === true, routingEnabled: r.routing_enabled === true, priority: Number(r.priority),
    healthStatus: r.health_status, lastHealthCheck: r.last_health_check ?? null,
    balance: Number(r.provider_balance), currency: r.currency, lastBalanceSync: r.last_balance_sync ?? null,
    lowBalanceThreshold: Number(r.low_balance_threshold), targetTopupBalance: Number(r.target_topup_balance),
    reliabilityPenalty: Number(r.reliability_penalty_multiplier), hasApiKey: r.has_api_key === true,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
