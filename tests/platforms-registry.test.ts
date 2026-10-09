import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_PLATFORM_SLUGS, isLegacyPlatform, platformFromRow, type PlatformRow } from '../src/types/platform'

describe('platforms registry (real SQL)', () => {
  let db: PGlite
  let admin: string, user: string, banned: string
  const as = async (role: string, uid: string | null) => {
    await db.exec(`reset role; set role ${role}; select set_config('request.jwt.sub', '${uid ?? ''}', false)`)
  }
  const rows = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    admin = (await rows<{ id: string }>(`insert into users(telegram_id, is_admin) values (1, true) returning id`))[0].id
    user = (await rows<{ id: string }>(`insert into users(telegram_id) values (2) returning id`))[0].id
    banned = (await rows<{ id: string }>(`insert into users(telegram_id, is_admin, is_banned) values (3, true, true) returning id`))[0].id
  }, 120_000)

  it('seeds the platforms; the legacy enum values are all present with the same slug', async () => {
    const all = await rows<{ slug: string; category: string }>(`select slug, category from platforms order by sort_order`)
    // the first registry migration's eleven, in their order (later migrations add more platforms between and after them)
    const first = ['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'spotify', 'discord', 'reddit', 'website', 'other']
    expect(all.map((p) => p.slug).filter((s) => first.includes(s))).toEqual(first)
    expect(all.map((p) => p.slug)).toEqual(expect.arrayContaining([...LEGACY_PLATFORM_SLUGS]))
    expect(await rows(`select 1 from pg_type where typname = 'platform_enum'`)).toHaveLength(0) // the enum is gone: the table is the only source
    expect(Object.fromEntries(all.map((p) => [p.slug, p.category]))).toMatchObject({ spotify: 'music', youtube: 'video', telegram: 'messaging', website: 'web' })
  })

  it('categories reference the registry through platform_id', async () => {
    await db.exec(`insert into categories(platform_id, name, slug) select id, 'Views', 'v' from platforms where slug = 'telegram'`)
    expect(await rows(`select c.id from categories c join platforms p on p.id = c.platform_id`)).toHaveLength(1)
  })

  it('anyone reads active platforms; only admins see inactive ones', async () => {
    await db.exec(`update platforms set active = false where slug = 'reddit'`)
    await as('anon', null)
    const visible = (await rows<{ slug: string }>(`select slug from platforms`)).map((p) => p.slug)
    expect(visible).not.toContain('reddit')
    expect(visible).not.toContain('onlyfans') // added switched off by 20261112000000_more_platforms.sql
    expect(visible).toContain('telegram')
    await db.exec('reset role')
    expect(visible).toHaveLength((await rows<{ n: number }>(`select count(*)::int n from platforms where active`))[0].n)
    await as('anon', null)
    await as('authenticated', user)
    expect((await rows(`select 1 from platforms where slug = 'reddit'`)).length).toBe(0)
    await as('authenticated', banned)
    expect((await rows(`select 1 from platforms where slug = 'reddit'`)).length).toBe(0)
    await as('authenticated', admin)
    expect((await rows(`select 1 from platforms where slug = 'reddit'`)).length).toBe(1)
  })

  it('clients cannot insert, update or delete, not even admins directly; writes go through the audited function', async () => {
    for (const [role, uid] of [['anon', null], ['authenticated', user], ['authenticated', admin]] as const) {
      await as(role, uid)
      await expect(db.query(`insert into platforms(slug, name, category) values ('x1', 'X', 'other')`)).rejects.toThrow()
      await expect(db.query(`update platforms set name = 'hacked'`)).rejects.toThrow()
      await expect(db.query(`delete from platforms`)).rejects.toThrow()
    }
    await db.exec('reset role')
    expect((await rows<{ n: number }>(`select count(*)::int n from platforms where name = 'hacked'`))[0].n).toBe(0)
  })

  it('the admin-only write policies hold even if a write grant is ever added', async () => {
    await db.exec(`grant insert, update, delete on platforms to authenticated`)
    await as('authenticated', user)
    await expect(db.query(`insert into platforms(slug, name, category) values ('x1', 'X', 'other')`)).rejects.toThrow(/row-level security/)
    expect((await db.query(`update platforms set name = 'hacked'`)).affectedRows).toBe(0)
    expect((await db.query(`delete from platforms`)).affectedRows).toBe(0)
    await as('authenticated', banned)
    await expect(db.query(`insert into platforms(slug, name, category) values ('x1', 'X', 'other')`)).rejects.toThrow(/row-level security/)
    await as('authenticated', admin)
    await db.query(`insert into platforms(slug, name, category) values ('x1', 'X', 'other')`)
    expect((await db.query(`update platforms set name = 'ok' where slug = 'x1'`)).affectedRows).toBe(1)
    expect((await db.query(`delete from platforms where slug = 'x1'`)).affectedRows).toBe(1)
  })

  it('admin_upsert_platform: admins only, validates, audits, never deletes', async () => {
    const up = (slug: string, name = 'Bandcamp', cat = 'music') => db.query(`select admin_upsert_platform($1, $2, $3, 'snap', true, 110)`, [slug, name, cat])
    await as('anon', null)
    await expect(up('bandcamp')).rejects.toThrow(/permission denied/)
    await as('authenticated', user)
    await expect(up('bandcamp')).rejects.toThrow(/forbidden/)
    await as('authenticated', banned)
    await expect(up('bandcamp')).rejects.toThrow(/forbidden/)
    await as('authenticated', admin)
    await up(' Bandcamp ')
    await up('bandcamp', 'Bandcamp 2')
    await expect(up('bad slug!')).rejects.toThrow()
    await expect(up('bandcamp', 'S', 'nonsense')).rejects.toThrow()
    await db.exec('reset role')
    expect(await rows(`select name, icon, sort_order from platforms where slug = 'bandcamp'`)).toEqual([{ name: 'Bandcamp 2', icon: 'snap', sort_order: 110 }])
    const audit = await rows<{ details: { before: unknown } }>(`select details from admin_audit_log where action = 'upsert_platform' order by created_at`)
    expect(audit).toHaveLength(2)
    expect(audit[0].details.before).toBeNull()
    expect(audit[1].details.before).toMatchObject({ name: 'Bandcamp' })
  })

  it('updated_at moves on update; slugs are unique', async () => {
    const before = (await rows<{ t: string }>(`select updated_at::text t from platforms where slug = 'telegram'`))[0].t
    await db.exec(`select pg_sleep(0.01); update platforms set sort_order = 5 where slug = 'telegram'`)
    expect((await rows<{ t: string }>(`select updated_at::text t from platforms where slug = 'telegram'`))[0].t).not.toBe(before)
    await expect(db.query(`insert into platforms(slug, name, category) values ('telegram', 'Dup', 'other')`)).rejects.toThrow(/unique|duplicate/i)
  })
})

describe('platform types', () => {
  it('maps a PostgREST row and recognises legacy enum slugs', () => {
    const row: PlatformRow = { id: 'i', slug: 'spotify', name: 'Spotify', icon: null, category: 'music', active: true, sort_order: 70, created_at: 'c', updated_at: 'u' }
    expect(platformFromRow(row)).toEqual({ id: 'i', slug: 'spotify', name: 'Spotify', icon: null, category: 'music', active: true, sortOrder: 70, createdAt: 'c', updatedAt: 'u' })
    expect(isLegacyPlatform('telegram')).toBe(true)
    expect(isLegacyPlatform('spotify')).toBe(false)
  })
})
