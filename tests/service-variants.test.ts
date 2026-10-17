// @vitest-environment jsdom
// Service variants: automatic grouping by name (SQL), the catalogue query, and the switches on the card.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CATEGORY_SELECT, serviceFromRow } from '../src/services/api/services'
import { variantLabels } from '../src/components/services/VariantCard'

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

  it('labels: Economy / Standard / Premium, and named steps (never numbers) in larger groups', () => {
    expect(variantLabels(2)).toEqual(['Economy', 'Premium'])
    expect(variantLabels(3)).toEqual(['Economy', 'Standard', 'Premium'])
    expect(variantLabels(4)).toEqual(['Economy', 'Basic', 'Standard', 'Premium'])
    expect(variantLabels(10)).toEqual(['Economy', 'Basic', 'Standard', 'Optimal', 'Advanced', 'Pro', 'Ultra', 'Elite', 'Max', 'Premium'])
    for (let n = 2; n <= 10; n++) {
      expect(new Set(variantLabels(n)).size).toBe(n)
      expect(variantLabels(n).join(' ')).not.toMatch(/\d/)
    }
  })

  it('the switches change the shown variant, and ordering opens the chosen one', async () => {
    const { VariantCard } = await import('../src/components/services/VariantCard')
    const service = { ...serviceFromRow({ ...row('main', 1, 'Members [refill: 30 days]'), variants: [row('p', 2, 'Members [refill: 365 days]')] }) }
    const onSelect = vi.fn()
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(VariantCard, { service, platform: 'telegram', onSelect })))
    const radios = [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[]
    expect(radios.map((r) => r.textContent)).toEqual(['Economy$1.00', 'Premium$2.00'])
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
