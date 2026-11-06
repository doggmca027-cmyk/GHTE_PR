// Smart mapping (brief of 2026-11-06): the assistant read "медленные автопросмотры в тг" literally, found no category of that name and said "we have none",
// while the catalogue has Telegram views whose names say Auto / Future Posts / Slow and whose drip-feed flag is on. A wish is now taken apart into a BASE
// (platform + action) and MODIFIERS (speed, format, guarantee); the modifiers are translated into the labels of the names, searched, ranked first, and the
// base stays in the list so that the closest alternative is always there. The model's own wording cannot be unit-tested: what these tests fix is
// everything that decides what it is shown and told.
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, FALLBACK_MODELS, handleChat, type ChatDeps } from '../api/_lib/chat-handler'
import { buildSearchUrl, buildSystemPrompt, extractIntent, rankServices, searchKinds, type StorefrontService } from '../api/_lib/chat-rag'

const view = (id: string, name: string, rate: number, over: Partial<StorefrontService> = {}): StorefrontService => ({
  id, sku: `TG-VIEW-STD-${id.toUpperCase()}`, name, customer_rate_per_1000: rate, min_quantity: 10, max_quantity: 100_000, refill_supported: false,
  category: { name: 'Telegram Views', platform: { slug: 'telegram', name: 'Telegram' } }, ...over,
})
const WISH = 'медленные автопросмотры в тг'
const base = 'https://x.supabase.co'

describe('1. the wish is taken apart into a base and modifiers', () => {
  it(`"${WISH}": base = Telegram + views, modifiers = slow + auto`, () => {
    const intent = extractIntent(WISH)
    expect(intent).toMatchObject({ platform: 'telegram', slow: true, auto: true })
    expect(intent.actions).toContain('view')
  })
  it.each([
    'плавные просмотры в тг', 'просмотры без резких скачков', 'постепенно накрутить просмотры в тг', 'просмотры в тг, безопасно', 'повільні перегляди в тг', 'slow views telegram', 'drip feed views telegram',
  ])('speed: "%s" is a wish for Slow / Drip labels', (text) => {
    expect(extractIntent(text).slow).toBe(true)
  })
  it.each([
    'автопросмотры в тг', 'просмотры на будущие посты в тг', 'автоматически накручивать просмотры в тг', 'просмотры на новые посты канала', 'подписка на просмотры в тг', 'auto views telegram', 'перегляди на майбутні пости в тг',
  ])('format: "%s" is a wish for Auto / Future Posts labels', (text) => {
    expect(extractIntent(text).auto).toBe(true)
  })
  it.each(['подписчики в тг, чтобы не отваливались', 'просмотры в тг без списаний', 'підписники в тг, щоб не відвалювалися'])('guarantee: "%s" is a wish for Refill / Non-Drop / Real / HQ', (text) => {
    expect(extractIntent(text).refill).toBe(true)
  })
  it('a plain wish has no modifier ("подписки" are followers, not a subscription), so nothing about it changes', () => {
    for (const text of ['просмотры в тг', 'подписчики в тик ток', 'подписки в инсту', 'дешёвые лайки в инсту']) {
      expect(extractIntent(text)).toMatchObject({ slow: false, auto: false })
    }
    expect(searchKinds(extractIntent('просмотры в тг'))).toEqual(['any', 'safe'])
  })
})

describe('2. the search asks for the labels and keeps the base as the closest alternative', () => {
  const intent = extractIntent(WISH)
  const q = (kind: Parameters<typeof buildSearchUrl>[2]) => decodeURIComponent(buildSearchUrl(base, intent, kind)!)

  it('both modifiers: the card with both labels, then each alone, then the base lists (the cheapest and the safe ones)', () => {
    expect(searchKinds(intent)).toEqual(['auto-slow', 'auto', 'slow', 'any', 'safe'])
  })
  it('the request is the base AND one of the labels of each modifier asked for', () => {
    expect(q('auto-slow')).toContain('category.platform.slug=eq.telegram')
    expect(q('auto-slow')).toContain('name.ilike.*view*')
    for (const label of ['auto*view', 'auto*post', 'future', 'subscription', 'slow', 'drip', 'gradual']) expect(q('auto-slow'), label).toContain(`name.ilike.*${label}*`)
    expect(q('auto')).toContain('name.ilike.*future*')
    expect(q('auto')).not.toContain('name.ilike.*slow*')
    expect(q('slow')).toContain('name.ilike.*drip*')
    expect(q('slow')).not.toContain('name.ilike.*future*')
    expect(q('any')).not.toMatch(/slow|future/) // the base list stays as it was
  })
  it('a modifier that was not asked for is not searched', () => {
    expect(buildSearchUrl(base, extractIntent('просмотры в тг'), 'auto')).toBeNull()
    expect(buildSearchUrl(base, extractIntent('просмотры в тг, плавно'), 'auto')).toBeNull()
    expect(searchKinds(extractIntent('просмотры в тг, плавно'))).toEqual(['slow', 'any', 'safe'])
    expect(searchKinds(extractIntent('автопросмотры в тг'))).toEqual(['auto', 'any', 'safe'])
  })
})

describe('3. what the model is shown and told: the labelled cards first, never "we have none"', () => {
  const plain = Array.from({ length: 8 }, (_, i) => view(`p${i}`, `Telegram Views ${i}`, 0.05 + i / 100))
  const labelled = [
    view('g', 'Telegram Post Views | Future 5 Post | Speed 100-200K/Day', 0.12), // format only
    view('f', 'Telegram Auto Post View | Future 10 Posts', 0.6, { dripfeed_available: true }), // format + the drip-feed flag
    view('a', 'Telegram Auto Views Slow [2 per min]', 0.9), // format + speed, both in the name
  ]

  it('ranking: both labels, then label + flag, then one label: all before eight cheaper plain cards; the places left are the base', () => {
    const top = rankServices([...plain, ...labelled], extractIntent(WISH))
    expect(top.map((s) => s.id).slice(0, 3)).toEqual(['a', 'f', 'g'])
    expect(top).toHaveLength(6)
    expect(top.slice(3).every((s) => s.id.startsWith('p'))).toBe(true)
  })
  it('the real catalogue has the format labels (13 cards) and the drip-feed flag (232 cards) but no card with both: both ways are shown, by turns', () => {
    const autoOnly = Array.from({ length: 5 }, (_, i) => view(`x${i}`, `Telegram Post Views | Future ${5 + i} Post | Speed 100-200K/Day`, 0.12 + i / 100))
    const dripOnly = Array.from({ length: 5 }, (_, i) => view(`d${i}`, `Telegram Views ${i}`, 0.3 + i / 100, { dripfeed_available: true }))
    const top = rankServices([...plain, ...dripOnly, ...autoOnly], extractIntent(WISH)).map((s) => s.id)
    expect(top).toHaveLength(6)
    expect(top.filter((id) => id.startsWith('x'))).toHaveLength(3)
    expect(top.filter((id) => id.startsWith('d'))).toHaveLength(3)
    expect(top.slice(0, 2).sort()).toEqual(['d0', 'x0']) // the best of each way comes first
  })
  it('no card carries a label: the base is still returned, the card that can be sent by drip-feed first (the closest to "slow")', () => {
    const closest = view('dd', 'Telegram Views [HQ]', 0.4, { dripfeed_available: true })
    const top = rankServices([...plain, closest], extractIntent(WISH))
    expect(top).toHaveLength(6)
    expect(top[0]!.id).toBe('dd')
  })

  const env = { apiKey: 'k', supabaseUrl: base, anonKey: 'anon', models: [DEFAULT_MODEL, ...FALLBACK_MODELS] }
  const ask = async (rows: (url: string) => StorefrontService[]) => {
    const urls: string[] = []
    const prompts: string[] = []
    const deps: ChatDeps = {
      env,
      fetch: (async (url: string) => {
        const u = decodeURIComponent(String(url))
        urls.push(u)
        return new Response(JSON.stringify(rows(u)), { status: 200 })
      }) as unknown as typeof fetch,
      allow: () => true,
      generate: async ({ system }) => { prompts.push(system); return new Response('ok').body! },
    }
    const res = await handleChat(new Request('https://app.test/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: WISH }] }), headers: { 'x-forwarded-for': '1.2.3.4' } }), deps)
    expect(res.status).toBe(200)
    return { urls, system: prompts[0]! }
  }

  it('a whole request: the labelled cards reach the model first and the note names them; the prompt carries the translation table', async () => {
    const { urls, system } = await ask((u) => (u.includes('auto*view') && u.includes('*slow*') ? [labelled[2]!] : u.includes('auto*view') ? labelled : u.includes('*slow*') ? [labelled[2]!] : plain))
    expect(urls.some((u) => u.includes('auto*view') && u.includes('*slow*') && u.includes('category.platform.slug=eq.telegram'))).toBe(true)
    expect(system.indexOf('TG-VIEW-STD-A |')).toBeGreaterThan(-1)
    expect(system.indexOf('TG-VIEW-STD-A |')).toBeLessThan(system.indexOf('TG-VIEW-STD-P0 |'))
    expect(system).toContain('Запрос разобран на базу и модификаторы. База: telegram / view. Модификаторы: формат Auto / Future Posts + скорость Slow / Drip-feed.')
    expect(system).toContain('Услуги, где совпали все модификаторы: TG-VIEW-STD-A')
    expect(system).toContain('13г. Как читать запрос (база и модификаторы)')
    expect(system).toContain('«медленно», «плавно», «постепенно», «без резких скачков», «порциями» → в названии Slow, Drip, Drip-feed, Gradual или Delay')
    expect(system).toContain('«автоматически», «автопросмотры», «на будущие посты», «на новые посты», «подписка на просмотры» → в названии Auto, Auto Views, Future Posts или Subscription')
    expect(system).toContain('«без списаний», «чтобы не отваливались», «чтобы не падали» → в названии Refill, Non-Drop, Real или HQ')
  })
  it('only a drip-feed card: it is a half match for the speed (the format is missing), and the model is told to say what is missing, not to refuse', async () => {
    const { system } = await ask(() => [...plain, view('dd', 'Telegram Views [HQ]', 0.4, { dripfeed_available: true })])
    expect(system).toContain('Совпадения по всем меткам сразу нет, совпадает часть: TG-VIEW-STD-DD (скорость). Не отказывай: скажи, чего именно нет')
    expect(system).not.toContain('Услуги, где совпали все модификаторы')
  })
  it('no card carries any label: the model is told not to refuse and which cards of the same base are the closest (a quality one, the cheapest)', async () => {
    const { system } = await ask(() => [...plain, view('hq', 'Telegram Views [HQ]', 0.4)])
    expect(system).toContain('Ни в одном названии из списка нет нужных меток (формат Auto / Future Posts + скорость Slow / Drip-feed). Не говори «такого нет» и не отказывай')
    expect(system).toContain('ближайшие услуги этой же базы (из списка: TG-VIEW-STD-HQ, TG-VIEW-STD-P0)')
    expect(system).not.toContain('Услуги, где совпали все модификаторы')
  })
  it('the rule that forbids a refusal before the wish is taken apart, and the word "безопасно" is read as "плавно" but never repeated', () => {
    const prompt = buildSystemPrompt([])
    expect(prompt).toContain('13е. Запрет на отказ до разбора: пока запрос не разобран на базу и модификаторы, не отвечай «нет», «такого нет» или «не могу помочь».')
    expect(prompt).toContain('Если база есть, а точной метки нет')
    expect(prompt).toContain('предложи самую близкую из этой же базы — с drip-feed «да», Premium (💎), HQ или Real')
    expect(prompt).toContain('Слово «безопасно» читай как «плавно, без резких скачков» и ищи те же метки Slow и Drip; само слово «безопасно» в ответе не повторяй: мы не обещаем защиту аккаунта.')
    expect(prompt).toContain('Метки называй только настоящие: из названия и колонок списка.')
  })
})
