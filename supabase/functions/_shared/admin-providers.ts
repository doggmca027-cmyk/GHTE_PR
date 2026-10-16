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
  /** 'publish': the whole catalogue goes on the storefront; 'linked_only': only panel services an admin links. null = keep. */
  catalogMode: 'publish' | 'linked_only' | null
}

export type ParsedProviderRequest =
  | { action: 'LIST_PROVIDERS' }
  | ({ action: 'UPSERT_PROVIDER' } & UpsertProviderInput)
  | { action: 'TOGGLE_ROUTING'; id: string; enabled: boolean }
  | { action: 'ARBITRAGE_STATUS' }
  | { action: 'SET_ARBITRAGE_MODE'; enabled: boolean }
  | { action: 'ARBITRAGE_CANDIDATES'; status: CandidateStatus; offset: number }
  | { action: 'DECIDE_CANDIDATE'; id: string; approve: boolean }
  | { action: 'RUN_ARBITRAGE_MATCH' }

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

/**
 * Addresses a provider host must never resolve to: this network, loopback, private ranges, carrier-grade NAT, link-local (cloud
 * metadata 169.254.169.254 / fd00:ec2::254), benchmarking, multicast / reserved, and IPv4-mapped IPv6 forms of all of them.
 */
export function isBlockedIp(ip: string): boolean {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (!s.includes(':')) return true // not an address at all: refuse
  // IPv4-mapped / -translated: ::ffff:a.b.c.d or ::ffff:7f00:1
  const mappedDotted = /^(?:::ffff:|::ffff:0:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (mappedDotted) return isBlockedIp(mappedDotted[1])
  const mappedHex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16)
    return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (s === '::' || s === '::1') return true
  const first = parseInt(s.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 /* fc00::/7 unique local */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 link-local */ ||
    (first & 0xff00) === 0xff00 /* multicast */ || first === 0 /* ::/8 and other reserved forms */
}

export type DnsResolver = (host: string, type: 'A' | 'AAAA') => Promise<string[]>

/**
 * The second half of the SSRF guard: the NAME must resolve, and only to public addresses. validateProviderUrl() already refused
 * literal private addresses and internal names. With no resolver available (a runtime without DNS) the check is skipped and says so.
 * What it cannot see: a name re-pointed AFTER it was saved (DNS rebinding) - the URL is only re-checked when it is saved again.
 */
export async function checkResolvedHost(apiUrl: string, resolve: DnsResolver | null): Promise<{ ok: true; skipped?: true } | { error: string }> {
  if (!resolve) return { ok: true, skipped: true }
  let host: string
  try {
    host = new URL(apiUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return { error: 'apiUrl must be a valid URL.' }
  }
  const addresses: string[] = []
  for (const type of ['A', 'AAAA'] as const) {
    try {
      addresses.push(...(await resolve(host, type)))
    } catch {
      // no record of this type (or a lookup error): judged on what the other type returns
    }
  }
  if (addresses.length === 0) return { error: 'apiUrl does not resolve to any address.' }
  if (addresses.some(isBlockedIp)) return { error: 'apiUrl resolves to a private or internal address.' }
  return { ok: true }
}

/** Validates the request body. Returns an error message instead of throwing. Unknown fields are ignored. */
export function parseProviderRequest(body: unknown): ParsedProviderRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : ''

  if (action === 'LIST_PROVIDERS' || action === 'ARBITRAGE_STATUS' || action === 'RUN_ARBITRAGE_MATCH') return { action }

  if (action === 'ARBITRAGE_CANDIDATES') {
    const status = b.status === undefined ? 'pending' : b.status
    if (typeof status !== 'string' || !(CANDIDATE_STATUSES as readonly string[]).includes(status)) return { error: 'status must be pending, auto_linked, approved or rejected.' }
    const offset = b.offset === undefined ? 0 : b.offset
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return { error: 'offset must be a whole number >= 0.' }
    return { action, status: status as CandidateStatus, offset }
  }

  if (action === 'DECIDE_CANDIDATE') {
    if (!isUuid(b.id)) return { error: 'id must be a UUID.' }
    if (typeof b.approve !== 'boolean') return { error: 'approve must be true or false.' }
    return { action, id: b.id, approve: b.approve }
  }

  if (action === 'SET_ARBITRAGE_MODE') {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false.' }
    return { action, enabled: b.enabled }
  }

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

    let catalogMode: 'publish' | 'linked_only' | null = null
    if (!absent(b.catalogMode)) {
      if (b.catalogMode !== 'publish' && b.catalogMode !== 'linked_only') return { error: 'catalogMode must be publish or linked_only.' }
      catalogMode = b.catalogMode
    }

    if (id === null && (name === null || apiUrl === null)) return { error: 'name and apiUrl are required for a new provider.' }
    if (id !== null && [name, apiUrl, apiKey, apiVersion, priority, isActive, currency, catalogMode].every((v) => v === null)) return { error: 'Nothing to update.' }
    return { action, id, name, apiUrl, apiKey, apiVersion, priority, isActive, currency, catalogMode }
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
  if (/candidate_not_found/.test(message)) return { status: 404, error: 'candidate_not_found', message: 'This candidate no longer exists. Refresh the list.' }
  if (/candidate_not_pending/.test(message)) return { status: 409, error: 'candidate_not_pending', message: 'This candidate was already decided. Refresh the list.' }
  if (/already_linked/.test(message)) return { status: 409, error: 'already_linked', message: 'This provider already serves this service.' }
  if (/provider_service_inactive/.test(message)) return { status: 409, error: 'provider_service_inactive', message: 'The panel no longer lists this service.' }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: message.replace(/^.*invalid_parameter_value: ?/, '') || 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}

// ---- Automatic matching of cheaper donor services (migration 20261204000000) ------------------------------------------------

export const CANDIDATE_STATUSES = ['pending', 'auto_linked', 'approved', 'rejected'] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

/** One row of admin_arbitrage_candidates() for the app. */
export function toCandidateDto(r: Record<string, unknown>) {
  const n = (v: unknown) => Number(v ?? 0)
  return {
    id: r.id as string,
    status: r.status as CandidateStatus,
    saving: n(r.saving),
    mismatches: Array.isArray(r.mismatches) ? (r.mismatches as string[]) : [],
    currentCost: n(r.current_cost),
    donorCost: n(r.donor_cost),
    service: { id: r.service_id as string, name: r.service_name as string, min: n(r.service_min), max: n(r.service_max) },
    donor: { name: r.donor_name as string, externalId: r.donor_external_id as string, min: n(r.donor_min), max: n(r.donor_max), provider: r.provider_name as string },
  }
}

// ---- Smart Arbitrage (donor networks: catalog_mode = 'linked_only') -------------------------------------------------------

/** A donor the switch may turn on: active, with a stored key. */
export interface ArbitrageDonor {
  id: string
  name: string
}

/** What admin_set_arbitrage_mode receives per donor: ok = the panel answered with a readable balance. */
export interface BalanceReading {
  id: string
  ok: boolean
  balance?: number
  currency?: string
}

/**
 * Asks every donor's panel for its balance at once, so switching on does not wait for the minute monitor. One panel failing
 * (timeout, bad key, unreadable answer) only marks that donor; the others are still read.
 */
export async function readDonorBalances(
  donors: ArbitrageDonor[],
  readBalance: (d: ArbitrageDonor) => Promise<{ balance: number; currency?: string }>,
): Promise<BalanceReading[]> {
  return Promise.all(donors.map(async (d): Promise<BalanceReading> => {
    try {
      const r = await readBalance(d)
      if (!Number.isFinite(r.balance) || r.balance < 0) return { id: d.id, ok: false }
      return { id: d.id, ok: true, balance: r.balance, ...(r.currency && /^[A-Z]{3,10}$/.test(r.currency) ? { currency: r.currency } : {}) }
    } catch {
      return { id: d.id, ok: false }
    }
  }))
}

/** One donor in the answer: ready = it can receive orders now (routing on, panel answered). */
export function toArbitrageDonorDto(r: Record<string, unknown>) {
  const routingEnabled = r.routing_enabled === true
  const healthStatus = String(r.health_status)
  return {
    id: String(r.id), name: String(r.name), isActive: r.is_active === true, routingEnabled, healthStatus,
    balance: Number(r.provider_balance), currency: String(r.currency), lastBalanceSync: (r.last_balance_sync as string | null) ?? null,
    hasApiKey: r.has_api_key === true, activeOffers: Number(r.active_offers),
    ready: routingEnabled && healthStatus === 'healthy',
  }
}

/** What the API returns for a provider: the SQL view's columns in camelCase. There is deliberately no key field, not even encrypted. */
export function toProviderDto(r: Record<string, unknown>) {
  return {
    id: r.id, name: r.name, slug: r.slug, apiUrl: r.api_url, apiVersion: r.api_version,
    isActive: r.is_active === true, routingEnabled: r.routing_enabled === true, priority: Number(r.priority),
    catalogMode: r.catalog_mode === 'publish' ? 'publish' : 'linked_only',
    healthStatus: r.health_status, lastHealthCheck: r.last_health_check ?? null,
    balance: Number(r.provider_balance), currency: r.currency, lastBalanceSync: r.last_balance_sync ?? null,
    lowBalanceThreshold: Number(r.low_balance_threshold), targetTopupBalance: Number(r.target_topup_balance),
    reliabilityPenalty: Number(r.reliability_penalty_multiplier), hasApiKey: r.has_api_key === true,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
