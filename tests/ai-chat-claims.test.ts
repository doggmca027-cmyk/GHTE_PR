// What the assistant promises, after the risk research of 2026-11-05 (reports/Цены конкурентов SMM и риски.md): no platform allows bought engagement and no source
// shows that Real, HQ, Refill or drip-feed lower the risk for an account, and bought website visits are not shown to lift a site in the search (and can cost an
// ad account). So the prompt sells stability and says that no immunity from the algorithms is promised, and it tells a site owner who asks for SEO what the
// traffic is and where not to use it.
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, extractIntent, situationNote, type StorefrontService } from '../api/_lib/chat-rag'

const card = (id: string, name: string, over: Partial<StorefrontService> = {}): StorefrontService => ({
  id, sku: `IG-FOL-STD-ROOT${id.toUpperCase()}`, name, customer_rate_per_1000: 1, min_quantity: 100, max_quantity: 100_000, refill_supported: false,
  category: { name: 'Instagram Followers', platform: { slug: 'instagram', name: 'Instagram' } }, ...over,
})

describe('the assistant no longer says it', () => {
  const prompt = buildSystemPrompt([card('a', 'Instagram Followers [Real] [Refill: 30 days]', { is_premium: true })], [card('b', 'Instagram Video Views')])
  const blog = situationNote(extractIntent('подписчики на мой блог'), [card('a', 'Followers', {})]) ?? ''

  it.each([
    'безопасно для аккаунта', 'аккаунту это безопаснее', 'ощущение безопасности', 'для безопасности аккаунта', 'про безопасность', 'безопасности и органичности',
    'органичный рост', 'живой вид аккаунта', 'поведенческ', 'качественный целевой трафик', 'органический из поиска',
  ])('"%s" is nowhere in the prompt or in the tone note', (phrase) => {
    expect(prompt.toLowerCase()).not.toContain(phrase.toLowerCase())
    expect(blog.toLowerCase()).not.toContain(phrase.toLowerCase())
  })

  it('the only "safe" in the prompt is a ban on calling a service safe', () => {
    const safe = prompt.match(/[^.]*безопасн[^.]*\./g) ?? []
    expect(safe).toHaveLength(1)
    expect(safe[0]).toContain('не называй услугу «безопасной» для аккаунта')
  })
})

describe('what it says about Premium and social networks', () => {
  const prompt = buildSystemPrompt([card('a', 'Instagram Followers [Real]', { is_premium: true })])
  it('the explanation of the owner: stable, refill if the network removes some, and no immunity from the algorithms', () => {
    expect(prompt).toContain('Premium-услуги выполняются с качественных профилей, плавно (drip-feed) и имеют гарантию восстановления (Refill), если соцсеть спишет часть накрутки.')
    expect(prompt).toContain('Мы продаём стабильность, но не гарантируем иммунитет от алгоритмов соцсетей.')
  })
  it('...told only as far as the card says it: the label, the refill term and drip-feed only where the list says so', () => {
    expect(prompt).toContain('Называй из этого только то, что написано в названии и в колонках списка')
    expect(prompt).toContain('drip-feed только там, где в списке стоит «drip-feed: да»')
  })
  it('the same line for the customer who asks for quality: a guarantee of recovery, no promise about the algorithms', () => {
    expect(prompt).toContain('но держится стабильнее: у таких услуг есть гарантия восстановления (Refill), если соцсеть спишет часть накрутки. Иммунитета от алгоритмов соцсетей мы не гарантируем.')
  })
  it('the tone for the owner of a blog or a brand is stability where the list says so, and no protection from the algorithms', () => {
    const note = situationNote(extractIntent('подписчики на мой блог'), [card('a', 'Followers', {})]) ?? ''
    expect(note).toContain('Делай акцент на стабильности')
    expect(note).toContain('только там, где они указаны в списке')
    expect(note).toContain('Не обещай защиту от алгоритмов соцсетей.')
  })
})

describe('what it says about SEO and website traffic', () => {
  const prompt = buildSystemPrompt([])
  it('what the traffic is, and where it must not be used (the wording of the owner)', () => {
    expect(prompt).toContain('Это технический трафик для увеличения показателей счётчиков.')
    expect(prompt).toContain('Строго не рекомендуется использовать его на страницах с монетизацией AdSense или РСЯ из-за риска блокировки рекламного аккаунта')
  })
  it('no promise about the search: not a position, not "the top", and the traffic does not reliably move it', () => {
    expect(prompt).toContain('Не обещай позиций в поисковой выдаче и не говори, что трафик «выведет в топ»: на позиции в поиске он надёжно не влияет')
  })
  it('the two or three options are still offered right after, so the customer is not left with a refusal', () => {
    expect(prompt).toContain('предложи 2–3 варианта веб-трафика')
    expect(prompt.indexOf('Строго не рекомендуется')).toBeLessThan(prompt.indexOf('предложи 2–3 варианта веб-трафика'))
  })
})
