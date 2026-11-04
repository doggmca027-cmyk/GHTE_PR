// Translated service names (migration 20270102000000, scripts/translate-service-names.ts): what the translator accepts, what the database keeps,
// and that nothing that syncs the catalogue with the providers can touch the column.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPrompt, cleanTranslation, parseBatch, saveTranslationsSql, selectUntranslatedSql, TARGET_LANGUAGES } from '../scripts/lib/translate-names.ts'
import { LANGUAGES } from '../src/i18n/languages'

const root = path.resolve(__dirname, '..')
const dir = path.join(root, 'supabase/migrations')
const MIGRATION = '20270102000000_name_translations.sql'
const CATEGORY = '00000000-0000-4000-8000-0000000a00e1'

describe('the translator: languages and prompt', () => {
  it('translates into every language of the app but English, and into nothing else', () => {
    expect(Object.keys(TARGET_LANGUAGES).sort()).toEqual(LANGUAGES.map((l) => l.code).filter((c) => c !== 'en').sort())
  })
  it('numbers the names and tells Gemini what must stay', () => {
    const prompt = buildPrompt(['Website Traffic | Real | 100K', 'Telegram Members'], ['ru', 'es'])
    expect(prompt).toContain('0. Website Traffic | Real | 100K')
    expect(prompt).toContain('1. Telegram Members')
    expect(prompt).toContain('ru (Russian), es (Spanish)')
    expect(prompt).toMatch(/every number of the English name must appear unchanged/)
    expect(prompt).toMatch(/nothing the English name does not say/)
  })
})

describe('what the translator accepts', () => {
  it('a plain translation, trimmed and on one line', () => {
    expect(cleanTranslation('Website Traffic', '  Трафик\nна сайт ')).toBe('Трафик на сайт')
  })
  it.each([
    ['not text', 5], ['empty', '  '], ['markup', 'Tráfico <b>web</b>'], ['a backtick', 'Tráfico `web`'], ['a control character', 'Tráfico\u0007web'],
    ['the end of the SQL literal', 'Tráfico $tr$ web'], ['too long', 'x'.repeat(221)],
  ])('refuses %s', (_why, value) => {
    expect(cleanTranslation('Website Traffic', value)).toBeNull()
  })
  it('refuses a translation that loses or changes a number of the name', () => {
    expect(cleanTranslation('Instagram Followers 100K [Refill: 30 days]', 'Seguidores de Instagram 100K [Refill: 30 días]')).not.toBeNull()
    expect(cleanTranslation('Instagram Followers 100K [Refill: 30 days]', 'Seguidores de Instagram 10K [Refill: 30 días]')).toBeNull()
    expect(cleanTranslation('Instagram Followers 100K [Refill: 30 days]', 'Seguidores de Instagram [Refill]')).toBeNull()
  })
})

describe('what is made of the answer of Gemini', () => {
  const batch = [{ id: 'a', name: 'Website Traffic' }, { id: 'b', name: 'Followers 10K' }]
  it('keeps the clean translations of the names and languages that were asked for', () => {
    const raw = JSON.stringify([{ i: 0, tr: { ru: 'Трафик на сайт', es: 'Tráfico web', xx: 'no such language' } }, { i: 1, tr: { ru: 'Подписчики 10K' } }])
    const out = parseBatch(raw, batch, ['ru', 'es'])
    expect(out.get('a')).toEqual({ ru: 'Трафик на сайт', es: 'Tráfico web' })
    expect(out.get('b')).toEqual({ ru: 'Подписчики 10K' })
  })
  it('takes the answer in a markdown fence and drops what is wrong: bad numbers, unknown positions, not an array, not JSON', () => {
    const fenced = '```json\n' + JSON.stringify([{ i: 1, tr: { ru: 'Подписчики 100K' } }, { i: 7, tr: { ru: 'x' } }, { i: 0, tr: { ru: 'Трафик' } }]) + '\n```'
    const out = parseBatch(fenced, batch, ['ru'])
    expect([...out.keys()]).toEqual(['a'])
    expect(parseBatch('{"i":0}', batch, ['ru']).size).toBe(0)
    expect(parseBatch('sorry, I cannot', batch, ['ru']).size).toBe(0)
  })
  it('the cards to translate are the active Premium ones without translations, Premium first; --all adds the rest', () => {
    expect(selectUntranslatedSql(100, false)).toMatch(/is_active and is_premium and name_translations = '\{\}'::jsonb/)
    expect(selectUntranslatedSql(100, true)).not.toMatch(/and is_premium and/)
    expect(selectUntranslatedSql(100, true)).toMatch(/order by is_premium desc, id limit 100/)
    expect(selectUntranslatedSql(10 ** 9, false)).toMatch(/limit 2000/)
  })
})

describe('in the database', () => {
  let db: PGlite
  let source: string
  const card = async (name: string) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active) values ($1, $2, $3, 1, 10, 1000, true) returning id`, [CATEGORY, name, source])).rows[0].id
  const translations = async (id: string) => (await db.query<{ t: Record<string, string> }>(`select name_translations t from services where id = $1`, [id])).rows[0].t

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers (id, name, api_url) values ('00000000-0000-4000-8000-0000000a0003', 'RootPanel', 'https://r');
      insert into categories (id, platform_id, name, slug) values ('${CATEGORY}', (select id from platforms where slug = 'website'), 'Website Traffic', 'website-tr');`)
    source = (await db.query<{ id: string }>(`insert into provider_services (provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('00000000-0000-4000-8000-0000000a0003', 'x1', 'x', 1, 10, 1000) returning id`)).rows[0].id
  }, 240_000)
  afterAll(async () => { await db.close() })

  it('every card starts with no translations, and the column holds an object and nothing else', async () => {
    const id = await card('Website Traffic | Real')
    expect(await translations(id)).toEqual({})
    await expect(db.query(`update services set name_translations = '[]'::jsonb where id = $1`, [id])).rejects.toThrow()
    await expect(db.query(`update services set name_translations = 'null'::jsonb where id = $1`, [id])).rejects.toThrow()
  })

  it('the translator saves by merging, and only for the English name it translated', async () => {
    const id = await card('Website Traffic | Organic')
    const sql = (tr: Record<string, string>, name = 'Website Traffic | Organic') => saveTranslationsSql([{ id, name, tr }])!
    await db.exec(sql({ ru: 'Трафик на сайт | Органический' }))
    await db.exec(sql({ es: 'Tráfico web | Orgánico' }))
    expect(await translations(id)).toEqual({ ru: 'Трафик на сайт | Органический', es: 'Tráfico web | Orgánico' })
    await db.exec(sql({ de: 'Veraltet' }, 'An older English name'))
    expect(await translations(id)).not.toHaveProperty('de') // the card was renamed in between: a stale answer is dropped
  })

  it('a name with a quote or a dollar sign goes through whole', async () => {
    const name = `Website Traffic | Owner's "Best" $5 pack`
    const id = await card(name)
    await db.exec(saveTranslationsSql([{ id, name, tr: { fr: `Trafic du site | Pack "Best" de l'équipe $5` } }])!)
    expect((await translations(id)).fr).toBe(`Trafic du site | Pack "Best" de l'équipe $5`)
  })

  it('what the sync does leaves them: a price, a status, a limit, the segments', async () => {
    const id = await card('Website Traffic | Lifetime')
    await db.exec(saveTranslationsSql([{ id, name: 'Website Traffic | Lifetime', tr: { ru: 'Трафик на сайт | Пожизненный' } }])!)
    await db.query(`update services set customer_rate_per_1000 = 2.5, is_active = false, min_quantity = 50, max_quantity = 5000 where id = $1`, [id])
    await db.query(`update services set is_active = true where id = $1`, [id])
    await db.query(`update services set name = name where id = $1`, [id]) // a publish that writes the same name again
    expect(await translations(id)).toEqual({ ru: 'Трафик на сайт | Пожизненный' })
  })

  it('a renamed service loses its translations (they were of the old name), the translator makes them again', async () => {
    const id = await card('Website Traffic | Premium')
    await db.exec(saveTranslationsSql([{ id, name: 'Website Traffic | Premium', tr: { ru: 'Трафик на сайт | Премиум' } }])!)
    await db.query(`update services set name = 'Website Traffic | Premium v2' where id = $1`, [id])
    expect(await translations(id)).toEqual({})
    await db.exec(saveTranslationsSql([{ id, name: 'Website Traffic | Premium v2', tr: { ru: 'Трафик на сайт | Премиум v2' } }])!)
    expect(await translations(id)).toEqual({ ru: 'Трафик на сайт | Премиум v2' })
  })

  it('anon and authenticated read the column and cannot write it', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ ok: boolean }>(`select has_column_privilege($1, 'public.services', 'name_translations', 'select') ok`, [role])).rows[0].ok).toBe(true)
      expect((await db.query<{ ok: boolean }>(`select has_column_privilege($1, 'public.services', 'name_translations', 'update') ok`, [role])).rows[0].ok).toBe(false)
    }
  })
})

describe('nothing that syncs the catalogue names the column', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  it('the Edge Functions and the migrations before it never write name_translations (only the translator and this migration do)', () => {
    const files = [...walk(path.join(root, 'supabase/functions')), ...fs.readdirSync(dir).filter((f) => f < MIGRATION).map((f) => path.join(dir, f))]
    const offenders = files.filter((f) => /name_translations/.test(fs.readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
  it('the later migrations that copy cards (publish, canonical publish) set their own columns, never the whole row', () => {
    for (const f of ['20261113000000_catalog_publish.sql', '20261205000000_canonical_publish.sql']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/set\s+\(?\s*\*|row\(\s*excluded\.\*/i)
    }
  })
})
