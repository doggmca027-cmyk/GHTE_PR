// The assistant and the two-level catalogue: the list marks Premium cards with a 💎 and the prompt tells when to offer them, honestly.
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, serviceLine, type StorefrontService } from '../api/_lib/chat-rag'

const card = (id: string, name: string, over: Partial<StorefrontService> = {}): StorefrontService => ({
  id, sku: `IG-FOL-STD-ROOT${id.toUpperCase()}`, name, customer_rate_per_1000: 1, min_quantity: 100, max_quantity: 100_000, refill_supported: false,
  category: { name: 'Instagram Followers', platform: { slug: 'instagram', name: 'Instagram' } }, ...over,
})

describe('the list the model reads', () => {
  it('a Premium card has a 💎 in front of its name, any other has nothing', () => {
    expect(serviceLine(card('a', 'Instagram Followers [Real]', { is_premium: true }))).toMatch(/^IG-FOL-STD-ROOTA \| 💎 Instagram Followers \[Real\] \|/)
    for (const is_premium of [false, null, undefined]) expect(serviceLine(card('b', 'Instagram Followers', { is_premium }))).not.toContain('💎')
  })
})

describe('the Premium instruction of the prompt', () => {
  const prompt = buildSystemPrompt([card('a', 'Instagram Followers [Real]', { is_premium: true })])
  it('offers Premium first to whoever wants quality or fears blocks', () => {
    expect(prompt).toContain('PREMIUM. Услуги с 💎')
    expect(prompt).toMatch(/боится блокировок или списаний/)
    expect(prompt).toMatch(/предлагай сначала Premium/)
    expect(prompt).toMatch(/Продавай стабильность и очевидную выгоду/)
  })
  it('keeps it honest: no promise of no blocks, no "live people" where the name does not say it, and the mass market is still offered', () => {
    expect(prompt).toMatch(/Не обещай, что аккаунт не заблокируют/)
    expect(prompt).toMatch(/только то, что написано в названии и в колонках списка/)
    expect(prompt).toMatch(/Дешёвые услуги без 💎 тоже предлагай/)
  })
  it('the rules still end with the data warning, and the list stays last', () => {
    expect(prompt.indexOf('PREMIUM.')).toBeLessThan(prompt.indexOf('КОНФИДЕНЦИАЛЬНОСТЬ'))
    expect(prompt.indexOf('19. Списки ниже')).toBeLessThan(prompt.indexOf('<services>'))
  })
})
