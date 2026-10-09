// Offline pricing grid and promo codes for dev mock mode. Re-prices with the SAME engine as the server.
import { calculateCustomerRate } from '../../../supabase/functions/_shared/price-engine.ts'
import type { MarginRuleInput, PricingPage, PricingQuery, PromoInput, PromoView } from '@/types/admin'

interface DemoService { id: string; name: string; category: string; categoryId: string; platform: string; providerRate: number; bestCost: number; rate: number }

export function createMockPricing() {
  const services: DemoService[] = [
    { id: 'demo-svc-1', name: 'Telegram Channel Members [Non-Drop 30D]', category: 'Members', categoryId: 'demo-cat-1', platform: 'telegram', providerRate: 0.54, bestCost: 0.5, rate: 1.35 },
    { id: 'demo-svc-2', name: 'Instagram Followers [Real, Refill 30D]', category: 'Followers', categoryId: 'demo-cat-2', platform: 'instagram', providerRate: 2.1, bestCost: 2.1, rate: 2.15 },
    { id: 'demo-svc-3', name: 'TikTok Views [Instant]', category: 'Views', categoryId: 'demo-cat-3', platform: 'tiktok', providerRate: 0.08, bestCost: 0.1, rate: 0.09 },
  ]
  const promos: PromoView[] = []
  return {
    list(query: PricingQuery = {}): PricingPage {
      const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const hits = services.filter((s) => (!query.platform || s.platform === query.platform)
        && (!query.categoryId || s.categoryId === query.categoryId)
        && words.every((w) => `${s.name} ${s.category}`.toLowerCase().includes(w)))
      const rows = hits.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 30)).map((s) => {
        const margin = Math.round((s.rate - s.bestCost) * 10_000) / 10_000
        return { serviceId: s.id, name: s.name, category: s.category, platform: s.platform, customerRate: s.rate, bestCost: s.bestCost, marginAbsolute: margin, marginPercent: s.rate > 0 ? (margin / s.rate) * 100 : null }
      })
      return { rows, total: hits.length }
    },
    setMargin(input: MarginRuleInput): number {
      const targets = services.filter((s) => (input.serviceId ? s.id === input.serviceId : input.categoryId ? s.categoryId === input.categoryId : input.platform ? s.platform === input.platform : true))
      for (const s of targets) s.rate = calculateCustomerRate(s.providerRate, [{ id: 'demo', type: input.type, value: input.value, service_id: input.serviceId ?? null, priority: 0 }], { serviceId: s.id })
      return targets.length
    },
    listPromos(): PromoView[] {
      return [...promos]
    },
    createPromo(input: PromoInput): PromoView {
      const code = (input.code?.trim() || `PROMO-DEMO${promos.length + 1}`).toUpperCase()
      if (promos.some((p) => p.code === code)) throw new Error('This code already exists.')
      const promo: PromoView = {
        id: `demo-promo-${promos.length + 1}`, code, discountType: input.discountType, discountValue: input.discountValue,
        maxUses: input.maxUses ?? null, currentUses: 0, expiresAt: input.expiresAt ?? null, isActive: true, createdAt: new Date().toISOString(),
      }
      promos.unshift(promo)
      return promo
    },
    setPromoActive(id: string, active: boolean): void {
      const p = promos.find((x) => x.id === id)
      if (p) p.isActive = active
    },
  }
}
