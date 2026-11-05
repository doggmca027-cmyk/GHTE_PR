// The price rules are read page by page: PostgREST answers at most 1000 rows to one request, so a loader that asks once prices every card with the first thousand
// rules only (which is what hundreds of per-card market floors would otherwise cause). The sync, the quote and the order all read through loadPriceRules.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPriceRules, RULE_PAGE } from '../supabase/functions/_shared/order-pricing.ts'

/** A fake database: `total` active rules with ids r0000.., answered the way PostgREST does (at most RULE_PAGE rows, in the order asked, for the range asked). */
function fakeDb(total: number, opts: { failOnPage?: number } = {}) {
  const calls: { from: number; to: number; order: string | null }[] = []
  const rows = Array.from({ length: total }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, type: 'percentage', value: '10.00', platform: i % 2 === 0 ? { slug: 'telegram' } : null, category_id: null, service_id: null, min_rate: null, max_rate: null, min_markup: i === 0 ? '0.1000' : null, min_price: null, name_all: null, name_any: null, priority: 0, is_active: true, quality_scope: null }))
  const db = {
    from: (table: string) => {
      if (table !== 'price_rules') throw new Error(`unexpected table ${table}`)
      const q: { order: string | null } = { order: null }
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: (column: string) => { q.order = column; return chain },
        range: (from: number, to: number) => {
          calls.push({ from, to, order: q.order })
          if (opts.failOnPage !== undefined && calls.length === opts.failOnPage) return Promise.resolve({ data: null, error: { message: 'boom' } })
          return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + RULE_PAGE)), error: null })
        },
      }
      return chain
    },
  }
  return { db, calls }
}

describe('loadPriceRules', () => {
  it('reads every rule when there are more than one page of them', async () => {
    const { db, calls } = fakeDb(2300)
    const rules = await loadPriceRules(db)
    expect(rules).toHaveLength(2300)
    expect(new Set(rules.map((r) => r.id)).size).toBe(2300) // no rule twice, none lost
    expect(calls.map((c) => [c.from, c.to])).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(calls.every((c) => c.order === 'id')).toBe(true) // a stable order, so the pages never overlap
  })

  it('a page of exactly 1000 asks for the next one (which is empty); fewer than 1000 stops', async () => {
    expect((await loadPriceRules(fakeDb(1000).db))).toHaveLength(1000)
    expect(fakeDb(1000).calls).toHaveLength(0)
    const full = fakeDb(1000)
    await loadPriceRules(full.db)
    expect(full.calls).toHaveLength(2)
    const small = fakeDb(12)
    await loadPriceRules(small.db)
    expect(small.calls).toHaveLength(1)
    expect((await loadPriceRules(fakeDb(0).db))).toEqual([])
  })

  it('turns the rows into rules: numbers are numbers, the platform is its slug', async () => {
    const [first, second] = await loadPriceRules(fakeDb(2).db)
    expect(first).toMatchObject({ id: 'r00000', value: 10, platform: 'telegram', min_markup: 0.1, min_price: null })
    expect(second!.platform).toBeNull()
  })

  it('a failed page fails the load (a half-read set of rules is never used)', async () => {
    await expect(loadPriceRules(fakeDb(2300, { failOnPage: 2 }).db)).rejects.toThrow(/load price_rules: boom/)
  })
})

describe('who reads the rules', () => {
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')
  it('sync-catalog, quote-order and place-order price with the same paged loader, not a request of their own', () => {
    expect(src('supabase/functions/sync-catalog/index.ts')).toContain('loadPriceRules(db)')
    expect(src('supabase/functions/sync-catalog/index.ts')).not.toMatch(/from\('price_rules'\)\.select/)
    for (const f of ['supabase/functions/quote-order/index.ts', 'supabase/functions/place-order/index.ts']) expect(src(f)).toContain('loadPriceRules')
  })
})
