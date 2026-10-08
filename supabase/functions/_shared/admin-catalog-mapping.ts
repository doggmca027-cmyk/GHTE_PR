// Pure logic of the admin-catalog-mapping Edge Function: request parsing and mapping database errors to HTTP answers.
// No I/O here, so it is unit-testable. The writes themselves are three guarded SQL functions
// (admin_unlinked_provider_services, admin_link_provider_service, admin_create_service_with_offer).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RATE = 1_000_000
const MAX_QUANTITY = 2_147_483_647

export interface ListUnlinkedInput {
  providerId: string | null
  search: string | null
  limit: number
  offset: number
}

export interface LinkInput {
  providerServiceId: string
  serviceId: string
  /** null = the database default (100 for a new primary, otherwise 0). */
  routingScore: number | null
  supportsPartial: boolean
  /** Make this offer the service's primary (services.primary_provider_service_id), the basis sync-catalog prices from. */
  makePrimary: boolean
}

export interface CreateAndLinkInput {
  providerServiceId: string
  categoryId: string
  name: string
  description: string | null
  /** null = priced from the price rules (the same engine sync-catalog uses). */
  customerRatePer1000: number | null
  /** null = the panel's own limit. */
  minQuantity: number | null
  maxQuantity: number | null
  supportsPartial: boolean
}

export type ParsedMappingRequest =
  | ({ action: 'LIST_UNLINKED' } & ListUnlinkedInput)
  | ({ action: 'LINK' } & LinkInput)
  | ({ action: 'CREATE_AND_LINK' } & CreateAndLinkInput)

type Obj = Record<string, unknown>

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const absent = (v: unknown) => v === undefined || v === null || v === ''
const rate4 = (n: number) => Math.round(n * 10_000) / 10_000

function optInt(b: Obj, key: string, min: number, max: number): number | null | { error: string } {
  const v = b[key]
  if (absent(v)) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return { error: `${key} must be an integer from ${min} to ${max}.` }
  return v
}

function optBool(b: Obj, key: string): boolean | { error: string } {
  const v = b[key]
  if (absent(v)) return false
  return typeof v === 'boolean' ? v : { error: `${key} must be true or false.` }
}

const failed = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v

/** Validates the request body. Returns an error message instead of throwing. Unknown fields are ignored. */
export function parseMappingRequest(body: unknown): ParsedMappingRequest | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object.' }
  const b = body as Obj
  const action = typeof b.action === 'string' ? b.action.toUpperCase() : ''

  if (action === 'LIST_UNLINKED') {
    if (!absent(b.providerId) && !isUuid(b.providerId)) return { error: 'providerId must be a UUID.' }
    if (!absent(b.search) && typeof b.search !== 'string') return { error: 'search must be text.' }
    const search = typeof b.search === 'string' ? b.search.trim().slice(0, 100) : ''
    const limit = optInt(b, 'limit', 1, 200)
    const offset = optInt(b, 'offset', 0, 1_000_000)
    if (failed(limit)) return limit
    if (failed(offset)) return offset
    return { action, providerId: absent(b.providerId) ? null : (b.providerId as string), search: search || null, limit: limit ?? 50, offset: offset ?? 0 }
  }

  if (action === 'LINK') {
    if (!isUuid(b.providerServiceId)) return { error: 'providerServiceId must be a UUID.' }
    if (!isUuid(b.serviceId)) return { error: 'serviceId must be a UUID.' }
    const routingScore = optInt(b, 'routingScore', 0, 1000)
    const supportsPartial = optBool(b, 'supportsPartial')
    const makePrimary = optBool(b, 'makePrimary')
    if (failed(routingScore)) return routingScore
    if (failed(supportsPartial)) return supportsPartial
    if (failed(makePrimary)) return makePrimary
    return { action, providerServiceId: b.providerServiceId, serviceId: b.serviceId, routingScore, supportsPartial, makePrimary }
  }

  if (action === 'CREATE_AND_LINK') {
    if (!isUuid(b.providerServiceId)) return { error: 'providerServiceId must be a UUID.' }
    if (!isUuid(b.categoryId)) return { error: 'categoryId must be a UUID.' }
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (name.length < 1 || name.length > 120) return { error: 'name must be 1 to 120 characters.' }
    if (!absent(b.description) && typeof b.description !== 'string') return { error: 'description must be text.' }
    const description = typeof b.description === 'string' ? b.description.trim() : ''
    if (description.length > 1000) return { error: 'description must be at most 1000 characters.' }

    const rawRate = b.customerRatePer1000 ?? b.customerPrice
    let customerRatePer1000: number | null = null
    if (!absent(rawRate)) {
      if (typeof rawRate !== 'number' || !Number.isFinite(rawRate) || rawRate <= 0 || rawRate > MAX_RATE) {
        return { error: `customerRatePer1000 must be a number greater than 0 and at most ${MAX_RATE}.` }
      }
      customerRatePer1000 = rate4(rawRate)
      if (customerRatePer1000 <= 0) return { error: 'customerRatePer1000 is too small.' }
    }

    const minQuantity = optInt(b, 'minQuantity', 1, MAX_QUANTITY)
    const maxQuantity = optInt(b, 'maxQuantity', 1, MAX_QUANTITY)
    const supportsPartial = optBool(b, 'supportsPartial')
    if (failed(minQuantity)) return minQuantity
    if (failed(maxQuantity)) return maxQuantity
    if (failed(supportsPartial)) return supportsPartial
    if (minQuantity !== null && maxQuantity !== null && maxQuantity < minQuantity) return { error: 'maxQuantity must not be below minQuantity.' }
    return {
      action, providerServiceId: b.providerServiceId, categoryId: b.categoryId, name, description: description || null,
      customerRatePer1000, minQuantity, maxQuantity, supportsPartial,
    }
  }

  return { error: 'Unknown action.' }
}

/** A database error (message of the SQL exception) -> the HTTP answer. 500 means "not a business error". */
export function mapMappingError(message: string): { status: number; error: string; message: string } {
  if (/^forbidden:|actor is not an admin/.test(message)) return { status: 403, error: 'forbidden', message: 'Admin access required.' }
  if (/service_not_found/.test(message) && !/provider_service_not_found/.test(message)) return { status: 404, error: 'service_not_found', message: 'Service not found.' }
  if (/provider_service_not_found/.test(message)) return { status: 404, error: 'provider_service_not_found', message: 'Provider service not found.' }
  if (/category_not_found/.test(message)) return { status: 404, error: 'category_not_found', message: 'Category not found or inactive.' }
  if (/already_linked/.test(message)) return { status: 409, error: 'already_linked', message: 'This provider service is already linked to that service.' }
  if (/provider_service_inactive/.test(message)) return { status: 409, error: 'provider_service_inactive', message: 'The provider no longer lists this service.' }
  const overlap = /limits_do_not_overlap: (.*)/.exec(message)
  if (overlap) return { status: 409, error: 'limits_do_not_overlap', message: `Quantity limits do not overlap: ${overlap[1]}.` }
  const exceed = /limits_exceed_panel: (.*)/.exec(message)
  if (exceed) return { status: 409, error: 'limits_exceed_panel', message: `The limits exceed what the provider accepts: ${exceed[1]}.` }
  const cost = /below_cost: (.*)/.exec(message)
  if (cost) return { status: 409, error: 'below_cost', message: `A price below the provider cost would sell at a loss: ${cost[1]}.` }
  if (/invalid_parameter_value/.test(message)) return { status: 400, error: 'invalid_input', message: message.replace(/^.*invalid_parameter_value: ?/, '') || 'Invalid input.' }
  return { status: 500, error: 'server_error', message: 'Something went wrong. Please try again.' }
}
