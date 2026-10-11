// Request / response shapes of the admin-providers Edge Function (POST, admins only). No UI uses them yet.
// The API key only ever travels one way: in UPSERT_PROVIDER's apiKey. No response carries it, not even encrypted;
// the provider exposes hasApiKey instead.

export interface AdminProvider {
  id: string
  name: string
  slug: string
  apiUrl: string
  apiVersion: string
  isActive: boolean
  /** Whether the provider receives orders. A new provider starts with this off. */
  routingEnabled: boolean
  priority: number
  /** 'publish': the whole catalogue is put on the storefront; 'linked_only': only the panel services linked to storefront services. */
  catalogMode: 'publish' | 'linked_only'
  healthStatus: 'healthy' | 'degraded' | 'unavailable' | 'disabled'
  lastHealthCheck: string | null
  balance: number
  currency: string
  lastBalanceSync: string | null
  lowBalanceThreshold: number
  targetTopupBalance: number
  /** 1..10, kept by provider-health-monitor. */
  reliabilityPenalty: number
  hasApiKey: boolean
  createdAt: string
  updatedAt: string
}

export interface ListProvidersRequest {
  action: 'LIST_PROVIDERS'
}

export interface ListProvidersResponse {
  success: true
  providers: AdminProvider[]
}

/** Without id: creates (name and apiUrl required). With id: updates only the fields that are sent. */
export interface UpsertProviderRequest {
  action: 'UPSERT_PROVIDER'
  id?: string
  name?: string
  /** https and a public host only. */
  apiUrl?: string
  /** The raw key. Empty or missing keeps the stored key. Encrypted by the server; never returned. */
  apiKey?: string
  /** For example 'v2'. */
  apiVersion?: string
  priority?: number
  /** Switching a provider off also switches its routing off. */
  isActive?: boolean
  currency?: string
  catalogMode?: 'publish' | 'linked_only'
}

export interface UpsertProviderResponse {
  success: true
  created: boolean
  provider: AdminProvider
}

/** Enabling needs an active provider with a stored key. */
export interface ToggleRoutingRequest {
  action: 'TOGGLE_ROUTING'
  id: string
  enabled: boolean
}

export interface ToggleRoutingResponse {
  success: true
  provider: AdminProvider
}

/** A donor network of Smart Arbitrage: a provider with catalog_mode 'linked_only' (it only serves linked storefront services). */
export interface ArbitrageDonor {
  id: string
  name: string
  isActive: boolean
  routingEnabled: boolean
  healthStatus: AdminProvider['healthStatus']
  balance: number
  currency: string
  lastBalanceSync: string | null
  hasApiKey: boolean
  /** Active offers linked to storefront services. */
  activeOffers: number
  /** Routing on and the panel answered: it can receive orders now (as far as its balance goes). */
  ready: boolean
}

export interface ArbitrageStatus {
  /** At least one donor has routing on. */
  enabled: boolean
  /** The primary networks (catalog_mode 'publish'); the switch never touches them. */
  primary: { id: string; name: string; routingEnabled: boolean; healthStatus: AdminProvider['healthStatus'] }[]
  donors: ArbitrageDonor[]
}

export interface SetArbitrageModeRequest {
  action: 'SET_ARBITRAGE_MODE'
  enabled: boolean
}

export interface SetArbitrageModeResponse {
  success: true
  enabled: boolean
  /** Donors left as they were when switching on: inactive, or without an API key. */
  skipped: { id: string; name: string; reason: 'inactive' | 'no_api_key' }[]
  donors: ArbitrageDonor[]
}

export type AdminProvidersRequest = ListProvidersRequest | UpsertProviderRequest | ToggleRoutingRequest | { action: 'ARBITRAGE_STATUS' } | SetArbitrageModeRequest
