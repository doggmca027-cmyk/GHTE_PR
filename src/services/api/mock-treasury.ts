// Offline treasury for dev mock mode. Mirrors process_treasury_transaction (no negative balance, idempotent by key),
// the minimum reserve and the provider payment state machine (PAYMENT_TRANSITIONS, the twin of the SQL guard).
import { PAYMENT_TRANSITIONS } from '@/lib/payment-view'
import type { ProviderPayment, ProviderPaymentAction, ProviderPaymentStatus, TopupProposal, TreasuryAdjustment, TreasuryPage, TreasuryTx } from '@/types/admin'
import { detectPaymentIssue } from '../../../supabase/functions/_shared/reconciliation-detectors.ts'
import { AdminApiError } from './mock-admin'

const MINUTE = 60_000

export function createMockTreasury() {
  const txs: TreasuryTx[] = []
  let proposals: TopupProposal[] = [
    { id: 'demo-prop-1', providerId: 'demo-prov-2', providerName: 'Backup panel (demo)', amount: 93.6, currency: 'USD', createdAt: new Date().toISOString() },
  ]
  let balance = 0
  let minimumReserve = 50
  const add = (type: TreasuryTx['type'], amount: number, description: string, ref: string | null) => {
    balance = Math.round((balance + amount) * 10_000) / 10_000
    txs.push({ id: `demo-tx-${txs.length + 1}`, seq: txs.length + 1, type, amount, balanceAfter: balance, description, referenceId: ref, createdAt: new Date().toISOString() })
  }
  add('deposit', 500, 'Initial funding (demo)', 'demo:init')
  add('provider_topup', -120, 'Top-up of Secsers (demo)', 'demo:topup-1')

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const newPayment = (over: Partial<ProviderPayment> & Pick<ProviderPayment, 'id' | 'providerId' | 'providerName' | 'amount'>): ProviderPayment => ({
    currency: 'USD', asset: 'TON', network: 'mainnet', destinationWallet: `0:${'a1'.repeat(32)}`, txHash: null, status: 'PAYMENT_CREATED',
    failureReason: null, treasuryReversed: false, createdAt: ago(0), updatedAt: ago(0), broadcastedAt: null, confirmedAt: null, completedAt: null,
    openCaseId: null, issue: null, ...over,
  })
  // A confirmed transfer the provider never credited: what the reconciliation detector (Rule A) flags.
  const confirmedAt = ago(50 * MINUTE)
  const payments: ProviderPayment[] = [
    newPayment({
      id: 'demo-pay-1', providerId: 'demo-prov-1', providerName: 'Secsers (demo)', amount: 120, status: 'CONFIRMED',
      txHash: 'demo5f1c0d7e9a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2', createdAt: ago(3 * 60 * MINUTE), broadcastedAt: ago(170 * MINUTE),
      confirmedAt, updatedAt: confirmedAt, openCaseId: 'demo-case-pay-1',
      issue: detectPaymentIssue({
        status: 'CONFIRMED', amount: 120, currency: 'USD', failureReason: null, broadcastedAt: ago(170 * MINUTE), confirmedAt, updatedAt: confirmedAt,
        providerBalanceBefore: 845.97, providerBalance: 842.17, providerCurrency: 'USD', providerBalanceSyncedAt: ago(0), spentSince: 3.8,
      }),
    }),
  ]

  return {
    page(beforeSeq: number | null, limit = 50): TreasuryPage {
      const newestFirst = [...txs].reverse().filter((t) => beforeSeq === null || t.seq < beforeSeq)
      const transactions = newestFirst.slice(0, limit)
      return {
        balance, minimumReserve, payments: payments.map((p) => ({ ...p })), proposals: [...proposals], updatedAt: new Date().toISOString(), transactions,
        nextBefore: newestFirst.length > limit ? transactions[transactions.length - 1].seq : null,
      }
    },
    decide(id: string, decision: 'approve' | 'reject'): void {
      const p = proposals.find((x) => x.id === id)
      if (!p) throw new AdminApiError('conflict', 'This proposal was already decided.')
      if (decision === 'approve') {
        if (balance < p.amount) throw new AdminApiError('conflict', `Insufficient treasury funds: ${balance} available, ${p.amount} required.`)
        if (balance - p.amount < minimumReserve) throw new AdminApiError('conflict', `balance ${balance}, requested ${p.amount}, minimum reserve ${minimumReserve}`)
        add('provider_topup', -p.amount, `Top-up of ${p.providerName}`, id)
        // as in production: the approval creates the payment and its transfer instruction (PAYMENT_CREATED)
        payments.unshift(newPayment({ id: `demo-pay-${payments.length + 1}`, providerId: p.providerId, providerName: p.providerName, amount: p.amount, destinationWallet: `0:${'b2'.repeat(32)}` }))
      }
      proposals = proposals.filter((x) => x.id !== id)
    },
    adjust(input: TreasuryAdjustment): void {
      const ref = `manual:${input.idempotencyKey}`
      if (txs.some((t) => t.referenceId === ref)) return
      if (!Number.isFinite(input.amount) || input.amount === 0) throw new AdminApiError('invalid_input', 'Invalid amount.')
      if (balance + input.amount < 0) throw new AdminApiError('conflict', `Insufficient treasury funds: ${balance} available, ${-input.amount} required.`)
      add('manual_adjustment', input.amount, input.description, ref)
    },
    setReserve(minimum: number): void {
      if (!Number.isFinite(minimum) || minimum < 0 || minimum >= 1e9) throw new AdminApiError('invalid_input', 'The minimum reserve must be between 0 and 1000000000.')
      minimumReserve = Math.round(minimum * 10_000) / 10_000
    },
    paymentAction(a: ProviderPaymentAction): void {
      const p = payments.find((x) => x.id === a.paymentId)
      if (!p) throw new AdminApiError('not_found', 'Payment not found.')
      const now = new Date().toISOString()
      const move = (to: ProviderPaymentStatus) => {
        if (p.status === to) return
        if (!PAYMENT_TRANSITIONS[p.status].includes(to)) throw new AdminApiError('conflict', 'The payment is not in a state that allows this.')
        p.status = to
        p.updatedAt = now
        p.issue = null
        p.openCaseId = null
      }
      switch (a.action) {
        case 'CREATE_INSTRUCTION':
          move('PAYMENT_CREATED')
          return
        case 'RECORD_PAYMENT_BROADCAST':
          if (payments.some((x) => x.id !== p.id && x.txHash === a.txHash)) throw new AdminApiError('conflict', 'This transaction hash is already recorded on another payment.')
          if (p.txHash !== null && p.txHash !== a.txHash) throw new AdminApiError('conflict', 'A recorded transaction hash cannot change.')
          move('BROADCASTED')
          p.txHash = a.txHash
          p.broadcastedAt = now
          if (a.markConfirming) move('CONFIRMING')
          return
        case 'ADVANCE_PAYMENT':
          if (a.to === 'COMPLETED' && !p.txHash) throw new AdminApiError('conflict', 'Record the transaction hash before completing the payment.')
          move(a.to)
          if (a.to === 'CONFIRMED') p.confirmedAt = now
          if (a.to === 'COMPLETED') p.completedAt = now
          return
        case 'FAIL_PAYMENT':
        case 'CANCEL_PAYMENT':
          move(a.action === 'FAIL_PAYMENT' ? 'FAILED' : 'CANCELED')
          p.failureReason = a.reason
          if (!p.treasuryReversed) {
            add('manual_adjustment', p.amount, `Reversal of provider payment ${p.id}`, `payment-reversal:${p.id}`)
            p.treasuryReversed = true
          }
      }
    },
  }
}
