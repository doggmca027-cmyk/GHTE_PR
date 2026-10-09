// The funded-orders stage of the order worker: orders that were paid while their provider had no money (deferred funding, migration
// 20261115000000) are sent as soon as the provider has been topped up, and refunded when they have waited too long.
//
// Pure orchestration with injected I/O, so every outcome is unit-testable. The money rules are the ones of place-order-flow.ts, because a waiting
// order is sent through the very same submitClaimedOrder(): a definitive refusal refunds, an unknown outcome is HELD for reconciliation (never
// refunded, never re-sent), a success is recorded.
//
//   1. expire_unfunded_orders(): whatever waited longer than the limit is refunded in full (the database does it, one order failing never stops
//      the others).
//   2. claim_funded_orders(): the database reserves each cost at the provider (balance >= cost) and flips paid -> processing, oldest first, and
//      only for the providers this run can actually talk to (a claimed order that cannot be sent would sit in `processing` until reconciliation).
//   3. each claimed order is sent; a few at a time.
import { submitClaimedOrder, type OrderRecord, type PlaceOrderPorts, type PlaceOrderResult } from './place-order-flow.ts'
import type { ISMMProviderAdapter } from './types.ts'

/** What claim_funded_orders() returns for an order it handed out. */
export interface FundedOrder {
  id: string
  user_id: string
  provider_id: string
  target_url: string
  quantity: number
  charge_amount: number
  external_service_id: string
}

export interface FundedPorts {
  /** expire_unfunded_orders() */
  expire(): Promise<{ refunded: number; failed: number }>
  /** claim_funded_orders(limit, providerIds) */
  claim(limit: number, providerIds: string[]): Promise<FundedOrder[]>
  /** The providers this run can send to (active, routing on, key readable) with an adapter for each. */
  adapters(): Promise<Map<string, Pick<ISMMProviderAdapter, 'createOrder'>>>
  /** The ports of place-order-flow.ts (claim is not used here: the database already claimed). */
  orders: PlaceOrderPorts
}

export interface FundedRunReport {
  expired: number
  expireFailed: number
  claimed: number
  submitted: number
  held: number
  rejected: number
  refundFailed: number
  errors: number
}

export const emptyFundedReport = (): FundedRunReport => ({ expired: 0, expireFailed: 0, claimed: 0, submitted: 0, held: 0, rejected: 0, refundFailed: 0, errors: 0 })

/** Orders claimed (and so sent) per run. Each one is a call to a panel that may take its whole timeout: keep the run well inside its budget. */
export const FUNDED_BATCH = 10
const PARALLEL = 5

interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export async function releaseFundedOrders(ports: FundedPorts, log: Logger = console, limit: number = FUNDED_BATCH): Promise<FundedRunReport> {
  const report = emptyFundedReport()

  try {
    const e = await ports.expire()
    report.expired = e.refunded
    report.expireFailed = e.failed
  } catch (e) {
    report.errors++
    log.error('funded orders: expiry failed', e)
  }

  let adapters: Map<string, Pick<ISMMProviderAdapter, 'createOrder'>>
  try {
    adapters = await ports.adapters()
  } catch (e) {
    report.errors++
    log.error('funded orders: providers could not be prepared', e)
    return report
  }
  if (adapters.size === 0) return report

  let claimed: FundedOrder[]
  try {
    claimed = await ports.claim(limit, [...adapters.keys()])
  } catch (e) {
    report.errors++
    log.error('funded orders: claim failed', e)
    return report
  }
  report.claimed = claimed.length

  const send = async (o: FundedOrder): Promise<void> => {
    let result: PlaceOrderResult
    try {
      const order: OrderRecord = await ports.orders.get(o.id)
      result = await submitClaimedOrder(order, o.external_service_id, ports.orders, adapters.get(o.provider_id)!, log)
    } catch (e) {
      // The order is `processing` with the in-flight note: reconciliation finds it. Never refund or re-send on an error we do not understand.
      report.errors++
      log.error(`funded orders: order ${o.id} could not be settled after it was claimed`, e)
      return
    }
    switch (result.kind) {
      case 'submitted': report.submitted++; break
      case 'pending': report.held++; break
      case 'rejected': report.rejected++; break
      case 'refund_failed': report.refundFailed++; break
      default: break
    }
  }

  for (let i = 0; i < claimed.length; i += PARALLEL) {
    await Promise.all(claimed.slice(i, i + PARALLEL).map(send))
  }
  return report
}
