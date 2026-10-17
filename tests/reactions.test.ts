// @vitest-environment jsdom
// The reaction a reaction service delivers is never cut off: it names the variant's switch and is a badge of the card.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { reactionOf } from '../src/lib/reactions'
import { variantDiffLabels } from '../src/lib/variants'
import { VariantCard } from '../src/components/services/VariantCard'
import type { ICatalogService } from '../src/types/catalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const v = (id: string, name: string, rate: number, ru?: string): ICatalogService =>
  ({ id, categoryId: 'c', name, description: null, ratePer1000: rate, minQuantity: 10, maxQuantity: 1000, refillSupported: false, sortOrder: 0, attributes: { refill: 'none' }, ...(ru ? { nameI18n: { ru } } : {}) })

describe('which reaction', () => {
  it('from the original name when the English one lost it (Facebook), from a tag, quotes or an emoji in a tag', () => {
    expect(reactionOf('Facebook Post Reactions [no refill] [speed: 10 K/day]', { ru: 'Реакции на пост Facebook [Без восстановления] [Скорость: 10 тыс./день] [Ха-ха]' })?.emoji).toBe('😆')
    expect(reactionOf('X', { ru: 'Реакции на пост Facebook [Возмутительно] [Сервер 1]' })?.emoji).toBe('😡')
    expect(reactionOf('Facebook Post Reactions', { ru: 'Реакции на пост Facebook [Ух ты!]' })?.emoji).toBe('😮')
    expect(reactionOf('Facebook Post Reactions [super] [server 1]')?.emoji).toBe('❤️')
    expect(reactionOf('Telegram Reactions «star» [no refill]')?.emoji).toBe('⭐')
    expect(reactionOf('Facebook [😢] Post Reactions ➜ [ Low Drop ]')?.label).toBe('Sad')
    expect(reactionOf('Instagram Channel Post/Message ➜ [Positive Emoji Reactions | No Refill]')?.emoji).toBe('👍')
    expect(reactionOf('Instagram Channel Post/Message – Negative Emoji Reactions [x]')).toBeNull() // "Negative" outside a tag: not stated
  })

  it('not a reaction service, a random mix, or a decoration emoji in the name: nothing', () => {
    expect(reactionOf('Instagram Likes [refill: 30 days]')).toBeNull()
    expect(reactionOf('WhatsApp Channel Post Reactions [random] [Türkiye]')).toBeNull()
    expect(reactionOf('🔥 Telegram Reactions [no refill]')).toBeNull()
  })
})

describe('on the card', () => {
  it('the switches of a Facebook group are named by the reaction (in the customer\'s language), the card has it as a badge', () => {
    const group = [
      v('a', 'Facebook Post Reactions [no refill] [speed: 10 K/day]', 0.2706, 'Реакции на пост Facebook [Без восстановления] [Ха-ха]'),
      v('b', 'Facebook Post Reactions [no refill] [speed: 10 K/day]', 0.2706, 'Реакции на пост Facebook [Без восстановления] [Сочувствую]'),
      v('c', 'Facebook Post Reactions [no refill] [speed: 10 K/day]', 0.2706, 'Реакции на пост Facebook [Без восстановления] [Возмутительно]'),
    ]
    expect(variantDiffLabels(group, 'en', 'en-US')).toEqual(['😆 Haha', '😢 Sad', '😡 Angry'])
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(VariantCard, { service: { ...group[0], variants: group.slice(1) }, platform: 'facebook', onSelect: () => {} })))
    expect([...host.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(['😆 Haha$0.2706', '😢 Sad$0.2706', '😡 Angry$0.2706'])
    expect(host.querySelector('[data-testid="service-badges"]')?.textContent).toContain('😆 Haha')
    expect(host.querySelector('h3')?.className).toContain('line-clamp-3')
    act(() => root.unmount())
  })
})
