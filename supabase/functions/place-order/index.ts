// Supabase Edge Function (Deno): POST /place-order
//   Authorization: Bearer <JWT issued by telegram-auth>
//   Body: { serviceId, targetUrl, quantity, idempotencyKey? }   (any price/rate/user fields are ignored)
//
// Flow: verify JWT -> validate -> load the service's provider offers -> route (selectBestOffer, see
//       _shared/routing.ts) -> place_order() (validates + snapshots the offer, atomic debit)
//       -> claim -> provider.createOrder -> submitted | refund | hold for reconciliation.
// See _shared/place-order-flow.ts for the money-safety rules.
//
// Secrets: JWT_SECRET, PROVIDER_KEY_SECRET / PROVIDER_<NAME>_API_KEY, MOCK_MODE (dev only), ALLOWED_ORIGIN.
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { verifyJwt } from '../_shared/jwt.ts'
import { deriveIdempotencyKey, parsePlaceOrderBody, validateQuantity } from '../_shared/order-validation.ts'
import {
  IN_FLIGHT_NOTE,
  PlaceOrderDbError,
  executePlaceOrder,
  mapDbError,
  type OrderRecord,
  type PlaceOrderPorts,
  type PlaceOrderResult,
} from '../_shared/place-order-flow.ts'
import {
  OFFER_SELECT,
  ServiceUnavailableError,
  buildCandidates,
  costForQuantity,
  resolveOffer,
  type OfferRow,
} from '../_shared/routing.ts'
import { assertSwitchOn, loadPlatformSettings } from '../_shared/platform-settings.ts'
import { resolveProviderApiKey } from '../_shared/secrets.ts'
import { createSMMv2Adapter } from '../_shared/smm-v2-adapter.ts'
import type { IProviderServiceOffer } from '../_shared/types.ts'

const MAX_BODY_BYTES = 4096

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const fail = (httpStatus: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ success: false, error, message, ...extra }, httpStatus)

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, 'public', any>

const publicOrder = (o: OrderRecord) => ({
  id: o.id,
  status: o.status,
  chargeAmount: Number(o.charge_amount),
  quantity: o.quantity,
  targetUrl: o.target_url,
})

function buildPorts(db: Db): PlaceOrderPorts {
  const one = (res: { data: unknown; error: { message: string; code?: string } | null }, what: string): OrderRecord => {
    if (res.error || !res.data) throw new PlaceOrderDbError(res.error?.message ?? `${what}: no data`, res.error?.code)
    return res.data as OrderRecord
  }
  return {
    async placeOrder(a) {
      return one(
        await db.rpc('place_order', {
          p_user_id: a.userId,
          p_service_id: a.serviceId,
          p_target_url: a.targetUrl,
          p_quantity: a.quantity,
          p_provider_offer_id: a.providerOfferId,
          p_provider_id: a.providerId,
          p_provider_service_id: a.providerServiceId,
          p_cost_amount: a.costAmount,
          p_idempotency_key: a.idempotencyKey,
        }),
        'place_order',
      )
    },
    async claim(orderId) {
      // Atomic: only the caller that flips paid -> processing gets a row back.
      const { data, error } = await db
        .from('orders')
        .update({ status: 'processing', error_message: IN_FLIGHT_NOTE })
        .eq('id', orderId)
        .eq('status', 'paid')
        .select('*')
        .maybeSingle()
      if (error) throw new PlaceOrderDbError(error.message, error.code)
      return (data as OrderRecord | null) ?? null
    },
    async get(orderId) {
      return one(await db.from('orders').select('*').eq('id', orderId).single(), 'get order')
    },
    async update(orderId, patch) {
      return one(await db.from('orders').update(patch).eq('id', orderId).select('*').single(), 'update order')
    },
    async refund(orderId, comment) {
      return one(await db.rpc('refund_order', { p_order_id: orderId, p_amount: null, p_comment: comment }), 'refund_order')
    },
  }
}

async function walletOf(db: Db, userId: string) {
  const { data } = await db.from('wallets').select('balance, currency').eq('user_id', userId).maybeSingle()
  return data ? { balance: Number(data.balance), currency: data.currency as string } : undefined
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed')

  const jwtSecret = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!jwtSecret || !supabaseUrl || !serviceKey) {
    console.error('place-order: missing environment configuration')
    return fail(500, 'server_misconfigured', 'Server is not configured.')
  }

  // 1. Authenticate strictly from the verified JWT. The user id never comes from the body.
  const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const claims = token ? await verifyJwt(token, jwtSecret) : null
  if (!claims) return fail(401, 'unauthorized', 'Please reopen the app and try again.')
  const userId = claims.sub

  // 2. Validate input.
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'invalid_input', 'Request too large.')
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return fail(400, 'invalid_input', 'Request body must be valid JSON.')
  }
  const parsed = parsePlaceOrderBody(parsedJson)
  if (!parsed.ok) return fail(400, parsed.error, parsed.message)
  const input = parsed.value

  const db: Db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // 3a. Kill switch, BEFORE anything that could charge or route. Read in parallel with the service lookup below, so it
  //     adds no latency. Fails closed: an unreadable settings row pauses ordering.
  // 3b. Everything that determines price and routing comes from the database.
  const [settings, { data: service, error: serviceError }] = await Promise.all([
    loadPlatformSettings(db),
    db.from('services').select('id, is_active, min_quantity, max_quantity').eq('id', input.serviceId).maybeSingle(),
  ])
  try {
    assertSwitchOn(settings, 'orders')
  } catch (e) {
    if (e instanceof ServiceUnavailableError) return fail(503, 'service_unavailable', e.message)
    throw e
  }
  if (serviceError) {
    console.error('place-order: service lookup failed', serviceError)
    return fail(500, 'internal_error', 'Something went wrong. You were not charged.')
  }
  if (!service || !service.is_active) return fail(404, 'service_unavailable', 'This service is no longer available.')

  const qty = validateQuantity(String(input.quantity), service.min_quantity, service.max_quantity)
  if (!qty.ok) return fail(400, 'invalid_input', qty.error)

  const idempotencyKey = deriveIdempotencyKey(userId, input.clientKey)

  // A retry of an order that already exists keeps going to the provider it was charged for.
  const { data: existing } = await db.from('orders').select('provider_offer_id').eq('idempotency_key', idempotencyKey).maybeSingle()

  const { data: offerRows, error: offersError } = await db.from('provider_service_offers').select(OFFER_SELECT).eq('service_id', input.serviceId)
  if (offersError) {
    console.error('place-order: offer lookup failed', offersError)
    return fail(500, 'internal_error', 'Something went wrong. You were not charged.')
  }
  const candidates = buildCandidates((offerRows ?? []) as unknown as OfferRow[])

  // Refuse BEFORE charging anything if no healthy provider can fulfil the order.
  let offer: IProviderServiceOffer
  try {
    offer = resolveOffer(candidates.offers, candidates.providers, { quantity: input.quantity, pinnedOfferId: existing?.provider_offer_id })
  } catch (e) {
    if (e instanceof ServiceUnavailableError) return fail(503, 'service_unavailable', 'This service is temporarily unavailable. You were not charged.')
    throw e
  }
  const details = candidates.details.get(offer.id)!
  const provider = candidates.providers.find((p) => p.id === offer.providerId)!

  let apiKey = ''
  try {
    apiKey = await resolveProviderApiKey({ name: details.providerName, api_key_encrypted: details.apiKeyEncrypted }, Deno.env)
  } catch (e) {
    console.error('place-order: provider key could not be decrypted', e)
  }
  const mockMode = Deno.env.get('MOCK_MODE') === 'true'
  if (!apiKey && !mockMode) {
    return fail(503, 'service_unavailable', 'This service is temporarily unavailable. You were not charged.')
  }

  const adapter = createSMMv2Adapter(
    { id: provider.id, name: provider.name, apiUrl: details.apiUrl, apiKey },
    { MOCK_MODE: Deno.env.get('MOCK_MODE') },
  )

  // 4. Execute.
  let result: PlaceOrderResult
  try {
    result = await executePlaceOrder(
      {
        userId,
        serviceId: input.serviceId,
        targetUrl: input.targetUrl,
        quantity: input.quantity,
        idempotencyKey,
        providerOfferId: offer.id,
        providerId: offer.providerId,
        providerServiceId: offer.providerServiceId,
        costAmount: costForQuantity(offer.costPer1000, input.quantity),
        externalServiceId: details.externalServiceId,
      },
      buildPorts(db),
      adapter,
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const mapped = mapDbError(message)
    if (mapped.httpStatus >= 500) console.error('place-order: unexpected failure', e)
    return fail(mapped.httpStatus, mapped.error, mapped.message, mapped.shortfall !== undefined ? { shortfall: mapped.shortfall } : {})
  }

  const wallet = await walletOf(db, userId)
  const order = publicOrder(result.order)

  switch (result.kind) {
    case 'submitted':
      return json({ success: true, order, wallet })
    case 'replayed': {
      const s = result.order.status
      if (s === 'refunded' || s === 'failed' || s === 'canceled') {
        return fail(422, 'provider_rejected', 'This order could not be completed and was refunded.', { order, wallet })
      }
      if (s === 'processing' || s === 'paid' || s === 'awaiting_payment' || s === 'draft') {
        return json({ success: true, pending: true, order, wallet }, 202)
      }
      return json({ success: true, order, wallet })
    }
    case 'pending':
      // Funds stay debited; the order is flagged needs_reconciliation. Do NOT tell the user it failed.
      return json({ success: true, pending: true, order, wallet }, 202)
    case 'rejected':
      return fail(422, 'provider_rejected', `${result.message} You have been refunded.`, { order, wallet })
    case 'refund_failed':
      return fail(502, 'refund_pending', `${result.message} Your refund is being processed by support.`, { order, wallet })
  }
})
