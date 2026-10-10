import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The keep-predicate is read from the migration itself and run as JS regexes (Postgres \y is a word boundary = JS \b),
// so the test fails if the SQL is edited back to substring matching.
const SQL = readFileSync('supabase/migrations/20261117000000_curate_catalog.sql', 'utf8')
const body = SQL.slice(SQL.indexOf('and not ('), SQL.indexOf('select count(*) into v_after'))
const patterns = [...body.matchAll(/s\.name (!?)~\* '((?:[^']|'')*)'/g)].map((m) => ({ negated: m[1] === '!', re: new RegExp(m[2]!.replace(/\\y/g, '\\b'), 'i') }))
const refillIdx = patterns.findIndex((p) => p.negated)

/** Same logic as the SQL: any positive pattern, or (refill and not no-refill). */
function kept(name: string): boolean {
  const positives = patterns.filter((p) => !p.negated)
  const refill = positives.find((p) => p.re.source.includes('refill\\b') && !p.re.source.includes('no'))
  const noRefill = patterns[refillIdx]!
  return positives.some((p) => (p === refill ? p.re.test(name) && !noRefill.re.test(name) : p.re.test(name)))
}

describe('curate_catalog migration predicate', () => {
  it.each([
    ['Telegram Members [refill: 30 days] [speed: 10 K/day]', true],
    ['Telegram Members [no refill] [fast]', false],
    ['Instagram Followers [no refill] [10% drop]', false],
    ['Instagram Followers [0% drop] [non drop]', true],
    ['Instagram Followers [20% drop]', false],
    ['Instagram Likes [no refill] [unreal]', false],
    ['Instagram Likes [real] [no refill]', true],
    ['Telegram Premium Members [no refill]', true],
    ['Telegram Post Views [no refill] [fast]', true],
    ['Telegram Reactions [no refill]', true],
    ['Website Traffic from Germany', true],
    ['Spotify Plays [no refill]', true],
    ['Facebook Post Likes [no drops] [high quality]', true],
    ['YouTube Subscribers [no refill] [cheap]', false],
  ])('%s -> %s', (name, expected) => {
    expect(kept(name)).toBe(expected)
  })

  it('only touches active services and never deletes', () => {
    expect(SQL).toMatch(/where s\.is_active\s+and not \(/)
    expect(SQL).not.toMatch(/\bdelete\b/i)
    expect(SQL).toMatch(/v_before >= 30 and v_after < 30/)
  })
})
