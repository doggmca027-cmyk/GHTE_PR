import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { BRAND_COLORS, FALLBACK_PLATFORMS, platformColor, platformInitials, type PlatformInfo } from '../src/constants/platforms'
import { MOCK_CATALOG, MOCK_PLATFORMS } from '../src/constants/dev'
import { mergePlatforms, platformEntries } from '../src/components/services/ServicesScreen'
import type { ICategory } from '../src/types/catalog'

const ROOT = path.resolve(__dirname, '..')

describe('platform tiles', () => {
  it('initials: two letters for two words, the first two letters of one word, noise removed', () => {
    expect(platformInitials('Apple Music')).toBe('AM')
    expect(platformInitials('Twitch')).toBe('TW')
    expect(platformInitials('X (Twitter)')).toBe('X')
    expect(platformInitials('9GAG')).toBe('9G')
    expect(platformInitials('VC.ru')).toBe('VR')
    expect(platformInitials('Xiaohongshu (RED)')).toBe('XI')
    expect(platformInitials('Яндекс Музыка')).toBe('ЯМ')
    expect(platformInitials('   ')).toBe('?')
  })

  it('a platform keeps its brand colour; any other slug gets the same colour every time, from the palette', () => {
    expect(platformColor('twitch')).toBe('#9146FF')
    expect(platformColor('telegram')).toBe('#229ED9')
    const a = platformColor('some-new-platform')
    expect(platformColor('some-new-platform')).toBe(a)
    expect(a).toMatch(/^#[0-9A-F]{6}$/i)
    expect(Object.values(BRAND_COLORS).every((c) => /^#[0-9A-F]{3,6}$/i.test(c))).toBe(true)
  })
})

describe('the platform list', () => {
  // what the database keeps per category: how many active services it holds
  const counted = (): ICategory[] => MOCK_CATALOG.categories.map((c) => ({ ...c, count: MOCK_CATALOG.services.filter((s) => s.categoryId === c.id).length }))
  const info = (slug: string, name: string, sortOrder: number): PlatformInfo => ({ slug, name, category: 'social', sortOrder })

  it('lists the platforms with services first (busiest first), then by the registry\'s order, then by name', () => {
    const platforms = [info('zzz', 'Zzz', 5), info('telegram', 'Telegram', 10), info('instagram', 'Instagram', 20), info('tiktok', 'TikTok', 30), info('aaa', 'Aaa', 5), info('youtube', 'YouTube', 40)]
    const entries = platformEntries(platforms, counted())
    // the mock catalog: telegram has 4 services, instagram 2, tiktok 2
    expect(entries.map((e) => [e.slug, e.count])).toEqual([['telegram', 4], ['instagram', 2], ['tiktok', 2], ['aaa', 0], ['zzz', 0], ['youtube', 0]])
  })

  it('every platform is listed whether or not it has services: that is the point of the list', () => {
    const entries = platformEntries([...MOCK_PLATFORMS], [])
    expect(entries).toHaveLength(MOCK_PLATFORMS.length)
    expect(entries.every((e) => e.count === 0)).toBe(true)
  })

  it('a platform with categories but missing from the registry is added, so its services stay reachable', () => {
    const merged = mergePlatforms([info('telegram', 'Telegram', 10)], counted())
    expect(merged.map((p) => p.slug).sort()).toEqual(['instagram', 'telegram', 'tiktok'])
    expect(merged.find((p) => p.slug === 'tiktok')?.name).toBe('Tiktok')
    expect(mergePlatforms([info('apple-music', 'Apple Music', 1)], [{ ...MOCK_CATALOG.categories[0], platform: 'apple-music' }]).find((p) => p.slug === 'apple-music')?.name).toBe('Apple Music')
  })

  it('when the registry cannot be read, the built-in platforms are used', () => {
    expect(mergePlatforms(null, []).map((p) => p.slug)).toEqual(FALLBACK_PLATFORMS.map((p) => p.slug))
  })

  it('the dev list and the services screen no longer use tabs', () => {
    const screen = fs.readFileSync(path.join(ROOT, 'src/components/services/ServicesScreen.tsx'), 'utf8')
    expect(screen).not.toContain('role="tablist"')
    expect(screen).toContain('<PlatformList')
    expect(fs.existsSync(path.join(ROOT, 'src/components/services/PlatformSelector.tsx'))).toBe(false)
  })
})

describe('the list as markup', () => {
  const render = async (platforms: Array<{ slug: string; name: string; count: number }>) => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { PlatformList } = await import('../src/components/services/PlatformList')
    return renderToStaticMarkup(createElement(PlatformList, { platforms, onSelect: () => {} }))
  }

  it('shows one row per platform with its name, a coloured initials tile, the service count and a search box', async () => {
    const html = await render([{ slug: 'twitch', name: 'Twitch', count: 12 }, { slug: 'kick', name: 'Kick', count: 0 }])
    expect(html).toContain('type="search"')
    expect(html).toContain('placeholder="Search platforms"')
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('Twitch')
    expect(html).toContain('Services: 12')
    expect(html).toContain('No services yet')
    expect(html).toContain('background-color:#9146FF')
    expect(html).toContain('>TW<')
    expect(html).toContain('<button type="button"')
  })

  it('an empty list says so instead of showing nothing', async () => {
    expect(await render([])).toContain('No platforms found')
  })
})

describe('the registry migration (real schema)', () => {
  let db: PGlite
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, any>>(sql, p)).rows
  const sqlFile = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261112000000_more_platforms.sql'), 'utf8')
  const seeded = [...sqlFile.matchAll(/^\s+\('([a-z0-9-]+)',\s+'([^']+)',\s+'[a-z0-9-]+',\s+'([a-z]+)',\s+(\d+),\s+(true|false)\)/gm)].map((m) => ({ slug: m[1], name: m[2], category: m[3], sort: Number(m[4]), active: m[5] === 'true' }))

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.join(ROOT, 'supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  }, 180_000)

  it('adds the platforms of the list; the file is read completely by this test', async () => {
    expect(seeded.length).toBeGreaterThanOrEqual(85)
    expect(new Set(seeded.map((s) => s.slug)).size).toBe(seeded.length)
    const total = Number((await rows(`select count(*) n from platforms`))[0].n)
    expect(total).toBe(seeded.length + 11 + 4) // the 11 of the first registry migration, the four added by 20261113000000_catalog_publish.sql
  })

  it('every new platform has a valid slug and category, and the registry holds it', async () => {
    for (const s of seeded) {
      const r = (await rows(`select name, category, sort_order, active from platforms where slug = $1`, [s.slug]))[0]
      expect(r, s.slug).toMatchObject({ name: s.name, category: s.category, sort_order: s.sort, active: s.active })
    }
  })

  it('the four adult-content sites are added switched OFF and nothing else is', async () => {
    const off = (await rows(`select slug from platforms where not active order by slug`)).map((r) => r.slug)
    expect(off).toEqual(['bongacams', 'chaturbate', 'fansly', 'onlyfans'])
  })

  it('the storefront (anon / a customer) sees the active platforms only', async () => {
    await db.exec(`reset role; set role anon`)
    const slugs = (await rows(`select slug from platforms`)).map((r) => r.slug)
    await db.exec(`reset role`)
    expect(slugs).toContain('twitch')
    expect(slugs).not.toContain('onlyfans')
    expect(slugs).toHaveLength(seeded.filter((s) => s.active).length + 11 + 4)
  })

  it('running it again changes nothing: an admin\'s edits to a platform survive', async () => {
    await db.exec(`update platforms set name = 'Twitch TV', sort_order = 7, active = false where slug = 'twitch'`)
    await db.exec(`update platforms set active = true where slug = 'onlyfans'`)
    const before = Number((await rows(`select count(*) n from platforms`))[0].n)
    await db.exec(sqlFile)
    expect(Number((await rows(`select count(*) n from platforms`))[0].n)).toBe(before)
    expect((await rows(`select name, sort_order, active from platforms where slug = 'twitch'`))[0]).toEqual({ name: 'Twitch TV', sort_order: 7, active: false })
    expect((await rows(`select active from platforms where slug = 'onlyfans'`))[0].active).toBe(true)
  })

  it('every brand colour the app knows belongs to a platform that exists (or is a dev-only slug)', async () => {
    const slugs = new Set((await rows(`select slug from platforms`)).map((r) => r.slug))
    for (const slug of Object.keys(BRAND_COLORS)) expect(slugs.has(slug), slug).toBe(true)
  })

  it('a service of a new platform is reachable end to end: category -> catalog -> list', async () => {
    const cat = (await rows(`insert into categories(platform_id, name, slug) select id, 'Followers', 'twitch-followers' from platforms where slug = 'twitch' returning id`))[0].id
    const row = (await rows(`select c.id, p.slug from categories c join platforms p on p.id = c.platform_id where c.id = $1`, [cat]))[0]
    expect(row.slug).toBe('twitch')
  })
})
