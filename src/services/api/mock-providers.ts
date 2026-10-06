// Offline provider list for dev mock mode; enforces the same rules as admin_update_provider_config.
import type { ProviderConfigPatch, ProviderConfigView } from '@/types/admin'
import { AdminApiError } from './mock-admin'

export function createMockProviders() {
  const now = new Date().toISOString()
  const providers: ProviderConfigView[] = [
    { id: 'demo-prov-1', name: 'Secsers (demo)', isActive: true, routingEnabled: true, health: 'healthy', lastHealthCheck: now, balance: 842.17, currency: 'USD', lastBalanceSync: now, lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: false, reliabilityPenalty: 1 },
    { id: 'demo-prov-2', name: 'Backup panel (demo)', isActive: true, routingEnabled: true, health: 'unavailable', lastHealthCheck: now, balance: 6.4, currency: 'USD', lastBalanceSync: now, lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: true, reliabilityPenalty: 1.5 },
    { id: 'demo-prov-3', name: 'New panel (demo)', isActive: true, routingEnabled: false, health: 'disabled', lastHealthCheck: null, balance: 0, currency: 'USD', lastBalanceSync: null, lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: false, reliabilityPenalty: 1 },
  ]
  return {
    list: (): ProviderConfigView[] => providers.map((p) => ({ ...p })),
    update(id: string, patch: ProviderConfigPatch): void {
      const p = providers.find((x) => x.id === id)
      if (!p) throw new AdminApiError('not_found', 'Provider not found.')
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
  }
}
