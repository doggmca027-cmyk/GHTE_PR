// The guarantee written in English panel names (JAP, SMMFollows...): attributes.refill decides the refill window of an order
// (begin_order_refill) and the "Refill" fact in the service description.
import { describe, expect, it } from 'vitest'
import { englishRefill, extractAttributes, translateService } from '../supabase/functions/_shared/service-text.ts'

describe('englishRefill', () => {
  it.each([
    ['Refill: 30 Days', 30], ['Refill 30D', 30], ['refill:30d', 30], ['30 Days Refill', 30], ['Auto Refill 30 Days', 30],
    ['AR 30', 30], ['Auto-Refill: 60D', 60], ['R30', 30], ['R: 30', 30], ['R 90', 90], ['Refill: 1 Month', 30], ['1 Year Guarantee', 365],
    ['365 Days Guaranteed', 365], ['Warranty 45 days', 45],
  ])('%s -> %s days', (tag, days) => expect(englishRefill(tag)).toBe(days))

  it.each([['Refill: Lifetime'], ['Lifetime Guaranteed'], ['Lifetime Refill'], ['Refill: Life time']])('%s -> lifetime', (tag) => expect(englishRefill(tag)).toBe('lifetime'))

  it.each([['No Refill'], ['Refill: No'], ['Non Refill'], ['Non-Refill'], ['Not Guaranteed'], ['Refill: 0D']])('%s -> none', (tag) => expect(englishRefill(tag)).toBe('none'))

  it.each([['Refill'], ['Guaranteed'], ['No Drop'], ['Refill: No Drop'], ['Max: 30K'], ['Speed: 20K/D'], ['Instagram AR Filter'], ['Real']])('%s says nothing', (tag) =>
    expect(englishRefill(tag)).toBeUndefined())
})

describe('attributes of English names', () => {
  it('the guarantee is read from the name, also from a bracket with several facts', () => {
    expect(translateService('Instagram Followers [Refill: 30D] [Max: 1M] [Start Time: 0 - 1 Hr] [Speed: 100K/D] 💧', { platformSlug: 'instagram', brands: ['Instagram'] }).attributes.refill).toBe(30)
    expect(translateService('Spotify Plays ➜ [Denmark] [ Cheap | 10-20K/Day | Refill : Lifetime ]', { platformSlug: 'spotify', brands: ['Spotify'] }).attributes.refill).toBe('lifetime')
    expect(translateService('TikTok Views [Max: 100M] [NO REFILL]', { platformSlug: 'tiktok', brands: ['TikTok'] }).attributes.refill).toBe('none')
    expect(translateService('Telegram Members [R30]', { platformSlug: 'telegram', brands: ['Telegram'] }).attributes.refill).toBe(30)
    expect(translateService('YouTube Views [Max: 10M]', { platformSlug: 'youtube', brands: ['YouTube'] }).attributes).not.toHaveProperty('refill')
  })

  it('facts listed with pipes (SMMFollows) count too; HTML entities are decoded', () => {
    const o = { platformSlug: 'spotify', brands: ['Spotify'] }
    expect(translateService('Spotify Saves | 🌍Location: Hungary 🇭🇺 | ⚡Speed: 3.5K–50K/Day | ♻️Refill: Lifetime | ⬆️MAX: 1M', o).attributes.refill).toBe('lifetime')
    expect(translateService('Twitter Quote Retweets | Location: UK | ♻️Refill: 100 Days | MAX 1K', o).attributes.refill).toBe(100)
    expect(translateService('Audiomack Streams | Location: Nigeria | ⏬Drop: No | ♻️Refill: No | ⬆️Max: 100K', o).attributes.refill).toBe('none')
    expect(translateService('Rumble Views | Chile | No Drop Guaranteed | MAX 1M', o).attributes).not.toHaveProperty('refill')
    const t = translateService('Rumble.com Video Views | Real &amp; Active | Provide The Video&#039;s Ad Code', o)
    expect(t.name).toContain('Real & Active')
    expect(t.name).toContain("Video's")
  })

  it('the Russian tags of the main panel read as before', () => {
    expect(extractAttributes(['♻️ Восстановление: 60 дней']).refill).toBe(60)
    expect(extractAttributes(['❌ Без восстановления']).refill).toBe('none')
    expect(extractAttributes(['♻️ Восстановление: Пожизненно']).refill).toBe('lifetime')
    expect(extractAttributes(['💎 Высокое качество'])).not.toHaveProperty('refill')
  })
})
