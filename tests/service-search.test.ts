import { describe, expect, it } from 'vitest'
import { countryCodes, parseServiceQuery, serviceMatches, serviceSearchFilter } from '../src/lib/service-search'
import { describeService, describeServiceFacts, serviceCountries } from '../src/lib/service-view'

const svc = (name: string, extra: { ru?: string; geo?: string[]; description?: string } = {}) => ({
  name,
  description: extra.description ?? null,
  nameI18n: extra.ru ? { ru: extra.ru } : undefined,
  attributes: extra.geo ? { geo: extra.geo } : undefined,
})

describe('country names', () => {
  it('are found in several languages and by the short forms people type', () => {
    expect(countryCodes('germany')).toContain('DE')
    expect(countryCodes('Германия')).toContain('DE')
    expect(countryCodes('united states')).toContain('US')
    expect(countryCodes('США')).toContain('US')
    expect(countryCodes('usa')).toEqual(['US'])
    expect(countryCodes('uk')).toEqual(['GB'])
    expect(countryCodes('followers')).toEqual([])
  })
})

describe('parsing a query', () => {
  it('splits words into terms and keeps a multi-word country together', () => {
    expect(parseServiceQuery('instagram likes')).toEqual([{ text: 'instagram', geo: [] }, { text: 'likes', geo: [] }])
    const t = parseServiceQuery('views south korea')
    expect(t).toHaveLength(2)
    expect(t[1]!.geo).toEqual(['KR'])
    expect(parseServiceQuery('  ')).toEqual([])
  })

  it('does not take a short common word for a country, and caps the number of terms', () => {
    expect(parseServiceQuery('in')[0]!.geo).toEqual([])
    expect(parseServiceQuery('de')[0]!.geo).toEqual([])
    expect(parseServiceQuery('a b c d e f g h')).toHaveLength(5)
  })
})

describe('the database filter', () => {
  it('has one OR group per term: names, original name, description, and the geo attribute of a country', () => {
    const f = serviceSearchFilter(parseServiceQuery('views usa'))!
    expect(f).toBe(
      '(or(name.ilike.*views*,name_i18n->>ru.ilike.*views*,description.ilike.*views*),' +
      'or(name.ilike.*usa*,name_i18n->>ru.ilike.*usa*,description.ilike.*usa*,attributes->>geo.ilike.*"US"*))',
    )
  })

  it('cannot be broken by punctuation typed in the query', () => {
    const f = serviceSearchFilter(parseServiceQuery('a),or(id.eq.1 *%'))!
    expect(f).not.toMatch(/\),or\(id/)
    expect(f).not.toContain('%')
    expect(serviceSearchFilter([])).toBeNull()
  })

  it('keeps "й" (the database has "дней", not "днеи") and lets "е" find "ё"', () => {
    expect(parseServiceQuery('60 Дней')).toEqual([{ text: '60', geo: [] }, { text: 'дней', geo: [] }])
    expect(serviceSearchFilter(parseServiceQuery('дешево'))).toContain('name.ilike.*д_ш_во*')
  })
})

describe('matching in memory (the same decision as the filter)', () => {
  const list = [
    svc('Telegram Post Views [United States]', { geo: ['US'] }),
    svc('Telegram Post Views [fast]', { ru: 'Просмотры постов Telegram [Быстро]' }),
    svc('Instagram Followers', { geo: ['DE'] }),
    svc('Premium Members', { description: 'Real members from search' }),
  ]
  const find = (q: string) => list.filter((s) => serviceMatches(s, parseServiceQuery(q))).map((s) => s.name)

  it('finds by words of the name, in any order, all words required', () => {
    expect(find('views telegram')).toEqual(['Telegram Post Views [United States]', 'Telegram Post Views [fast]'])
    expect(find('views fast')).toEqual(['Telegram Post Views [fast]'])
  })
  it('finds by the original Russian name and by the description', () => {
    expect(find('просмотры')).toEqual(['Telegram Post Views [fast]'])
    expect(find('search')).toEqual(['Premium Members'])
  })
  it('finds by country, also when the name does not say it', () => {
    expect(find('germany')).toEqual(['Instagram Followers'])
    expect(find('Германия')).toEqual(['Instagram Followers'])
    expect(find('views usa')).toEqual(['Telegram Post Views [United States]'])
  })
  it('finds nothing for a word that is not there', () => {
    expect(find('tiktok')).toEqual([])
  })
})

describe('the description of a service', () => {
  it('lists each fact with its kind, and describeService gives the same lines', () => {
    const a = { refill: 30, startMax: 0, speed: 1000, drop: 'none' as const, real: true, geo: ['US'] }
    expect(describeServiceFacts(a, 'en-US').map((f) => f.kind)).toEqual(['refill', 'start', 'speed', 'drop', 'real', 'geo'])
    expect(describeService(a, 'en-US')).toEqual(describeServiceFacts(a, 'en-US').map((f) => f.text))
  })
  it('names the countries for a badge, shortened when there are many', () => {
    expect(serviceCountries({ geo: ['US'] }, 'en-US')).toBe('United States')
    expect(serviceCountries({ geo: ['US', 'DE', 'FR'] }, 'en-US')).toBe('United States, Germany…')
    expect(serviceCountries(undefined, 'en-US')).toBe('')
    expect(serviceCountries({}, 'en-US')).toBe('')
  })
})
