// End-to-end check against a REAL SMM provider panel (SMM API v2), using the platform's own code paths:
// the SMMv2Adapter (network, timeouts, error classification), the catalog-sync mapping and the order-sync worker.
// Nothing here touches the database: the catalog is mapped in memory and the polled order lives in memory.
//
//   npm run e2e:provider
//       Step 1 only (READ-ONLY, free): balance + catalog download, normalisation and category/platform mapping.
//
//   npm run e2e:provider -- --place-order --service <provider service id> --link <url> --quantity <n> [--max-cost 0.10]
//       Steps 1-3: places ONE real order (it costs real money at the provider), prints its external order id,
//       then polls it with the sync-order-status logic until completed / partial / canceled or the timeout.
//
//   npm run e2e:provider -- --poll <external order id> [--quantity <n>]
//       Step 3 only: resumes polling an order placed earlier (e.g. after the timeout).
//
// Credentials come from the environment or .env.local, never from the command line or the repository:
//   PROVIDER_TEST_URL=https://<panel>/api/v2
//   PROVIDER_TEST_KEY=<api key>
// Optional: E2E_POLL_INTERVAL_SECONDS (default 30), E2E_POLL_TIMEOUT_MINUTES (default 30).
// The key is never printed; the URL is printed by host only.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectCatalogAnomalies, normalizeProviderServices, resolveCategory } from '../supabase/functions/_shared/catalog-sync.ts'
import { syncProviderOrders, type OrderFieldsPatch, type SyncOrder, type SyncPorts } from '../supabase/functions/_shared/order-sync.ts'
import { classifyProviderError } from '../supabase/functions/_shared/place-order-flow.ts'
import { calculateCustomerRate } from '../supabase/functions/_shared/price-engine.ts'
import { costForQuantity } from '../supabase/functions/_shared/routing.ts'
import { SMMv2Adapter } from '../supabase/functions/_shared/smm-v2-adapter.ts'
import type { IProviderService, OrderStatus } from '../supabase/functions/_shared/types.ts'

const TERMINAL: OrderStatus[] = ['completed', 'partial', 'canceled', 'refunded', 'failed']

// ---------------------------------------------------------------------------
// Configuration (fails clearly, never prints a secret)
// ---------------------------------------------------------------------------

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function die(message: string, code = 1): never {
  console.error(`\nprovider-e2e: ${message}`)
  process.exit(code)
}

const fileEnv = readEnvFile(join(process.cwd(), '.env.local'))
const env = (k: string) => process.env[k] || fileEnv[k] || ''
const url = env('PROVIDER_TEST_URL').trim()
const key = env('PROVIDER_TEST_KEY').trim()

if (!url || !key) {
  die(
    'PROVIDER_TEST_URL and PROVIDER_TEST_KEY are required.\n' +
      '  Put them in .env.local (git-ignored) or export them in your shell:\n' +
      '    PROVIDER_TEST_URL=https://<your panel>/api/v2\n' +
      '    PROVIDER_TEST_KEY=<your API key>\n' +
      '  Nothing was sent anywhere.',
  )
}
let host: string
try {
  const u = new URL(url)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !local) die('PROVIDER_TEST_URL must use https:// (the API key travels in the request body).')
  host = u.host
} catch {
  die('PROVIDER_TEST_URL is not a valid URL.')
}

const adapter = new SMMv2Adapter({ id: 'e2e', name: 'E2E provider', apiUrl: url, apiKey: key, mockMode: false, timeoutMs: 20_000 })
const pollEverySec = Number(env('E2E_POLL_INTERVAL_SECONDS')) || 30
const pollTimeoutMin = Number(env('E2E_POLL_TIMEOUT_MINUTES')) || 30

const hr = (t: string) => console.log(`\n=== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`)
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split(key).join('***')

// ---------------------------------------------------------------------------
// Step 1: balance + catalog (read-only)
// ---------------------------------------------------------------------------

async function stepCatalog(): Promise<IProviderService[]> {
  hr('Step 1: balance and catalog (read-only)')
  console.log(`provider host: ${host}`)
  try {
    const b = await adapter.getBalance()
    console.log(`balance: ${b.balance} ${b.currency}`)
  } catch (e) {
    die(`balance call failed: ${errText(e)}`)
  }

  const started = Date.now()
  let raw: IProviderService[]
  try {
    raw = await adapter.getServices()
  } catch (e) {
    die(`services call failed: ${errText(e)}`)
  }
  const { valid, skipped } = normalizeProviderServices(raw)
  console.log(`services: ${raw.length} returned in ${Date.now() - started} ms, ${valid.length} valid, ${skipped.length} skipped`)
  for (const s of skipped.slice(0, 5)) console.log(`  skipped ${s.externalServiceId}: ${s.reason}`)

  // Map exactly as sync-catalog does.
  const byPlatform = new Map<string, number>()
  const categories = new Set<string>()
  for (const s of valid) {
    const c = resolveCategory(s.categoryRaw, s.name)
    byPlatform.set(c.platform, (byPlatform.get(c.platform) ?? 0) + 1)
    categories.add(c.slug)
  }
  console.log(`mapped to ${categories.size} categories; by platform: ${[...byPlatform].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`)

  // Assertions on the mapping (what sync-catalog relies on).
  const problems: string[] = []
  if (valid.length === 0) problems.push('no valid service at all')
  const ids = new Set<string>()
  for (const s of valid) {
    if (ids.has(s.externalServiceId)) problems.push(`duplicate id ${s.externalServiceId}`)
    ids.add(s.externalServiceId)
    if (!(Number.isFinite(s.ratePer1000) && s.ratePer1000 >= 0)) problems.push(`${s.externalServiceId}: bad rate`)
    if (!(s.minQuantity > 0 && s.maxQuantity >= s.minQuantity)) problems.push(`${s.externalServiceId}: bad limits`)
  }
  // Same anomaly rules as the sync, compared with itself (a sanity run: there is no stored catalog here).
  const selfCheck = detectCatalogAnomalies([], valid, skipped)
  if (selfCheck.length) problems.push(`${selfCheck.length} anomalies on a fresh catalog`)

  const sample = [...valid].sort((a, b) => a.ratePer1000 - b.ratePer1000).slice(0, 8)
  console.log('cheapest services (provider rate -> customer price with +100% and the $0.01 margin floor):')
  for (const s of sample) {
    const c = resolveCategory(s.categoryRaw, s.name)
    const customer = calculateCustomerRate(s.ratePer1000, [{ id: 'e2e', type: 'percentage', value: 100, priority: 0 }])
    console.log(`  #${s.externalServiceId.padEnd(7)} ${String(s.ratePer1000).padStart(9)} -> ${String(customer).padStart(9)} /1000  [${c.platform}] min ${s.minQuantity} max ${s.maxQuantity}  ${s.name.slice(0, 60)}`)
  }

  if (problems.length) die(`catalog mapping FAILED:\n  - ${problems.slice(0, 20).join('\n  - ')}`)
  console.log('catalog mapping: OK')
  return valid
}

// ---------------------------------------------------------------------------
// Step 2: one real order (only with --place-order)
// ---------------------------------------------------------------------------

async function stepOrder(catalog: IProviderService[]): Promise<{ externalId: string; quantity: number }> {
  hr('Step 2: place ONE real order')
  const serviceId = arg('service')
  const link = arg('link')
  const quantity = Number(arg('quantity'))
  const maxCost = Number(arg('max-cost') ?? '0.10')
  if (!serviceId || !link || !Number.isInteger(quantity) || quantity <= 0) {
    die('--place-order needs --service <provider service id> --link <url> --quantity <whole number>')
  }
  const s = catalog.find((x) => x.externalServiceId === serviceId)
  if (!s) die(`service ${serviceId} is not in the provider's catalog`)
  if (quantity < s.minQuantity || quantity > s.maxQuantity) die(`quantity must be between ${s.minQuantity} and ${s.maxQuantity} for service ${serviceId}`)
  const cost = costForQuantity(s.ratePer1000, quantity)
  if (!(cost <= maxCost)) die(`this order would cost ${cost} at the provider, above --max-cost ${maxCost}. Nothing was ordered.`)

  console.log(`service #${serviceId}: ${s.name}`)
  console.log(`link: ${link}   quantity: ${quantity}   expected provider cost: ${cost}`)
  try {
    const { orderId } = await adapter.createOrder({ serviceId, link, quantity })
    console.log(`\n  >>> EXTERNAL ORDER ID: ${orderId} <<<   (check it in the provider panel)\n`)
    return { externalId: orderId, quantity }
  } catch (e) {
    const cls = classifyProviderError(e)
    if (cls.outcome === 'hold') {
      die(`the provider did not answer clearly (${cls.reason}). The order MAY have been created: check the panel before retrying.`, 3)
    }
    die(`the provider refused the order (${cls.reason}). Nothing was created.`)
  }
}

// ---------------------------------------------------------------------------
// Step 3: poll with the sync-order-status logic until a terminal state
// ---------------------------------------------------------------------------

async function stepPoll(externalId: string, quantity: number) {
  hr('Step 3: poll the order (sync-order-status logic)')
  console.log(`external order id: ${externalId}, every ${pollEverySec} s, up to ${pollTimeoutMin} min`)
  // In-memory stand-in for the orders table, driven by the real worker code.
  const order: SyncOrder = {
    id: 'e2e-order', user_id: 'e2e', service_id: 'e2e', provider_order_id: externalId, status: 'submitted',
    quantity, charge_amount: 0, remains: null, start_count: null, error_message: null, created_at: new Date().toISOString(),
  }
  const ports: SyncPorts = {
    async setProviderOrderId(_id, pid) { order.provider_order_id = pid },
    async updateOrder(_id, patch: OrderFieldsPatch, expect: OrderStatus[]) {
      if (!expect.includes(order.status)) return false
      Object.assign(order, patch)
      return true
    },
    async applyPartialRefund(_id, remains, startCount) {
      order.status = 'partial'
      order.remains = remains
      order.start_count = startCount ?? order.start_count
      return 0
    },
    async refundOrder() { order.status = 'refunded' },
    async touch() {},
  }

  const deadline = Date.now() + pollTimeoutMin * 60_000
  let last = ''
  for (;;) {
    const stats = await syncProviderOrders([order], adapter, ports, {}, { warn: (...a) => console.warn('  worker:', ...a.map(String)), error: (...a) => console.warn('  worker:', ...a.map(String)) })
    const line = `status ${order.status}${order.remains !== null ? `, remains ${order.remains}` : ''}${order.start_count !== null ? `, start count ${order.start_count}` : ''}`
    if (line !== last) console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
    last = line
    if (stats.providerLost) console.log('  the provider says it does not know this order id (never refunded automatically)')
    if (stats.errors.length) console.log(`  worker error: ${stats.errors[0].message.split(key).join('***')}`)
    if (TERMINAL.includes(order.status)) {
      console.log(`\nterminal state reached: ${order.status} (external order ${externalId})`)
      return
    }
    if (Date.now() > deadline) {
      console.log(`\npolling timed out (still ${order.status}). Nothing is wrong by itself: resume later with\n  npm run e2e:provider -- --poll ${externalId} --quantity ${quantity}`)
      process.exit(4)
    }
    await new Promise((r) => setTimeout(r, pollEverySec * 1000))
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const resume = arg('poll')
  if (resume) {
    await stepPoll(resume, Number(arg('quantity')) || 0)
    return
  }
  const catalog = await stepCatalog()
  if (!flag('place-order')) {
    console.log('\nRead-only run finished. To place one real order (costs money) and poll it, add:\n' +
      '  --place-order --service <id> --link <url> --quantity <n> [--max-cost 0.10]')
    return
  }
  const { externalId, quantity } = await stepOrder(catalog)
  await stepPoll(externalId, quantity)
}

main().catch((e) => die(`crashed: ${errText(e)}`, 2))
