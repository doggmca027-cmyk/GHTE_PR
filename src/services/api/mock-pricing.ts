// Offline pricing grid for dev mock mode. Re-prices with the SAME engine as the server.
import { calculateCustomerRate } from '../../../supabase/functions/_shared/price-engine.ts'
import type { MarginRuleInput, PricingRow } from '@/types/admin'

interface DemoService { id: string; name: string; category: string; platform: string; providerRate: number; bestCost: number; rate: number }

export function createMockPricing() {
  const services: DemoService[] = [
    { id: 'demo-svc-1', name: 'Telegram Channel Members [Non-Drop 30D]', category: 'Members', platform: 'telegram', providerRate: 0.54, bestCost: 0.5, rate: 1.35 },
    { id: 'demo-svc-2', name: 'Instagram Followers [Real, Refill 30D]', category: 'Followers', platform: 'instagram', providerRate: 2.1, bestCost: 2.1, rate: 2.15 },
    { id: 'demo-svc-3', name: 'TikTok Views [Instant]', category: 'Views', platform: 'tiktok', providerRate: 0.08, bestCost: 0.1, rate: 0.09 },
  ]
  return {
    list(): PricingRow[] {
      return services.map((s) => {
        const margin = Math.round((s.rate - s.bestCost) * 10_000) / 10_000
        return { serviceId: s.id, name: s.name, category: s.category, platform: s.platform, customerRate: s.rate, bestCost: s.bestCost, marginAbsolute: margin, marginPercent: s.rate > 0 ? (margin / s.rate) * 100 : null }
      })
    },
    setMargin(input: MarginRuleInput): void {
      const s = services.find((x) => x.id === input.serviceId)
      if (!s) return
      s.rate = calculateCustomerRate(s.providerRate, [{ id: 'demo', type: input.type, value: input.value, service_id: s.id, priority: 0 }], { serviceId: s.id })
    },
  }
}
