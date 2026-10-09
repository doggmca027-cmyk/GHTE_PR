import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { ORDER_COLUMNS } from '../src/services/api/orders'
import { SERVICE_COLUMNS } from '../src/services/api/services'

// The database as PostgREST sees it: `set role authenticated` + the JWT subject in the setting auth.uid() reads. Whatever a client
// can ask through /rest/v1 is a SELECT run under exactly this role; what is refused here is refused there ("permission denied").
const SENSITIVE_ORDER_COLUMNS = [
  'cost_amount', 'profit_amount', 'provider_id', 'provider_offer_id', 'provider_order_id', 'provider_reservation', 'error_message',
  'routing_score_snapshot', 'idempotency_key', 'list_price_amount', 'tier_discount_amount', 'promo_discount_amount', 'promo_code_id', 'discount_capped',
]

describe('customers cannot read the platform\'s internals through the API', () => {
  let db: PGlite
  let alice: string, bob: string, admin: string
  let aliceOrder: string, svc: string
  let n = 0

  const asUser = (id: string) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.sub','${id}',false)`)
  const asAnon = () => db.exec(`reset role; set role anon`)
  const asOwner = () => db.exec(`reset role`)
  const rows = async (sql: string, p: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, p)).rows
  const one = async <T = string>(sql: string, p: unknown[] = []) => (await db.query<{ v: T }>(sql, p)).rows[0].v

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))

    const user = async (admin = false) => {
      const id = await one<string>(`insert into users(telegram_id, is_admin) values ($1, $2) returning id v`, [4000 + ++n, admin])
      await db.query(`select process_wallet_transaction($1::uuid, 'deposit', 100::numeric, null, 'fund', $2)`, [id, `fund-${id}`])
      return id
    }
    alice = await user(); bob = await user(); admin = await user(true)
    const provider = await one<string>(`insert into providers(name, api_url) values ('Secret Panel', 'https://p.invalid') returning id v`)
    const cat = await one<string>(`insert into categories(platform_id, name, slug) select id, 'V', 'v' from platforms where slug = 'telegram' returning id v`)
    const ps = await one<string>(`insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity) values ($1, '1', 'Views', 2, 1, 1000000) returning id v`, [provider])
    svc = await one<string>(`insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity) values ($1, 'Views', $2, 4, 1, 1000000) returning id v`, [cat, ps])
    const offer = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [svc]))[0]
    const place = async (u: string) => one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/mine', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, $6)`, [u, svc, offer.id, offer.provider_id, offer.provider_service_id, `k-${++n}`])
    aliceOrder = await place(alice)
    await place(bob)
    await db.query(`update orders set error_message = 'needs_reconciliation: timeout from Secret Panel' where id = $1`, [aliceOrder])
  }, 180_000)

  describe('orders', () => {
    it.each(SENSITIVE_ORDER_COLUMNS)('a signed-in customer cannot select orders.%s, not even their own', async (column) => {
      await asUser(alice)
      await expect(db.query(`select ${column} from orders where id = $1`, [aliceOrder])).rejects.toThrow(/permission denied/)
      // nor use it to filter or sort: that would leak it by inference
      await expect(db.query(`select id from orders where ${column} is not null`)).rejects.toThrow(/permission denied/)
      await asOwner()
    })

    it('select * is refused (a client has to name the columns it needs)', async () => {
      await asUser(alice)
      await expect(db.query(`select * from orders`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`select o.* from orders o`)).rejects.toThrow(/permission denied/)
      await asOwner()
    })

    it('the columns the app reads work, and row level security still limits them to the customer\'s own orders', async () => {
      await asUser(alice)
      const mine = await rows(`select ${ORDER_COLUMNS.join(', ')}, user_id from orders`)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ id: aliceOrder, quantity: 1000, charge_amount: '4.0000', target_url: 'https://t.me/mine' })
      // the exact statement shape of getOrders: its own columns, the status filter and the order, plus the embedded service/category/platform
      await expect(db.query(`select ${ORDER_COLUMNS.join(',')} from orders where status <> 'draft' order by created_at desc limit 100`)).resolves.toBeTruthy()
      await expect(db.query(`select s.name, p.slug from orders o join services s on s.id = o.service_id join categories c on c.id = s.category_id join platforms p on p.id = c.platform_id`)).resolves.toBeTruthy()
      await asUser(bob)
      expect((await rows(`select id from orders`)).map((r) => r.id)).not.toContain(aliceOrder)
      await asOwner()
    })

    it('every column the app asks for is one the database grants (a drift between the two would break the order list)', async () => {
      for (const column of [...ORDER_COLUMNS, 'user_id']) {
        expect((await rows(`select has_column_privilege('authenticated', 'public.orders', '${column}', 'select') as ok`))[0].ok, column).toBe(true)
      }
      for (const column of SENSITIVE_ORDER_COLUMNS) expect(ORDER_COLUMNS as readonly string[]).not.toContain(column)
    })

    it('anonymous visitors read nothing of orders at all', async () => {
      await asAnon()
      await expect(db.query(`select id from orders`)).rejects.toThrow(/permission denied/)
      await asOwner()
    })

    it('a column added later is private until someone grants it on purpose (allow-list, not block-list)', async () => {
      await db.exec(`alter table public.orders add column internal_flag text`)
      await asUser(alice)
      await expect(db.query(`select internal_flag from orders`)).rejects.toThrow(/permission denied/)
      await asOwner()
      await db.exec(`alter table public.orders drop column internal_flag`)
    })

    it('customers still cannot write orders', async () => {
      await asUser(alice)
      await expect(db.query(`update orders set charge_amount = 0.0001 where id = $1`, [aliceOrder])).rejects.toThrow(/permission denied/)
      await asOwner()
    })
  })

  describe('order_status_history', () => {
    it('the transitions are readable, the internal comment is not', async () => {
      await asUser(alice)
      const h = await rows(`select id, order_id, old_status, new_status, created_at from order_status_history where order_id = $1`, [aliceOrder])
      expect(h.length).toBeGreaterThan(0)
      await expect(db.query(`select comment from order_status_history`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`select * from order_status_history`)).rejects.toThrow(/permission denied/)
      await asOwner()
    })
  })

  describe('services', () => {
    it('the storefront columns are readable by everyone, including the active filter the catalog query uses', async () => {
      for (const as of [asAnon, () => asUser(alice)]) {
        await as()
        const s = await rows(`select ${SERVICE_COLUMNS.join(',')} from services where is_active = true order by sort_order, customer_rate_per_1000`)
        expect(s).toHaveLength(1)
        expect(s[0]).toMatchObject({ name: 'Views', customer_rate_per_1000: '4.0000' })
        await asOwner()
      }
    })

    it('which provider service sits behind a storefront service is not readable', async () => {
      for (const as of [asAnon, () => asUser(alice)]) {
        await as()
        await expect(db.query(`select primary_provider_service_id from services`)).rejects.toThrow(/permission denied/)
        await expect(db.query(`select fallback_provider_service_id from services`)).rejects.toThrow(/permission denied/)
        await expect(db.query(`select * from services`)).rejects.toThrow(/permission denied/)
        await asOwner()
      }
    })

    it('every column the catalog asks for is granted', async () => {
      for (const column of SERVICE_COLUMNS) {
        for (const role of ['anon', 'authenticated']) {
          expect((await rows(`select has_column_privilege('${role}', 'public.services', '${column}', 'select') as ok`))[0].ok, `${role}.${column}`).toBe(true)
        }
      }
    })
  })

  describe('what must keep working', () => {
    it('the server side still sees everything: the admin screens read through SECURITY DEFINER functions', async () => {
      await asUser(admin)
      const view = (await db.query<{ v: Array<Record<string, unknown>> }>(`select get_admin_pricing_view() v`)).rows[0].v
      expect(view[0]).toHaveProperty('base_offer_cost')
      await asOwner()
      const internal = await rows(`select cost_amount, profit_amount, provider_id, error_message from orders where id = $1`, [aliceOrder])
      expect(internal[0]).toMatchObject({ cost_amount: '2.0000', profit_amount: '2.0000' })
      expect(String(internal[0].error_message)).toContain('Secret Panel')
    })

    it('placing and finishing an order are untouched (functions run as the owner)', async () => {
      const offer = (await rows(`select id, provider_id, provider_service_id from provider_service_offers where service_id = $1`, [svc]))[0]
      const id = await one<string>(`select id v from place_order($1::uuid, $2::uuid, 'https://t.me/x', 1000, $3::uuid, $4::uuid, $5::uuid, 2::numeric, 'rls-k1')`, [alice, svc, offer.id, offer.provider_id, offer.provider_service_id])
      await db.query(`update orders set status = 'processing' where id = $1`, [id])
      await db.query(`update orders set status = 'submitted', provider_order_id = 'P1' where id = $1`, [id])
      await db.query(`update orders set status = 'completed' where id = $1`, [id])
      expect(await one(`select status::text v from orders where id = $1`, [id])).toBe('completed')
    })
  })

  it('the app\'s own request strings name only granted columns (source check of the two REST calls)', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')
    const orders = read('src/services/api/orders.ts')
    const services = read('src/services/api/services.ts')
    expect(orders).toContain("...ORDER_COLUMNS, 'services(name,categories(platforms(slug)))'")
    expect(orders).not.toMatch(/select=\*|cost_amount|profit_amount|error_message|provider_order_id/)
    expect(services).toContain('SERVICE_COLUMNS.join')
    expect(services).not.toMatch(/primary_provider_service_id|fallback_provider_service_id|select=\*/)
  })
})
