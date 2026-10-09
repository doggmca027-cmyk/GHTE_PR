import { tr } from '@/i18n'
import type { AuthSession } from '@/services/api/auth'
import type { IWallet, OrderStatus } from '@/types'
import type { Platform } from '@/types/catalog'
import type { CreateOrderPayload, CreateOrderResult, CreatedOrder, IOrderView } from '@/types/orders'
import { OrderApiError, type OrderErrorCode } from './order-errors'
import { mockBackend } from './mock-orders'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
/** The function may wait up to ~10s on the provider; leave headroom before we call it a network failure. */
const PLACE_ORDER_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 10_000

interface PlaceOrderResponse {
  success: boolean
  pending?: boolean
  error?: OrderErrorCode
  message?: string
  shortfall?: number
  order?: CreatedOrder
  wallet?: IWallet
}

/**
 * Places an order through the `place-order` Edge Function. The server derives the price,
 * limits and provider from the database; only serviceId / targetUrl / quantity / key are sent.
 */
export async function createOrder(session: AuthSession, payload: CreateOrderPayload): Promise<CreateOrderResult> {
  if (session.isMock) return mockBackend.createOrder(payload)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new OrderApiError('server', 'Backend is not configured.')

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/place-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        serviceId: payload.serviceId,
        targetUrl: payload.targetUrl,
        quantity: payload.quantity,
        idempotencyKey: payload.idempotencyKey,
        ...(payload.promoCode ? { promoCode: payload.promoCode } : {}),
      }),
      signal: AbortSignal.timeout(PLACE_ORDER_TIMEOUT_MS),
    })
  } catch {
    throw new OrderApiError(
      'network',
      tr('Connection lost. Your order may have gone through: check the Orders tab, or tap again to retry safely.'),
    )
  }

  const body = (await res.json().catch(() => null)) as PlaceOrderResponse | null
  if (!body) throw new OrderApiError('server', tr('Unexpected response from the server. Please check the Orders tab.'))

  if (!body.success || !body.order) {
    throw new OrderApiError(body.error ?? (res.status === 401 ? 'unauthorized' : 'server'), body.message ?? tr('Could not place the order.'), {
      shortfall: body.shortfall,
      wallet: body.wallet,
    })
  }
  return { order: body.order, pending: body.pending === true || res.status === 202, wallet: body.wallet }
}

interface OrderRow {
  id: string
  target_url: string
  quantity: number
  charge_amount: number | string
  status: OrderStatus
  remains: number | null
  start_count: number | null
  partial_refund_amount: number | string
  created_at: string
  services: { name: string; categories: { platforms: { slug: Platform } | null } | null } | null
}

/**
 * The only columns of `orders` the app reads. They are also the only ones the database lets a customer read (column grants in
 * 20261111000000_rls_hardening.sql): cost, profit, provider and internal notes are private. Name the columns explicitly: a wildcard select is refused.
 */
export const ORDER_COLUMNS = ['id', 'target_url', 'quantity', 'charge_amount', 'status', 'remains', 'start_count', 'partial_refund_amount', 'created_at'] as const

/** The signed-in user's orders, newest first. Row Level Security scopes the query to auth.uid(). */
export async function getOrders(session: AuthSession): Promise<IOrderView[]> {
  if (session.isMock) return mockBackend.listOrders()
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')

  const select = [...ORDER_COLUMNS, 'services(name,categories(platforms(slug)))'].join(',')
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=${select}&status=neq.draft&order=created_at.desc&limit=100`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Orders request failed (${res.status})`)

  return ((await res.json()) as OrderRow[]).map((o): IOrderView => ({
    id: o.id,
    // services is RLS-filtered to active rows, so a retired service falls back to a generic label.
    serviceName: o.services?.name ?? 'Service',
    platform: o.services?.categories?.platforms?.slug ?? 'other',
    targetUrl: o.target_url,
    quantity: o.quantity,
    chargeAmount: Number(o.charge_amount),
    status: o.status,
    remains: o.remains,
    startCount: o.start_count,
    refundedAmount: Number(o.partial_refund_amount ?? 0),
    createdAt: o.created_at,
  }))
}
