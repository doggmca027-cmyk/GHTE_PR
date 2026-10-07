// Standard "SMM v2" panel API adapter.
// SERVER-SIDE ONLY: it holds a provider API key. Never import it from frontend
// code; instantiate it inside Edge Functions with keys from environment secrets.

import type {
  ICreateOrderParams,
  IProviderBalance,
  IProviderOrderStatus,
  IProviderService,
  ISMMProviderAdapter,
} from './types.ts'
import { DEFAULT_SMM_V2_CAPABILITIES, type ProviderCapabilities } from './types.ts'
import type { BatchStatusEntry, OrderStatus } from './types.ts'
import { CORRELATION_HEADER, isCorrelationId, type Logger } from './logger.ts'

export type SMMErrorKind =
  | 'misconfigured'
  | 'timeout'
  | 'network'
  | 'http'
  | 'api'
  | 'invalid_response'

export type SMMErrorCode =
  | 'invalid_api_key'
  | 'insufficient_provider_balance'
  | 'invalid_service'
  | 'invalid_link'
  | 'invalid_quantity'
  | 'order_not_found'
  | 'rate_limited'
  | 'unknown'

export class SMMProviderError extends Error {
  readonly kind: SMMErrorKind
  readonly code: SMMErrorCode
  /** Safe to retry the same call. */
  readonly retryable: boolean
  /**
   * The outcome is unknown: a state-changing call (`add`) timed out or lost the
   * connection, so the panel MAY have created the order. Reconcile before retrying.
   */
  readonly ambiguous: boolean
  readonly httpStatus?: number

  constructor(
    kind: SMMErrorKind,
    message: string,
    extra: { code?: SMMErrorCode; retryable?: boolean; ambiguous?: boolean; httpStatus?: number } = {},
  ) {
    super(message)
    this.name = 'SMMProviderError'
    this.kind = kind
    this.code = extra.code ?? 'unknown'
    this.retryable = extra.retryable ?? false
    this.ambiguous = extra.ambiguous ?? false
    this.httpStatus = extra.httpStatus
  }
}

export interface SMMv2AdapterConfig {
  id: string
  name: string
  apiUrl: string
  apiKey?: string
  /** Force mock mode. Mock mode is also used whenever apiKey is empty. */
  mockMode?: boolean
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Clock for mock order progression (tests). */
  now?: () => number
  /** Overrides for what this panel is known to support (defaults: DEFAULT_SMM_V2_CAPABILITIES). */
  capabilities?: Partial<ProviderCapabilities>
  /** Sent to the panel as `x-correlation-id` on every call, so a request can be followed across systems. Malformed ids are not sent. */
  correlationId?: string
  /** Receives one warn line per failed provider call (provider, action, error kind/code, status, latency). Never the key or the body. */
  logger?: Logger
}

/** Builds an adapter honouring MOCK_MODE from the given env map (e.g. Deno.env.toObject()). */
export function createSMMv2Adapter(
  config: Omit<SMMv2AdapterConfig, 'mockMode'>,
  env: Record<string, string | undefined> = {},
): SMMv2Adapter {
  return new SMMv2Adapter({ ...config, mockMode: env.MOCK_MODE === 'true' })
}

const DEFAULT_TIMEOUT_MS = 10_000

const STATUS_MAP: Record<string, OrderStatus> = {
  pending: 'submitted',
  processing: 'in_progress',
  'in progress': 'in_progress',
  inprogress: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  partial: 'partial',
  canceled: 'canceled',
  cancelled: 'canceled',
  fail: 'failed',
  failed: 'failed',
  error: 'failed',
}

export function mapProviderStatus(raw: string): OrderStatus {
  const mapped = STATUS_MAP[raw.trim().toLowerCase()]
  if (!mapped) throw new SMMProviderError('invalid_response', `Unknown order status "${raw}"`)
  return mapped
}

function classifyApiError(message: string): SMMErrorCode {
  const m = message.toLowerCase()
  if (/(incorrect|invalid|wrong).*(api\s*)?key|key.*(invalid|incorrect)|unauthori[sz]ed/.test(m)) return 'invalid_api_key'
  if (/(not enough|insufficient|low).*(fund|balance)|balance.*(low|insufficient)/.test(m)) return 'insufficient_provider_balance'
  if (/(incorrect|invalid|wrong|not found).*service|service.*(not found|incorrect|invalid|disabled)/.test(m)) return 'invalid_service'
  if (/(incorrect|invalid|wrong).*link|link.*(invalid|incorrect)/.test(m)) return 'invalid_link'
  if (/(incorrect|invalid|wrong).*quantity|quantity.*(less|more|incorrect|invalid)|min.*max/.test(m)) return 'invalid_quantity'
  if (/(incorrect|invalid|not found).*order|order.*not found/.test(m)) return 'order_not_found'
  if (/(too many|rate limit)/.test(m)) return 'rate_limited'
  return 'unknown'
}

function toNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) throw new SMMProviderError('invalid_response', `Field "${field}" is not a number`)
  return n
}

function toOptionalNumber(value: unknown, field: string): number | undefined {
  return value === undefined || value === null || value === '' ? undefined : toNumber(value, field)
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Maps one status object (single or batch form) to our shape; throws invalid_response if unusable. */
function parseStatusObject(orderId: string, data: Record<string, unknown>): IProviderOrderStatus {
  if (typeof data.status !== 'string') throw new SMMProviderError('invalid_response', 'status: response has no status')
  return {
    orderId,
    rawStatus: data.status,
    status: mapProviderStatus(data.status),
    charge: toOptionalNumber(data.charge, 'charge'),
    currency: typeof data.currency === 'string' ? data.currency : undefined,
    startCount: toOptionalNumber(data.start_count, 'start_count'),
    remains: toOptionalNumber(data.remains, 'remains'),
  }
}

/**
 * Parses a multi-order status reply. Standard SMM v2 returns an object keyed by order id:
 *   { "1": { charge, start_count, status, remains, currency }, "2": { "error": "Incorrect order ID" } }
 * Also tolerated: an array of objects carrying an "order" field, and (for a single requested id) a bare
 * status object. Every requested id gets an entry; ids the panel did not answer become an error entry,
 * so a missing answer can never be mistaken for a terminal status.
 */
export function parseBatchStatusResponse(data: unknown, requestedIds: string[]): Record<string, BatchStatusEntry> {
  let byId: Record<string, unknown> = {}
  if (Array.isArray(data)) {
    for (const item of data) if (isRecord(item) && item.order !== undefined) byId[String(item.order)] = item
  } else if (isRecord(data)) {
    byId = requestedIds.length === 1 && typeof data.status === 'string' && !(requestedIds[0] in data) ? { [requestedIds[0]]: data } : data
  } else {
    throw new SMMProviderError('invalid_response', 'status: expected an object')
  }

  const out: Record<string, BatchStatusEntry> = {}
  for (const id of requestedIds) {
    const entry = byId[id]
    if (!isRecord(entry)) {
      out[id] = { ok: false, error: 'No status returned for this order', code: 'order_not_found' }
    } else if (typeof entry.error === 'string') {
      out[id] = { ok: false, error: entry.error.slice(0, 200), code: classifyApiError(entry.error) }
    } else {
      try {
        out[id] = { ok: true, status: parseStatusObject(id, entry) }
      } catch (e) {
        out[id] = { ok: false, error: e instanceof Error ? e.message : 'unparseable status', code: 'unknown' }
      }
    }
  }
  return out
}

export class SMMv2Adapter implements ISMMProviderAdapter {
  readonly id: string
  readonly name: string
  readonly isMock: boolean

  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly capabilities: ProviderCapabilities
  private readonly correlationId: string | undefined
  private readonly logger: Logger | undefined
  private mockOrders = new Map<string, number>()
  private mockSeq = 100000

  constructor(config: SMMv2AdapterConfig) {
    this.id = config.id
    this.name = config.name
    this.apiUrl = config.apiUrl
    this.apiKey = config.apiKey ?? ''
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args))
    this.now = config.now ?? Date.now
    this.capabilities = { ...DEFAULT_SMM_V2_CAPABILITIES, ...config.capabilities }
    this.isMock = config.mockMode === true || this.apiKey === ''
    this.correlationId = isCorrelationId(config.correlationId) ? config.correlationId : undefined
    this.logger = config.logger
  }

  /** Static: SMM v2 panels differ on refill / cancel / drip-feed, so those stay false unless the provider row says otherwise. */
  async getCapabilities(): Promise<ProviderCapabilities> {
    return { ...this.capabilities }
  }

  async getBalance(): Promise<IProviderBalance> {
    if (this.isMock) return { balance: 1000, currency: 'USD' }
    const data = await this.call('balance', {})
    if (!isRecord(data)) throw new SMMProviderError('invalid_response', 'balance: expected an object')
    return { balance: toNumber(data.balance, 'balance'), currency: String(data.currency ?? 'USD') }
  }

  async getServices(): Promise<IProviderService[]> {
    if (this.isMock) return MOCK_SERVICES
    const data = await this.call('services', {})
    if (!Array.isArray(data)) throw new SMMProviderError('invalid_response', 'services: expected an array')
    return data.map((item, i): IProviderService => {
      if (!isRecord(item)) throw new SMMProviderError('invalid_response', `services[${i}]: expected an object`)
      return {
        externalServiceId: String(item.service),
        name: String(item.name ?? ''),
        type: String(item.type ?? 'Default'),
        categoryRaw: String(item.category ?? ''),
        ratePer1000: toNumber(item.rate, 'rate'),
        minQuantity: toNumber(item.min, 'min'),
        maxQuantity: toNumber(item.max, 'max'),
        refillSupported: toBool(item.refill),
        cancelSupported: toBool(item.cancel),
      }
    })
  }

  async createOrder(params: ICreateOrderParams): Promise<{ orderId: string }> {
    if (this.isMock) {
      const orderId = String(this.mockSeq + Math.floor(Math.random() * 9_000_000_000))
      this.mockOrders.set(orderId, this.now())
      return { orderId }
    }
    const data = await this.call(
      'add',
      { service: params.serviceId, link: params.link, quantity: params.quantity, ...params.extra },
      true,
    )
    if (!isRecord(data) || data.order === undefined || data.order === null || data.order === '') {
      throw new SMMProviderError('invalid_response', 'add: response has no order id', { ambiguous: true })
    }
    return { orderId: String(data.order) }
  }

  async getOrderStatus(orderId: string): Promise<IProviderOrderStatus> {
    if (this.isMock) {
      const created = this.mockOrders.get(orderId)
      if (created === undefined) {
        throw new SMMProviderError('api', 'Incorrect order ID', { code: 'order_not_found' })
      }
      const age = this.now() - created
      const rawStatus = age < 5_000 ? 'Pending' : age < 15_000 ? 'In progress' : 'Completed'
      return { orderId, rawStatus, status: mapProviderStatus(rawStatus), currency: 'USD', remains: rawStatus === 'Completed' ? 0 : undefined }
    }
    const data = await this.call('status', { order: orderId })
    if (!isRecord(data)) throw new SMMProviderError('invalid_response', 'status: response has no status')
    return parseStatusObject(orderId, data)
  }

  async getOrdersStatus(orderIds: string[]): Promise<Record<string, BatchStatusEntry>> {
    if (orderIds.length === 0) return {}
    if (this.isMock) {
      // Server-side mock has no memory of orders created by other instances, so it reports them delivered.
      return Object.fromEntries(orderIds.map((id): [string, BatchStatusEntry] => [id, {
        ok: true,
        status: { orderId: id, rawStatus: 'Completed', status: 'completed', remains: 0, startCount: 0, currency: 'USD' },
      }]))
    }
    return parseBatchStatusResponse(await this.call('status', { orders: orderIds.join(',') }), orderIds)
  }

  /** One POST to the panel; a failure is logged (sanitized, with the correlation id) and rethrown unchanged. */
  private async call(
    action: string,
    params: Record<string, string | number | undefined>,
    stateChanging = false,
  ): Promise<unknown> {
    const started = this.now()
    try {
      return await this.rawCall(action, params, stateChanging)
    } catch (e) {
      if (e instanceof SMMProviderError) {
        this.logger?.warn('provider call failed', {
          providerId: this.id,
          provider: this.name,
          action,
          error_kind: e.kind,
          error_code: e.code,
          http_status: e.httpStatus,
          ambiguous: e.ambiguous,
          duration_ms: this.now() - started,
        })
      }
      throw e
    }
  }

  /** One POST to the panel. Normalises every failure into SMMProviderError. */
  private async rawCall(
    action: string,
    params: Record<string, string | number | undefined>,
    stateChanging = false,
  ): Promise<unknown> {
    if (!this.apiUrl) throw new SMMProviderError('misconfigured', 'Provider apiUrl is not configured')

    const body = new URLSearchParams({ key: this.apiKey, action })
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let text: string
    let status: number
    try {
      const res = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...(this.correlationId ? { [CORRELATION_HEADER]: this.correlationId } : {}),
        },
        body,
        signal: controller.signal,
      })
      status = res.status
      text = await res.text()
    } catch (e) {
      if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
        throw new SMMProviderError('timeout', `${action}: no response within ${this.timeoutMs}ms`, {
          retryable: !stateChanging,
          ambiguous: stateChanging,
        })
      }
      throw new SMMProviderError('network', `${action}: network failure`, {
        retryable: !stateChanging,
        ambiguous: stateChanging,
      })
    } finally {
      clearTimeout(timer)
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      if (status >= 400) throw this.httpError(action, status, stateChanging)
      throw new SMMProviderError('invalid_response', `${action}: response is not valid JSON`, {
        httpStatus: status,
        ambiguous: stateChanging,
      })
    }

    if (isRecord(data) && typeof data.error === 'string') {
      const message = this.sanitize(data.error)
      throw new SMMProviderError('api', message, { code: classifyApiError(message), httpStatus: status })
    }
    if (status >= 400) throw this.httpError(action, status, stateChanging)
    return data
  }

  private httpError(action: string, status: number, stateChanging: boolean): SMMProviderError {
    return new SMMProviderError('http', `${action}: provider responded with HTTP ${status}`, {
      retryable: (status >= 500 || status === 429) && !stateChanging,
      // A 5xx on `add` may still have created the order.
      ambiguous: stateChanging && status >= 500,
      code: status === 429 ? 'rate_limited' : 'unknown',
      httpStatus: status,
    })
  }

  /** Panels sometimes echo request data back; never let the key out. */
  private sanitize(message: string): string {
    const clean = this.apiKey ? message.split(this.apiKey).join('***') : message
    return clean.slice(0, 200)
  }
}

// Keep in sync with supabase/seed.sql: running sync-catalog with MOCK_MODE=true against a
// seeded database must be a no-op, not a deactivation of the seeded services.
const mockService = (
  id: string, name: string, categoryRaw: string, rate: number, min: number, max: number,
  refill: boolean, cancel: boolean,
): IProviderService => ({
  externalServiceId: id, name, type: 'Default', categoryRaw, ratePer1000: rate,
  minQuantity: min, maxQuantity: max, refillSupported: refill, cancelSupported: cancel,
})

const MOCK_SERVICES: IProviderService[] = [
  mockService('1001', 'Telegram Post Views [Instant]', 'Telegram Views', 0.08, 100, 1000000, false, false),
  mockService('1002', 'Telegram Post Views [Real, 30 Days]', 'Telegram Views', 0.25, 100, 500000, false, false),
  mockService('2001', 'Telegram Channel Members [Non-Drop 30D]', 'Telegram Members', 1.8, 50, 50000, true, false),
  mockService('2002', 'Telegram Group Members [Mixed]', 'Telegram Members', 0.9, 100, 100000, true, false),
  mockService('3001', 'Instagram Followers [Real, Refill 30D]', 'Instagram Followers', 2.4, 50, 100000, true, true),
  mockService('3002', 'Instagram Followers [Fast, No Refill]', 'Instagram Followers', 1.2, 100, 200000, false, false),
  mockService('4001', 'TikTok Likes [Instant]', 'TikTok Likes', 0.6, 20, 100000, false, true),
  mockService('4002', 'TikTok Likes [Real, Refill]', 'TikTok Likes', 1.0, 50, 50000, true, false),
]
