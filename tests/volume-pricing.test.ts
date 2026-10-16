// @vitest-environment jsdom
// Volume (tiered) pricing: the rate per 1000 depends on the quantity; the quote and the charge come from calculate_order_price.
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toQuoteDto } from '../supabase/functions/_shared/discounts.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TIERS = [{ min: 0, margin: 0.8 }, { min: 1000, margin: 0.4 }, { min: 10000, margin: 0.25 }, { min: 100000, margin: 0.15 }]
const SVC = '00000000-0000-4000-8000-0000000000f1'
const NOBODY = '00000000-0000-4000-8000-0000000000aa'

describe('volume pricing (SQL)', () => {
  let db: PGlite
  const price = async (quantity: number, costPer1000 = 1) =>
    (await db.query<{ r: Record<string, unknown> }>(`select calculate_order_price($1::uuid, $2::uuid, $3, $4) r`, [NOBODY, SVC, quantity, Math.round(costPer1000 * quantity) / 1000])).rows[0].r
  const setTiers = (t: unknown) => db.query(`update platform_settings set volume_margin_tiers = $1::jsonb where id = 1`, [t === null ? null : JSON.stringify(t)])

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    await db.exec(`
      insert into providers(id, name, api_url) values ('00000000-0000-4000-8000-0000000000a1', 'A', 'https://a');
      insert into categories(id, platform_id, name, slug) values ('00000000-0000-4000-8000-0000000000c1', (select id from platforms where slug = 'telegram'), 'V', 'v');
      insert into provider_services(id, provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values
        ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', '1', 'A', 1.0, 10, 1000000);
      insert into services(id, category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        values ('${SVC}', '00000000-0000-4000-8000-0000000000c1', 'Views', '00000000-0000-4000-8000-0000000000b1', 1.8, 10, 1000000);`)
  }, 180_000)
  afterAll(async () => { await db.close() })

  it('is off by default: every quantity pays the retail rate', async () => {
    expect((await db.query<{ t: unknown }>(`select volume_margin_tiers t from platform_settings where id = 1`)).rows[0].t).toBeNull()
    expect(await price(50_000)).toMatchObject({ list_price: 90, rate_per_1000: 1.8, base_rate_per_1000: 1.8, volume_rates: [] })
  })

  it('the steps of the spec: +80% under 1 000, +40% from 1 000, +25% from 10 000, +15% from 100 000 (on a cost of $1)', async () => {
    await setTiers(TIERS)
    expect(await price(999)).toMatchObject({ rate_per_1000: 1.8, list_price: 1.7982 })
    expect(await price(1000)).toMatchObject({ rate_per_1000: 1.4, list_price: 1.4 })
    expect(await price(9999)).toMatchObject({ rate_per_1000: 1.4 })
    expect(await price(10_000)).toMatchObject({ rate_per_1000: 1.25, list_price: 12.5 })
    expect(await price(100_000)).toMatchObject({ rate_per_1000: 1.15, list_price: 115 })
    expect((await price(500)).volume_rates).toEqual([
      { min_quantity: 0, rate_per_1000: 1.8 }, { min_quantity: 1000, rate_per_1000: 1.4 },
      { min_quantity: 10000, rate_per_1000: 1.25 }, { min_quantity: 100000, rate_per_1000: 1.15 },
    ])
    expect((await price(100_000)).final_price).toBe(115)
  })

  it('a step never sells under the provider cost plus the minimum margin', async () => {
    // a provider cost above what the step would charge: the list price is lifted to cost + min margin
    const r = await price(100_000, 1.2)
    const margin = Number((await db.query<{ m: string }>(`select discount_min_margin_per_1000 m from platform_settings where id = 1`)).rows[0].m)
    expect(Number(r.list_price)).toBeCloseTo(120 + margin * 100, 4)
    expect(Number(r.final_price)).toBeGreaterThanOrEqual(120)
  })

  it('refuses a malformed step list', async () => {
    for (const bad of [[], [{ min: 1, margin: 0.5 }], [{ min: 0, margin: 0.5 }, { min: 0, margin: 0.4 }], [{ min: 0, margin: -1 }], [{ min: 0, margin: '0.5' }], { min: 0 }]) {
      await expect(setTiers(bad), JSON.stringify(bad)).rejects.toThrow(/volume_margin_tiers_check/)
    }
    await setTiers(null)
    expect((await price(50_000)).rate_per_1000).toBe(1.8)
  })

  it('the helpers are not callable by clients, and the cost basis is not readable by them', async () => {
    for (const fn of ['volume_rate(numeric, integer, jsonb, numeric)', 'valid_volume_tiers(jsonb)']) {
      const g = (await db.query<{ a: boolean; u: boolean }>(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u`)).rows[0]
      expect([g.a, g.u]).toEqual([false, false])
    }
    const c = (await db.query<{ a: boolean; u: boolean }>(`select has_column_privilege('anon', 'public.services', 'cost_basis_per_1000', 'select') a, has_column_privilege('authenticated', 'public.services', 'cost_basis_per_1000', 'select') u`)).rows[0]
    expect([c.a, c.u]).toEqual([false, false])
  })

  it('with a known cost the steps scale the SERVICE\'s margin: x1.8 keeps +40/+25/+15, x1.5 goes +25/+15.625/+9.375', async () => {
    await setTiers(TIERS)
    // x1.8 service with its cost basis: identical to before
    await db.query(`update services set cost_basis_per_1000 = 1, customer_rate_per_1000 = 1.8 where id = $1`, [SVC])
    expect((await price(1000)).rate_per_1000).toBe(1.4)
    expect((await price(100_000)).rate_per_1000).toBe(1.15)
    // an expensive service kept at x1.5 (cost $10): the steps go down from ITS margin, never under cost
    await db.query(`update services set cost_basis_per_1000 = 10, customer_rate_per_1000 = 15 where id = $1`, [SVC])
    expect((await price(500, 10)).rate_per_1000).toBe(15)
    expect((await price(1000, 10)).rate_per_1000).toBe(12.5)
    expect((await price(10_000, 10)).rate_per_1000).toBe(11.5625)
    expect((await price(100_000, 10)).rate_per_1000).toBe(10.9375)
    // without the cost basis the old proportion would go under cost (15 x 1.15 / 1.8 = 9.5834): the floor lifts it
    await db.query(`update services set cost_basis_per_1000 = null where id = $1`, [SVC])
    expect(Number((await price(100_000, 10)).list_price)).toBeGreaterThanOrEqual(1000)
    await db.query(`update services set customer_rate_per_1000 = 1.8 where id = $1`, [SVC])
    await setTiers(null)
  })
})

describe('quote and display', () => {
  it('the quote carries the rate of this quantity and every step', () => {
    const q = toQuoteDto({ list_price: 14, final_price: 14, tier_discount: 0, promo_discount: 0, rate_per_1000: 1.4, base_rate_per_1000: 1.8,
      volume_rates: [{ min_quantity: 0, rate_per_1000: 1.8 }, { min_quantity: 1000, rate_per_1000: 1.4 }] })
    expect(q).toMatchObject({ ratePer1000: 1.4, baseRatePer1000: 1.8, volumeRates: [{ minQuantity: 0, ratePer1000: 1.8 }, { minQuantity: 1000, ratePer1000: 1.4 }] })
    expect(toQuoteDto({ list_price: 1, final_price: 1 })).not.toHaveProperty('ratePer1000') // an old answer keeps its old shape
  })

  it('the bulk price list marks the step the quantity falls in', async () => {
    const { VolumeRates } = await import('../src/components/services/PriceSummary')
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(VolumeRates, { quantity: 25_000, steps: [{ minQuantity: 0, ratePer1000: 1.8 }, { minQuantity: 1000, ratePer1000: 1.4 }, { minQuantity: 10000, ratePer1000: 1.25 }] })))
    const items = [...host.querySelectorAll('li')]
    expect(items.map((li) => li.textContent)).toEqual(['from 1 · $1.80', 'from 1,000 · $1.40', 'from 10,000 · $1.25'])
    expect(items.findIndex((li) => li.getAttribute('aria-current') === 'true')).toBe(2)
    act(() => root.unmount())
  })
})
