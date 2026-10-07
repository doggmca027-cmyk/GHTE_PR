// Offline provider list for dev mock mode; enforces the same rules as admin_update_provider_config and
// admin_set_provider_payout.
import { checkPayoutDraft } from '@/lib/payment-view'
import type { ProviderConfigPatch, ProviderConfigView, ProviderPayoutInput } from '@/types/admin'
import { AdminApiError } from './mock-admin'

const DEMO_WALLET = `0:${'a1'.repeat(32)}`

export function createMockProviders() {
  const now = new Date().toISOString()
  const payout = { payoutNetwork: 'mainnet' as const, payoutAsset: 'TON' as const }
  const providers: ProviderConfigView[] = [
    { id: 'demo-prov-1', name: 'Secsers (demo)', isActive: true, routingEnabled: true, health: 'healthy', lastHealthCheck: now, balance: 842.17, currency: 'USD', lastBalanceSync: now, lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: false, reliabilityPenalty: 1, ...payout, payoutWallet: DEMO_WALLET, maxTopupPerTx: 150, maxDailyTopup: 300, topupUsedToday: 120 },
    { id: 'demo-prov-2', name: 'Backup panel (demo)', isActive: true, routingEnabled: true, health: 'unavailable', lastHealthCheck: now, balance: 6.4, currency: 'USD', lastBalanceSync: now, lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: true, reliabilityPenalty: 1.5, ...payout, payoutWallet: `0:${'b2'.repeat(32)}`, maxTopupPerTx: 100, maxDailyTopup: 200, topupUsedToday: 0 },
    { id: 'demo-prov-3', name: 'New panel (demo)', isActive: true, routingEnabled: false, health: 'disabled', lastHealthCheck: null, balance: 0, currency: 'USD', lastBalanceSync: null, lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: false, reliabilityPenalty: 1, ...payout, payoutWallet: null, maxTopupPerTx: null, maxDailyTopup: null, topupUsedToday: 0 },
  ]
  const find = (id: string) => {
    const p = providers.find((x) => x.id === id)
    if (!p) throw new AdminApiError('not_found', 'Provider not found.')
    return p
  }
  return {
    list: (): ProviderConfigView[] => providers.map((p) => ({ ...p })),
    update(id: string, patch: ProviderConfigPatch): void {
      const p = find(id)
      const low = patch.lowBalanceThreshold ?? p.lowBalanceThreshold
      const target = patch.targetTopupBalance ?? p.targetTopupBalance
      if (low < 0 || target < 0 || low > 1e9 || target > 1e9) throw new AdminApiError('invalid_input', 'Balance values must be between 0 and 1000000000.')
      if (target < low) throw new AdminApiError('invalid_input', 'Top-up target must not be below the low-balance threshold.')
      p.lowBalanceThreshold = low
      p.targetTopupBalance = target
      if (patch.reliabilityPenalty !== undefined) {
        if (!(patch.reliabilityPenalty >= 1 && patch.reliabilityPenalty <= 10)) throw new AdminApiError('invalid_input', 'Reliability penalty must be between 1 and 10.')
        p.reliabilityPenalty = Math.round(patch.reliabilityPenalty * 1000) / 1000
      }
      if (patch.routingEnabled !== undefined) p.routingEnabled = patch.routingEnabled
    },
    setPayout(id: string, input: ProviderPayoutInput): void {
      const p = find(id)
      const check = checkPayoutDraft({
        wallet: input.wallet ?? '', network: input.network, asset: input.asset,
        maxPerTx: input.maxTopupPerTx === null ? '' : String(input.maxTopupPerTx), maxDaily: input.maxDailyTopup === null ? '' : String(input.maxDailyTopup),
      })
      const firstError = Object.values(check.errors)[0]
      if (firstError || !check.input) throw new AdminApiError('invalid_input', firstError ?? 'Invalid payout configuration.')
      p.payoutWallet = check.input.wallet
      p.payoutNetwork = check.input.network
      p.payoutAsset = check.input.asset
      p.maxTopupPerTx = check.input.maxTopupPerTx
      p.maxDailyTopup = check.input.maxDailyTopup
    },
  }
}
