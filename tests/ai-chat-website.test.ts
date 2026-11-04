// A request about a website (SEO, "в топ поиска", "продвижение сайта") is a request for the Website Traffic category, not a refusal: the assistant
// finds the platform by itself and its prompt says that sites are its business too.
import { describe, expect, it } from 'vitest'
import { buildSearchUrl, buildSystemPrompt, extractIntent } from '../api/_lib/chat-rag'

describe('a website request is read as Website Traffic', () => {
  it.each([
    'хочу продвинуть сайт в топ',
    'нужно SEO для моего сайта',
    'вывести сайт в топ поиска',
    'вывод в топ гугла',
    'продвижение сайта',
    'раскрутка сайта недорого',
    'трафик на сайт',
    'трафік на сайт з України',
    'need seo for my website',
    'how to rank my site on google',
    'нужны посетители на интернет-магазин',
    'поднять лендинг в выдаче',
  ])('%s', (text) => {
    const intent = extractIntent(text)
    expect(intent.platform).toBe('website')
    expect(intent.actions).toContain('traffic')
  })

  it('classic SEO words alone also mean web traffic, with or without a platform', () => {
    expect(extractIntent('seo').actions).toContain('traffic')
    expect(extractIntent('вывести в топ выдачи').actions).toContain('traffic')
  })

  it('the search looks at the Website platform', () => {
    expect(decodeURIComponent(buildSearchUrl('https://x.supabase.co', extractIntent('продвинуть сайт в топ')) ?? '')).toContain('website')
  })

  it('a social request that mentions a site stays on its platform, and plain requests are untouched', () => {
    expect(extractIntent('подписчики в инсту для моего сайта').platform).toBe('instagram')
    expect(extractIntent('нужны подписчики в тг').platform).toBe('telegram')
    expect(extractIntent('дешевые лайки').platform).toBeNull()
    expect(extractIntent('сайдинг и сайдбар').platform).toBeNull()
  })
})

describe('the prompt about sites', () => {
  const prompt = buildSystemPrompt([])
  it('names sites as part of the job, with the category', () => {
    expect(prompt).toContain('не только соцсети (Telegram, Instagram, YouTube, TikTok и другие), но и сайты')
    expect(prompt).toContain('«Website Traffic» / «Веб-трафик»')
  })
  it('forbids the blind refusal and sends a website request to Website Traffic', () => {
    expect(prompt).toContain('никогда не отвечай «у нас нет таких услуг»')
    expect(prompt).toContain('строго предлагай услуги категории «Website Traffic» / «Веб-трафик» из списка')
  })
  it('turns the expectation of SEO into an offer of two or three traffic variants, without promising positions', () => {
    expect(prompt).toContain('Мы не занимаемся прямой SEO-оптимизацией кода, но можем направить качественный целевой трафик на ваш сайт')
    expect(prompt).toContain('предложи 2–3 варианта веб-трафика')
    expect(prompt).toContain('Не обещай конкретных позиций')
  })
  it('the off-topic refusal stays, but 13а has already taken sites out of it, and the list is still last', () => {
    expect(prompt).toContain('а не «не по теме»')
    expect(prompt.indexOf('13в.')).toBeLessThan(prompt.indexOf('КОНФИДЕНЦИАЛЬНОСТЬ'))
  })
})
