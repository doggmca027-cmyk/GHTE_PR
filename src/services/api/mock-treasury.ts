// Offline treasury for dev mock mode. Mirrors process_treasury_transaction: no negative balance, idempotent by key.
import type { TreasuryAdjustment, TreasuryPage, TreasuryTx } from '@/types/admin'
import { AdminApiError } from './mock-admin'

export function createMockTreasury() {
  const txs: TreasuryTx[] = []
  let balance = 0
  const add = (type: TreasuryTx['type'], amount: number, description: string, ref: string | null) => {
    balance = Math.round((balance + amount) * 10_000) / 10_000
    txs.push({ id: `demo-tx-${txs.length + 1}`, seq: txs.length + 1, type, amount, balanceAfter: balance, description, referenceId: ref, createdAt: new Date().toISOString() })
  }
  add('deposit', 500, 'Initial funding (demo)', 'demo:init')
  add('provider_topup', -120, 'Top-up of Secsers (demo)', 'demo:topup-1')
  return {
    page(beforeSeq: number | null, limit = 50): TreasuryPage {
      const newestFirst = [...txs].reverse().filter((t) => beforeSeq === null || t.seq < beforeSeq)
      const transactions = newestFirst.slice(0, limit)
      return { balance, updatedAt: new Date().toISOString(), transactions, nextBefore: newestFirst.length > limit ? transactions[transactions.length - 1].seq : null }
    },
    adjust(input: TreasuryAdjustment): void {
      const ref = `manual:${input.idempotencyKey}`
      if (txs.some((t) => t.referenceId === ref)) return
      if (!Number.isFinite(input.amount) || input.amount === 0) throw new AdminApiError('invalid_input', 'Invalid amount.')
      if (balance + input.amount < 0) throw new AdminApiError('conflict', `Insufficient treasury funds: ${balance} available, ${-input.amount} required.`)
      add('manual_adjustment', input.amount, input.description, ref)
    },
  }
}
