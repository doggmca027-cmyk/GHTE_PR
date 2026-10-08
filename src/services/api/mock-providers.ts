// Offline provider list for dev mock mode; enforces the same rules as admin_update_provider_config and
// admin_set_provider_payout.
import { checkPayoutDraft } from '@/lib/payment-view'
import type { ProviderConfigPatch, ProviderConfigView, ProviderPayoutInput } from '@/types/admin'
import type { AdminProvider, UpsertProviderRequest, UpsertProviderResponse } from '@/types/admin-providers'
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
  // what admin-providers adds on top of the config view; keyed by provider id
  const extra = new Map<string, { apiUrl: string; priority: number; hasApiKey: boolean; slug: string }>([
    ['demo-prov-1', { apiUrl: 'https://secsers.example.com/api/v2', priority: 10, hasApiKey: true, slug: 'secsers-demo' }],
    ['demo-prov-2', { apiUrl: 'https://backup.example.com/api/v2', priority: 5, hasApiKey: true, slug: 'backup-panel-demo' }],
    ['demo-prov-3', { apiUrl: 'https://new-panel.example.com/api/v2', priority: 0, hasApiKey: false, slug: 'new-panel-demo' }],
  ])
  const view = (p: ProviderConfigView): AdminProvider => {
    const x = extra.get(p.id)!
    return {
      id: p.id, name: p.name, slug: x.slug, apiUrl: x.apiUrl, apiVersion: 'v2', isActive: p.isActive, routingEnabled: p.routingEnabled, priority: x.priority,
      healthStatus: p.health, lastHealthCheck: p.lastHealthCheck, balance: p.balance, currency: p.currency, lastBalanceSync: p.lastBalanceSync,
      lowBalanceThreshold: p.lowBalanceThreshold, targetTopupBalance: p.targetTopupBalance, reliabilityPenalty: p.reliabilityPenalty,
      hasApiKey: x.hasApiKey, createdAt: now, updatedAt: now,
    }
  }
  const find = (id: string) => {
    const p = providers.find((x) => x.id === id)
    if (!p) throw new AdminApiError('not_found', 'Provider not found.')
    return p
  }
  return {
    adminList: (): AdminProvider[] => providers.map(view),
    upsert(req: UpsertProviderRequest): UpsertProviderResponse {
      if (req.apiUrl !== undefined && !req.apiUrl.startsWith('https://')) throw new AdminApiError('invalid_input', 'apiUrl must start with https://.')
      const taken = (name: string, except?: string) => providers.some((x) => x.id !== except && x.name.toLowerCase() === name.toLowerCase())
      if (!req.id) {
        if (!req.name || !req.apiUrl) throw new AdminApiError('invalid_input', 'name and apiUrl are required for a new provider.')
        if (taken(req.name)) throw new AdminApiError('conflict', 'A provider with this name already exists.')
        const id = `demo-prov-${providers.length + 1}`
        providers.push({ id, name: req.name, isActive: req.isActive ?? true, routingEnabled: false, health: 'disabled', lastHealthCheck: null, balance: 0, currency: req.currency ?? 'USD', lastBalanceSync: null, lowBalanceThreshold: 0, targetTopupBalance: 0, lowBalanceAlerted: false, reliabilityPenalty: 1, ...payout, payoutWallet: null, maxTopupPerTx: null, maxDailyTopup: null, topupUsedToday: 0 })
        extra.set(id, { apiUrl: req.apiUrl, priority: req.priority ?? 0, hasApiKey: Boolean(req.apiKey), slug: req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
        return { success: true, created: true, provider: view(providers[providers.length - 1]) }
      }
      const p = find(req.id)
      const x = extra.get(p.id)!
      if (req.name !== undefined) {
        if (taken(req.name, p.id)) throw new AdminApiError('conflict', 'A provider with this name already exists.')
        p.name = req.name
      }
      if (req.apiUrl !== undefined) x.apiUrl = req.apiUrl
      if (req.priority !== undefined) x.priority = req.priority
      if (req.apiKey) x.hasApiKey = true // an absent key keeps the stored one
      if (req.isActive !== undefined) {
        p.isActive = req.isActive
        if (!req.isActive) p.routingEnabled = false
      }
      return { success: true, created: false, provider: view(p) }
    },
    toggleRouting(id: string, enabled: boolean): AdminProvider {
      const p = find(id)
      if (enabled && !p.isActive) throw new AdminApiError('conflict', 'An inactive provider cannot receive orders.')
      if (enabled && !extra.get(id)!.hasApiKey) throw new AdminApiError('conflict', 'Save the API key of the provider before switching routing on.')
      p.routingEnabled = enabled
      return view(p)
    },
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

let store: ReturnType<typeof createMockProviders> | undefined
/** One shared offline provider list, so a provider added in dev mock mode shows up in every part of the tab. */
export const mockProviders = () => (store ??= createMockProviders())
