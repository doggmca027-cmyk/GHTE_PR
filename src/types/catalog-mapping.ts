// Request / response shapes of the admin-catalog-mapping Edge Function (POST, admins only). No UI uses them yet.
// A panel service ("provider service") is a row of provider_services; sync-catalog stores them, an admin puts them on the storefront.

/** A panel service nobody sells yet (no offer, not a primary / fallback of any service). */
export interface UnlinkedProviderService {
  id: string
  providerId: string
  providerName: string
  /** The panel's own id for the service. */
  externalServiceId: string
  name: string
  categoryRaw: string
  /** What the panel charges per 1000 units. */
  ratePer1000: number
  minQuantity: number
  maxQuantity: number
  refillSupported: boolean
  cancelSupported: boolean
  lastSyncedAt: string | null
}

export interface ListUnlinkedRequest {
  action: 'LIST_UNLINKED'
  providerId?: string
  /** Matches name, raw category and the panel's service id. */
  search?: string
  /** 1..200, default 50. */
  limit?: number
  offset?: number
}

export interface ListUnlinkedResponse {
  success: true
  items: UnlinkedProviderService[]
  total: number
  limit: number
  offset: number
}

/** Add an offer for an existing storefront service. */
export interface LinkProviderServiceRequest {
  action: 'LINK'
  providerServiceId: string
  serviceId: string
  /** 0..1000, higher wins on equal cost. Default: 100 when makePrimary, otherwise 0. */
  routingScore?: number
  /** The panel can deliver part of an order and refund the rest. Default false. */
  supportsPartial?: boolean
  /** Also make this the service's primary provider service (the basis sync-catalog prices from). Default false. */
  makePrimary?: boolean
}

export interface LinkProviderServiceResponse {
  success: true
  offerId: string
  serviceId: string
  providerServiceId: string
  costPer1000: number
  routingScore: number
  isPrimary: boolean
}

/** Create a storefront service from a panel service and link it, in one transaction. */
export interface CreateAndLinkRequest {
  action: 'CREATE_AND_LINK'
  providerServiceId: string
  categoryId: string
  /** 1..120 characters. */
  name: string
  description?: string
  /** What the customer pays per 1000. Default: computed from the price rules. Must not be below the panel cost. */
  customerRatePer1000?: number
  /** Default: the panel's limits; must lie within them. */
  minQuantity?: number
  maxQuantity?: number
  supportsPartial?: boolean
}

export interface CreateAndLinkResponse {
  success: true
  serviceId: string
  offerId: string
  providerServiceId: string
  customerRatePer1000: number
  costPer1000: number
  minQuantity: number
  maxQuantity: number
}

export type CatalogMappingRequest = ListUnlinkedRequest | LinkProviderServiceRequest | CreateAndLinkRequest

export type CatalogMappingErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'service_not_found'
  | 'provider_service_not_found'
  | 'category_not_found'
  | 'already_linked'
  | 'provider_service_inactive'
  | 'limits_do_not_overlap'
  | 'limits_exceed_panel'
  | 'below_cost'
  | 'server_error'

export interface CatalogMappingError {
  success: false
  error: CatalogMappingErrorCode
  message: string
}
