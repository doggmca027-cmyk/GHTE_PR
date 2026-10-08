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

export type AdminProvidersRequest = ListProvidersRequest | UpsertProviderRequest | ToggleRoutingRequest
