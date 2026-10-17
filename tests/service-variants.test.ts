// @vitest-environment jsdom
// Service variants: automatic grouping by name (SQL), the catalogue query, and the switches on the card.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CATEGORY_SELECT, serviceFromRow } from '../src/services/api/services'
import { nameTags, variantDiffLabels } from '../src/lib/variants'
import type { ICatalogService } from '../src/types/catalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('grouping (SQL)', () => {
  let db: PGlite
  let seq = 0
  const key = async (name: string) => (await db.query<{ k: string }>(`select service_group_key($1) k`, [name])).rows[0].k
  const svc = async (cat: string, name: string, rate: number) =>
    (await db.query<{ id: string }>(`insert into services (category_id, name, customer_rate_per_1000, min_quantity, max_quantity, sort_order, primary_provider_service_id)
      values ($1, $2, $3, 10, 1000, $4, '00000000-0000-4000-8000-0000000000b1') returning id`, [cat, name, rate, ++seq])).rows[0].id
  const variant = async (id: string) => (await db.query<{ p: string | null; r: number | null }>(`select parent_service_id p, variant_rank r from services where id = $1`, [id])).rows[0]
  let cat: string, cat2: string

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const mk = async (slug: string) => (await db.query<{ id: string }>(`insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), $1, $1) returning id`, [slug])).rows[0].id
    await db.exec(`insert into providers(id, name, api_url) values ('00000000-0000-4000-8000-0000000000a1', 'A', 'https://a');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', '1', 'A', 0.5, 10, 100000);`)
    cat = await mk('members')
    cat2 = await mk('views')
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('the key drops what only describes quality, keeps what says what is delivered', async () => {
    expect(await key('Telegram Members [refill: 30 days] [high quality] [China]')).toBe('telegram members [china]')
    expect(await key('Telegram Members [refill: 90 days] [China]')).toBe('telegram members [china]')
    expect(await key('Spotify Free Plays [no refill] [start: instant] [United States] [lowest price] [server 2]')).toBe('spotify free plays [united states] [lowest price]')
    // a part that names the delivered amount stays, even with a quality word in it
    expect(await key('TikTok Comments [no refill] [3 quality random comments] [max: 3]')).not.toBe(await key('TikTok Comments [no refill] [6 quality random comments] [max: 6]'))
    expect(await key('Telegram Post Views [last 100 posts]')).not.toBe(await key('Telegram Post Views [last 200 posts]'))
  })

  it('groups a category\'s same-key services, cheapest first; the cheapest is the main service', async () => {
    const a = await svc(cat, 'Telegram Members [refill: 30 days] [China]', 3)
    const b = await svc(cat, 'Telegram Members [refill: 90 days] [China]', 2)
    const c = await svc(cat, 'Telegram Members [refill: 30 days] [premium quality] [China]', 4)
    const alone = await svc(cat, 'Telegram Members [India]', 1)
    const other = await svc(cat2, 'Telegram Members [refill: 30 days] [China]', 1) // another category: never merged
    const r = (await db.query<{ r: Record<string, number> }>(`select regroup_service_variants() r`)).rows[0].r
    expect(r).toMatchObject({ groups: 1, services_in_groups: 3 })
    expect(await variant(b)).toEqual({ p: null, r: 1 })
    expect(await variant(a)).toEqual({ p: b, r: 2 })
    expect(await variant(c)).toEqual({ p: b, r: 3 })
    expect(await variant(alone)).toEqual({ p: null, r: null })
    expect(await variant(other)).toEqual({ p: null, r: null })
  })

  it('same full names (a niche the name does not show) and groups over 10 stay apart', async () => {
    const same = [await svc(cat2, 'YouTube Likes [refill: lifetime] [high quality]', 3), await svc(cat2, 'YouTube Likes [refill: lifetime] [high quality]', 3)]
    const many = []
    for (let i = 0; i < 11; i++) many.push(await svc(cat2, `Instagram Views [server ${i}]`, 1 + i / 10))
    await db.query(`select regroup_service_variants()`)
    for (const id of [...same, ...many]) expect(await variant(id)).toEqual({ p: null, r: null })
  })

  it('switching the main service off hands the group to the next cheapest; a regroup is stable', async () => {
    const { rows } = await db.query<{ id: string }>(`select id from services where parent_service_id is null and variant_rank = 1`)
    const main = rows[0].id
    const children = (await db.query<{ id: string }>(`select id from services where parent_service_id = $1 order by variant_rank`, [main])).rows.map((r) => r.id)
    await db.query(`update services set is_active = false where id = $1`, [main])
    expect((await variant(children[0])).p).toBeNull()
    expect((await variant(children[1])).p).toBe(children[0])
    const again = (await db.query<{ r: Record<string, number> }>(`select regroup_service_variants() r`)).rows[0].r
    expect(again).toMatchObject({ groups: 1, services_in_groups: 2 })
    expect((await db.query<{ r: Record<string, number> }>(`select regroup_service_variants() r`)).rows[0].r).toMatchObject({ rows_changed: 0, rows_cleared: 0 })
  })

  it('clients read the group columns; only the service role regroups', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const col of ['parent_service_id', 'variant_rank']) {
        expect((await db.query<{ p: boolean }>(`select has_column_privilege('${role}', 'public.services', '${col}', 'select') p`)).rows[0].p).toBe(true)
      }
      expect((await db.query<{ p: boolean }>(`select has_function_privilege('${role}', 'regroup_service_variants()', 'execute') p`)).rows[0].p).toBe(false)
    }
  })
})

describe('catalogue and card', () => {
  const row = (id: string, rate: number, name = `S ${id}`) => ({ id, category_id: 'c', name, description: null, customer_rate_per_1000: rate, min_quantity: 10, max_quantity: 1000, refill_supported: false, sort_order: 0 })

  it('a category page embeds the active variants of each main service, cheapest first', () => {
    expect(CATEGORY_SELECT).toContain('variants:services!parent_service_id(')
    const s = serviceFromRow({ ...row('main', 1), variants: [row('dear', 3), row('mid', 2)] })
    expect(s.variants?.map((v) => v.id)).toEqual(['mid', 'dear'])
    expect(serviceFromRow({ ...row('solo', 1), variants: [] })).not.toHaveProperty('variants')
  })

  const v = (id: string, rate: number, name: string, attributes: ICatalogService['attributes'] = {}, maxQuantity = 1000): ICatalogService =>
    ({ id, categoryId: 'c', name, description: null, ratePer1000: rate, minQuantity: 10, maxQuantity, refillSupported: false, sortOrder: 0, attributes })
  const labels = (list: ICatalogService[]) => variantDiffLabels(list, 'en', 'en-US')

  it('a switch says what sets the variant apart, never a made-up grade: the guarantee first', () => {
    expect(labels([v('a', 0.03, 'Likes [no refill]', { refill: 'none' }), v('b', 0.05, 'Likes [refill: 7 days]', { refill: 7 }), v('c', 0.08, 'Likes [refill: 30 days]', { refill: 30 }), v('d', 0.12, 'Likes [refill: 365 days]', { refill: 365 })]))
      .toEqual(['No refill', '♻️ 7 days', '♻️ 30 days', '♻️ 365 days'])
    expect(labels([v('a', 1, 'X', { refill: 'lifetime' }), v('b', 2, 'X', { refill: 30 })])).toEqual(['♻️ Lifetime', '♻️ 30 days'])
    for (const l of labels([v('a', 1, 'A'), v('b', 2, 'B', {}, 5000)])) expect(l).not.toMatch(/Economy|Premium|Standard|Basic/)
  })

  it('the same guarantee: the next property that differs (quality, speed, countries, the largest order)', () => {
    expect(labels([v('a', 1, 'Followers', { refill: 30 }), v('b', 2, 'Followers [real]', { refill: 30, real: true })])).toEqual(['', 'Real'])
    expect(labels([v('a', 1, 'F', { refill: 30, speed: 5000 }), v('b', 2, 'F', { refill: 30, speed: 50000 })])).toEqual(['5K/day', '50K/day'])
    expect(labels([v('a', 1, 'F', { geo: ['US'] }), v('b', 2, 'F', { geo: ['RU'] })])).toEqual(['US', 'RU'])
    expect(labels([v('a', 1, 'F', {}, 1000), v('b', 2, 'F', {}, 50000)])).toEqual(['up to 1K', 'up to 50K'])
  })

  it('a second property only where the first leaves two variants alike', () => {
    expect(labels([
      v('a', 0.27, 'R [no refill] [speed: 10 K/day]', { refill: 'none', speed: 10000 }),
      v('b', 0.28, 'R [no refill] [speed: 5000/day]', { refill: 'none', speed: 5000 }),
      v('c', 0.98, 'R [refill: 30 days] [speed: 5000/day]', { refill: 30, speed: 5000 }),
    ])).toEqual(['No refill · 10K/day', 'No refill · 5K/day', '♻️ 30 days'])
  })

  it('nothing in the facts: a tag of its own name the others do not have ("1 Hour" / "2 Hours"); server tags never count', () => {
    expect(nameTags('W.TV Live Stream Views [HQ | 1 Hour | 10–2000] [server 2]')).toEqual(['HQ', '1 Hour', '10–2000'])
    expect(labels([v('a', 1.1, 'W.TV Views [HQ | 1 Hour | Drop 0–30%]'), v('b', 2.2, 'W.TV Views [HQ | 2 Hours | Drop 0–30%]')])).toEqual(['1 Hour', '2 Hours'])
    expect(labels([v('a', 1, 'Same [server 1]'), v('b', 2, 'Same [server 2]')])).toEqual(['', '']) // the price tells them apart
  })

  it('the switches change the shown variant, and ordering opens the chosen one', async () => {
    const { VariantCard } = await import('../src/components/services/VariantCard')
    const service = { ...serviceFromRow({ ...row('main', 1, 'Members [refill: 30 days]'), attributes: { refill: 30 }, variants: [{ ...row('p', 2, 'Members [refill: 365 days]'), attributes: { refill: 365 } }] }) }
    const onSelect = vi.fn()
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(VariantCard, { service, platform: 'telegram', onSelect })))
    const radios = [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[]
    expect(radios.map((r) => r.textContent)).toEqual(['♻️ 30 days$1.00', '♻️ 365 days$2.00'])
    // the card states the guarantee instead of a guessed speed grade
    expect(host.querySelector('[data-testid="service-badges"]')?.textContent).toContain('Recovery: 30 days')
    expect(host.textContent).not.toMatch(/Economy|Premium|Standard/)
    expect(host.textContent).toContain('Members [refill: 30 days]')
    act(() => radios[1].click())
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Members [refill: 365 days]')
    const card = [...host.querySelectorAll('button')].find((b) => !b.getAttribute('role'))!
    act(() => card.click())
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }))
    act(() => root.unmount())
  })
})
