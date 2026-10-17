// The Mini App's sign-in survives a network hiccup or a cold start: up to three attempts (pauses 800 ms, 1500 ms) on no connection, a
// timeout or a 5xx, while the start screen spins; a refusal is an answer and is never repeated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/webapp', () => ({ WebApp: { initData: 'query_id=1&user=%7B%7D&hash=ab' } }))

const SESSION = { token: 'jwt', expiresAt: 9e9, user: { id: 'u' }, wallet: { balance: 0, currency: 'USD' } }
const ok = () => new Response(JSON.stringify(SESSION), { status: 200 })
const status = (code: number, body: unknown = { error: 'x' }) => new Response(JSON.stringify(body), { status: code })

async function load() {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
  return import('../src/services/api/auth')
}

describe('telegram-auth from the Mini App', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  const run = async (fetchImpl: () => Promise<Response>) => {
    const fetchMock = vi.fn(fetchImpl)
    vi.stubGlobal('fetch', fetchMock)
    const { authenticateWithTelegram } = await load()
    const p = authenticateWithTelegram().then((s) => ({ s }), (e: unknown) => ({ e }))
    await vi.advanceTimersByTimeAsync(5_000)
    return { result: await p, fetchMock }
  }

  it('a dropped connection, then a 502, then the answer: signed in on the third attempt, after 800 and 1500 ms', async () => {
    const answers = [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.resolve(status(502)), () => Promise.resolve(ok())]
    let i = 0
    const { result, fetchMock } = await run(() => answers[i++]())
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ s: { token: 'jwt', isMock: false } })
  })

  it('the waits are 800 ms and then 1500 ms', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    vi.stubGlobal('fetch', fetchMock)
    const { authenticateWithTelegram, AUTH_RETRY_DELAYS_MS } = await load()
    expect(AUTH_RETRY_DELAYS_MS).toEqual([800, 1500])
    const p = authenticateWithTelegram().catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(799)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await p
  })

  it('three failures in a row: only then the error screen ("no connection" / "server")', async () => {
    const net = await run(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(net.fetchMock).toHaveBeenCalledTimes(3)
    expect(net.result).toMatchObject({ e: { code: 'network' } })
    const srv = await run(() => Promise.resolve(status(503)))
    expect(srv.fetchMock).toHaveBeenCalledTimes(3)
    expect(srv.result).toMatchObject({ e: { code: 'server' } })
  })

  it('a refusal is an answer: an invalid session or a ban is not asked again', async () => {
    const bad = await run(() => Promise.resolve(status(401)))
    expect(bad.fetchMock).toHaveBeenCalledTimes(1)
    expect(bad.result).toMatchObject({ e: { code: 'rejected' } })
    const banned = await run(() => Promise.resolve(status(403, { error: 'user_banned' })))
    expect(banned.fetchMock).toHaveBeenCalledTimes(1)
    expect(banned.result).toMatchObject({ e: { code: 'user_banned' } })
  })

  it('each attempt may take up to 15 seconds', async () => {
    const { AUTH_TIMEOUT_MS } = await load()
    expect(AUTH_TIMEOUT_MS).toBe(15_000)
  })
})
