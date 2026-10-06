// Order status sync: pure orchestration with all I/O injected (SyncPorts), so every outcome
// (completed / progress / canceled / partial / reconciliation) is unit-testable. The
// sync-order-status Edge Function wires the ports to Supabase and the SMM adapter.
//
// Money rules:
//   * Refund only on a definitive provider answer (Canceled / Fail / Partial). An order held in `processing` with an
//     unknown outcome is NEVER refunded here, however old it is: the provider may have created it. It waits in the
//     Reconciliation Center (sync_reconciliation_cases) for a human decision.
//   * "Order not found at the provider" and unparseable answers NEVER trigger a refund.
//   * Refunds are idempotent in the database (refund_order / apply_partial_refund), so a
//     retried or overlapping run cannot pay twice.

import { isValidOrderTransition } from './order-transitions.ts'
import type { BatchStatusEntry, ISMMProviderAdapter, OrderStatus } from './types.ts'

export const STATUS_QUERY_CHUNK = 50
export const NEEDS_REFUND = 'needs_refund'

// ---------------------------------------------------------------------------
// Partial refund maths
// ---------------------------------------------------------------------------

const UNITS = 10_000n // NUMERIC(14,4): amounts as integer 1e-4 units

/**
 * refund = round_half_up(charge * remains / quantity) in 1e-4 units, with BigInt (no floats).
 * Mirrors apply_partial_refund() in SQL:  round(charge_amount * remains / quantity, 4).
 * Multiplying first means the only rounding is the final one, and the platform keeps
 * charge - refund, so refunded + retained == charge exactly (no unit is created or lost).
 */
export function calcPartialRefundUnits(quantity: number, remains: number, chargeUnits: number | bigint): bigint {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError('quantity must be a positive integer')
  if (!Number.isInteger(remains) || remains < 0 || remains > quantity) throw new RangeError('remains must be within 0..quantity')
  const charge = BigInt(chargeUnits)
  if (charge < 0n) throw new RangeError('charge must not be negative')
  const q = BigInt(quantity)
  return (charge * BigInt(remains) * 2n + q) / (2n * q)
}

/** Same calculation on dollar amounts. */
export function calcPartialRefund(quantity: number, remains: number, charge: number): number {
  return Number(calcPartialRefundUnits(quantity, remains, Math.round(charge * Number(UNITS)))) / Number(UNITS)
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** place-order-flow records `provider accepted as <id> but database update failed` when its bookkeeping failed. */
export function recoverProviderOrderId(note: string | null): string | null {
  const m = /provider accepted as (\S+) but database update failed/.exec(note ?? '')
  return m ? m[1] : null
}

/**
 * Statuses to write, in order, to move an order to `target` through VALID transitions only.
 * [] = already there, null = not a forward move (e.g. in_progress -> submitted): never regress.
 */
export function stepsTo(current: OrderStatus, target: OrderStatus): OrderStatus[] | null {
  if (current === target) return []
  if (isValidOrderTransition(current, target)) return [target]
  // A held order the provider actually accepted never got its `submitted` step.
  if (current === 'processing' && isValidOrderTransition('submitted', target)) return ['submitted', target]
  return null
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface SyncOrder {
  id: string
  user_id: string
  service_id: string
  provider_order_id: string | null
  status: OrderStatus
  quantity: number
  charge_amount: number
  remains: number | null
  start_count: number | null
  error_message: string | null
  created_at: string
}

export interface OrderFieldsPatch {
  status?: OrderStatus
  remains?: number | null
  start_count?: number | null
  error_message?: string | null
}

/** Something worth telling the user about. Delivery is best effort and handled by the caller. */
export interface SyncEvent {
  type: 'completed' | 'canceled' | 'partial'
  order: SyncOrder
  /** Money returned to the wallet by this event (canceled: the whole charge; partial: the exact partial refund). */
  refundAmount?: number
}

export interface SyncPorts {
  /** Persists a recovered provider order id. */
  setProviderOrderId(orderId: string, providerOrderId: string): Promise<void>
  /** Conditional update: applies only if the order is still in one of `expect`. Returns false if not. */
  updateOrder(orderId: string, patch: OrderFieldsPatch, expect: OrderStatus[]): Promise<boolean>
  /** DB apply_partial_refund(): status -> partial + ledger credit, atomically and once. Returns the refunded amount. */
  applyPartialRefund(orderId: string, remains: number, startCount: number | null): Promise<number>
  /** DB refund_order(): refunds what is still refundable and moves the order to `refunded` (idempotent). */
  refundOrder(orderId: string, comment: string): Promise<void>
  /** Marks the order as just-checked so it rotates to the back of the queue. */
  touch(orderId: string): Promise<void>
  /** Optional. Errors thrown here are swallowed: a failing notification never affects order processing. */
  notify?(event: SyncEvent): void | Promise<void>
}

export interface SyncStats {
  checked: number
  completed: number
  progressed: number
  canceledRefunded: number
  partial: number
  /** Total partial refunds, in 1e-4 currency units. */
  partialRefundedUnits: number
  /** Held orders with an unknown provider outcome, left for the Reconciliation Center. */
  heldForReconciliation: number
  idsRecovered: number
  retriedRefunds: number
  providerLost: number
  unchanged: number
  conflicts: number
  errors: { orderId: string; message: string }[]
}

export const emptySyncStats = (): SyncStats => ({
  checked: 0, completed: 0, progressed: 0, canceledRefunded: 0, partial: 0, partialRefundedUnits: 0,
  heldForReconciliation: 0, idsRecovered: 0, retriedRefunds: 0, providerLost: 0, unchanged: 0, conflicts: 0, errors: [],
})

export function mergeSyncStats(into: SyncStats, from: SyncStats): SyncStats {
  for (const k of Object.keys(from) as (keyof SyncStats)[]) {
    if (k === 'errors') into.errors.push(...from.errors)
    else (into[k] as number) += from[k] as number
  }
  return into
}

interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export interface SyncOptions {
  /** Clock (tests). Kept for callers; since Phase 2 no decision depends on an order's age. */
  now?: number
  chunkSize?: number
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** Syncs a batch of orders that all belong to ONE provider (the adapter's panel). */
export async function syncProviderOrders(
  orders: SyncOrder[],
  adapter: Pick<ISMMProviderAdapter, 'getOrdersStatus'>,
  ports: SyncPorts,
  options: SyncOptions = {},
  log: Logger = console,
): Promise<SyncStats> {
  const stats = emptySyncStats()
  const lookup: SyncOrder[] = []

  const guarded = async (order: SyncOrder, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      stats.errors.push({ orderId: order.id, message: msg(e) })
      log.error(`order-sync: order ${order.id} failed`, e)
      await ports.touch(order.id).catch(() => {})
    }
  }

  const emit = async (event: SyncEvent) => {
    try {
      await ports.notify?.(event)
    } catch (e) {
      log.warn(`order-sync: notification for order ${event.order.id} failed: ${msg(e)}`) // never propagates
    }
  }

  /** Marks failed/canceled and refunds. Safe to repeat: the needs_refund note survives until the refund succeeds. */
  async function failAndRefund(order: SyncOrder, target: 'canceled' | 'failed', note: string, comment: string): Promise<boolean> {
    if (order.status !== target) {
      const ok = await ports.updateOrder(order.id, { status: target, error_message: `${NEEDS_REFUND}: ${note}` }, [order.status])
      if (!ok) {
        stats.conflicts++
        return false
      }
    }
    await ports.refundOrder(order.id, comment)
    await ports.updateOrder(order.id, { error_message: null }, ['refunded']).catch(() => {})
    await emit({ type: 'canceled', order, refundAmount: order.charge_amount })
    return true
  }

  // 1. Classify.
  for (const order of orders) {
    stats.checked++
    await guarded(order, async () => {
      const isRetry = (order.status === 'canceled' || order.status === 'failed') && (order.error_message ?? '').startsWith(NEEDS_REFUND)
      if (isRetry) {
        if (await failAndRefund(order, order.status as 'canceled' | 'failed', 'retry', 'Automatic refund retry')) stats.retriedRefunds++
        return
      }

      if (order.status === 'processing' && !order.provider_order_id) {
        const recovered = recoverProviderOrderId(order.error_message)
        if (recovered) {
          await ports.setProviderOrderId(order.id, recovered)
          stats.idsRecovered++
          lookup.push({ ...order, provider_order_id: recovered })
          return
        }
        // Outcome unknown: no automatic refund (the provider may have the order). Left as is for the Reconciliation
        // Center, where an admin refunds, retries or resolves it after checking the provider.
        stats.heldForReconciliation++
        stats.unchanged++
        await ports.touch(order.id)
        return
      }

      if (!order.provider_order_id) {
        stats.unchanged++
        await ports.touch(order.id)
        return
      }
      lookup.push(order)
    })
  }

  // 2. One status query per chunk of provider order ids.
  const byProviderId = new Map(lookup.map((o) => [o.provider_order_id as string, o]))
  const entries = new Map<string, BatchStatusEntry>()
  for (const ids of chunkArray([...byProviderId.keys()], options.chunkSize ?? STATUS_QUERY_CHUNK)) {
    try {
      const result = await adapter.getOrdersStatus(ids)
      for (const id of ids) if (result[id]) entries.set(id, result[id])
    } catch (e) {
      // The whole answer is missing: change nothing, never refund. Retry next run.
      for (const id of ids) {
        const order = byProviderId.get(id)!
        stats.errors.push({ orderId: order.id, message: `status query failed: ${msg(e)}` })
        await ports.touch(order.id).catch(() => {})
      }
      log.error('order-sync: provider status query failed', e)
    }
  }

  // 3. Apply each provider answer.
  for (const order of lookup) {
    const entry = entries.get(order.provider_order_id as string)
    if (!entry) continue // chunk failed: already recorded and touched
    await guarded(order, async () => {
      if (!entry.ok) {
        stats.providerLost++
        log.warn(`order-sync: provider has no usable status for order ${order.id}: ${entry.error}`)
        await ports.touch(order.id)
        return
      }
      const s = entry.status

      switch (s.status) {
        case 'completed': {
          const path = stepsTo(order.status, 'completed')
          if (path === null) { stats.unchanged++; await ports.touch(order.id); return }
          const fields: OrderFieldsPatch = { remains: 0, start_count: s.startCount ?? order.start_count, error_message: null }
          let expect: OrderStatus[] = [order.status]
          for (let i = 0; i < path.length; i++) {
            const last = i === path.length - 1
            if (!(await ports.updateOrder(order.id, last ? { status: path[i], ...fields } : { status: path[i] }, expect))) {
              stats.conflicts++
              return
            }
            expect = [path[i]]
          }
          if (path.length === 0) await ports.updateOrder(order.id, fields, [order.status])
          stats.completed++
          await emit({ type: 'completed', order })
          return
        }

        case 'partial': {
          const remains = s.remains
          if (remains === undefined || !Number.isInteger(remains) || remains < 0 || remains > order.quantity) {
            // Without a trustworthy `remains` the refund cannot be computed: do nothing, flag it.
            throw new Error(`provider reported Partial with unusable remains (${String(remains)}) for quantity ${order.quantity}`)
          }
          const refund = await ports.applyPartialRefund(order.id, remains, s.startCount ?? order.start_count)
          stats.partial++
          stats.partialRefundedUnits += Math.round(refund * 10_000)
          await emit({ type: 'partial', order: { ...order, remains }, refundAmount: refund })
          return
        }

        case 'canceled':
        case 'failed': {
          const canceled = s.status === 'canceled'
          if (await failAndRefund(order, s.status, canceled ? 'provider canceled order' : 'provider failed order', canceled ? 'Provider canceled order' : 'Provider failed order')) {
            stats.canceledRefunded++
          }
          return
        }

        default: {
          // submitted (Pending) / in_progress: keep progress fields and move forward only.
          const path = stepsTo(order.status, s.status)
          const next: OrderFieldsPatch = {}
          if (path && path.length > 0) next.status = path[path.length - 1]
          if (s.remains !== undefined && s.remains !== order.remains) next.remains = s.remains
          if (s.startCount !== undefined && s.startCount !== order.start_count) next.start_count = s.startCount
          if (Object.keys(next).length === 0) {
            stats.unchanged++
            await ports.touch(order.id)
            return
          }
          if (path && path.length > 1) {
            // processing -> submitted -> in_progress
            if (!(await ports.updateOrder(order.id, { status: path[0] }, [order.status]))) { stats.conflicts++; return }
            if (!(await ports.updateOrder(order.id, next, [path[0]]))) { stats.conflicts++; return }
          } else if (!(await ports.updateOrder(order.id, next, [order.status]))) {
            stats.conflicts++
            return
          }
          stats.progressed++
        }
      }
    })
  }

  return stats
}
