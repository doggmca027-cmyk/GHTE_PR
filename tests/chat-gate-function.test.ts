// The chat-gate Edge Function itself, run for real (Deno and the Supabase client are replaced): who may call it, what it counts, what it stores, and
// that it never writes a customer's question into its own logs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { signJwt } from '../supabase/functions/_shared/jwt.ts'
import { hmacHex } from '../supabase/functions/_shared/chat-gate.ts'

const SECRET = 'g'.repeat(40) // secret-scan:allow (test-only value)
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef' // secret-scan:allow (test-only value)
const USER_ID = '3f2b8c1e-5d4a-4b7e-9c11-2a6d8e0f4b12'

type Rpc = { name: string; args: Record<string, unknown> }
const rpcCalls: Rpc[] = []
let rpcAnswer: (call: Rpc) => { data: unknown; error: unknown } = () => ({ data: null, error: null })

vi.mock('npm:@supabase/supabase-js@2', () => ({
  createClient: (url: string, key: string) => ({ url, key, rpc: async (name: string, args: Record<string, unknown>) => { const call = { name, args }; rpcCalls.push(call); return rpcAnswer(call) } }),
}))

describe('the chat-gate function', () => {
  let handler: (req: Request) => Promise<Response>
  let env: Record<string, string | undefined> = {}
  const lines: string[] = []

  beforeAll(async () => {
    ;(globalThis as { Deno?: unknown }).Deno = {
      env: { get: (name: string) => env[name] },
      serve: (h: (req: Request) => Promise<Response>) => { handler = h },
    }
    // by a path in a variable: the function is written for Deno (Deno.serve, an npm: import), which the type checker of this project is not
    const entry = '../supabase/functions/chat-gate/index.ts'
    await import(/* @vite-ignore */ entry)
  })
  afterAll(() => { delete (globalThis as { Deno?: unknown }).Deno })

  beforeEach(() => {
    env = { CHAT_GATE_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', JWT_SECRET }
    rpcCalls.length = 0
    lines.length = 0
    rpcAnswer = (call) => (call.name === 'chat_rate_hit' ? { data: { allowed: true, limit: call.args.p_limit, remaining: 19, retry_after: 0 }, error: null } : { data: null, error: null })
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  const call = (body: unknown, headers: Record<string, string> = { 'x-chat-gate-secret': SECRET }, method = 'POST') =>
    handler(new Request('https://x.supabase.co/functions/v1/chat-gate', { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }))
  const token = (claims: Record<string, unknown>) => signJwt({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', ...claims }, JWT_SECRET, 3600).then((r) => r.token)
  const entry = { prompt: 'cheap instagram followers for my brand @secret_handle', intent: { platform: 'instagram', cheap: true }, matched: ['IG-FOL-STD-ROOT1'], recommended: ['IG-FOL-STD-ROOT1'], found: 1, toolCalls: 1, model: 'gemini-3.5-flash-lite' }

  describe('who may call it', () => {
    it('only with the shared secret: a wrong one, none, or another header gets 401 and nothing is counted or stored', async () => {
      const wrong: Record<string, string>[] = [{ 'x-chat-gate-secret': `${SECRET}x` }, {}, { authorization: `Bearer ${SECRET}` }, { 'x-cron-secret': SECRET }]
      for (const headers of wrong) {
        const res = await call({ action: 'check', ip: '1.2.3.4' }, headers)
        expect(res.status, JSON.stringify(headers)).toBe(401)
      }
      expect(rpcCalls).toHaveLength(0)
    })
    it('POST only; a browser preflight is answered', async () => {
      expect((await call(null, {}, 'GET')).status).toBe(405)
      expect((await call(null, {}, 'OPTIONS')).status).toBe(204)
      expect(rpcCalls).toHaveLength(0)
    })
    it('a function that is not configured says so and does nothing: no secret, no project, no key', async () => {
      for (const missing of ['CHAT_GATE_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
        const saved = env[missing]
        delete env[missing]
        const res = await call({ action: 'check', ip: '1.2.3.4' })
        expect(res.status, missing).toBe(500)
        expect(((await res.json()) as { error: string }).error).toBe('server_misconfigured')
        env[missing] = saved
      }
      expect(rpcCalls).toHaveLength(0)
    })
    it('a secret that is too short is not accepted even when the caller sends the same one', async () => {
      env.CHAT_GATE_SECRET = 'short'
      expect((await call({ action: 'check', ip: '1.2.3.4' }, { 'x-chat-gate-secret': 'short' })).status).toBe(401)
    })
    it('a body that is not JSON, too big, or not a request is refused before the database is touched', async () => {
      expect((await call('not json')).status).toBe(400)
      expect((await call({ action: 'drop' })).status).toBe(400)
      expect((await call({ action: 'log', ip: '1.2.3.4', entry: { prompt: '  ' } })).status).toBe(400)
      expect((await call(JSON.stringify({ action: 'check', ip: '1.2.3.4', pad: 'x'.repeat(20_000) }))).status).toBe(413)
      expect(rpcCalls).toHaveLength(0)
    })
  })

  describe('check', () => {
    it('counts one question for a guest by a hash of the address: 20 in 3600 seconds, and passes the verdict on', async () => {
      const res = await call({ action: 'check', ip: '203.0.113.7' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, allowed: true, limit: 20, remaining: 19, retry_after: 0, paying: false })
      // a guest has no account: no larger hour is asked for
      expect(rpcCalls).toEqual([{ name: 'chat_rate_hit', args: { p_identifier: `ip:${(await hmacHex(SECRET, 'ip:203.0.113.7')).slice(0, 16)}`, p_limit: 20, p_window_seconds: 3600, p_user_id: null, p_paying_limit: null } }])
      expect(JSON.stringify(rpcCalls)).not.toContain('203.0.113.7') // the address never reaches the database
    })
    it('a signed-in customer is counted by the Telegram id of their token', async () => {
      await call({ action: 'check', ip: '203.0.113.7', token: await token({ telegram_id: 777_000_111 }) })
      expect(rpcCalls[0]!.args.p_identifier).toBe('tg:777000111')
    })
    it('...and a made-up token is counted as the guest it is', async () => {
      const forged = (await signJwt({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', telegram_id: 42 }, 'another-secret-another-secret-12345', 3600)).token
      await call({ action: 'check', ip: '203.0.113.7', token: forged })
      expect(String(rpcCalls[0]!.args.p_identifier)).toMatch(/^ip:[0-9a-f]{16}$/)
    })
    it('a signed-in customer is counted with their account id and the larger hour (100), which the database applies when they have paid', async () => {
      await call({ action: 'check', ip: '203.0.113.7', token: await token({ telegram_id: 777_000_111 }) })
      expect(rpcCalls[0]!.args).toMatchObject({ p_identifier: 'tg:777000111', p_limit: 20, p_user_id: USER_ID, p_paying_limit: 100 })
      rpcAnswer = (c) => ({ data: { allowed: true, limit: c.args.p_paying_limit, remaining: 99, retry_after: 0, paying: true }, error: null })
      expect(await (await call({ action: 'check', ip: '1.1.1.1', token: await token({ telegram_id: 777_000_111 }) })).json()).toEqual({ ok: true, allowed: true, limit: 100, remaining: 99, retry_after: 0, paying: true })
    })
    it('the larger hour is a setting too, never below the ordinary one; a nonsense value is the default', async () => {
      const t = await token({ telegram_id: 777_000_111 })
      env.AI_CHAT_PAYING_LIMIT = '250'
      await call({ action: 'check', ip: '1.1.1.1', token: t })
      env.AI_CHAT_PAYING_LIMIT = 'lots'
      await call({ action: 'check', ip: '1.1.1.1', token: t })
      env.AI_CHAT_PAYING_LIMIT = '5'
      await call({ action: 'check', ip: '1.1.1.1', token: t })
      expect(rpcCalls.map((c) => c.args.p_paying_limit)).toEqual([250, 100, 20])
    })
    it('a made-up token is a guest: it asks for no larger hour', async () => {
      const forged = (await signJwt({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', telegram_id: 42 }, 'another-secret-another-secret-12345', 3600)).token
      await call({ action: 'check', ip: '1.1.1.1', token: forged })
      expect(rpcCalls[0]!.args).toMatchObject({ p_user_id: null, p_paying_limit: null })
    })
    it('the number of questions is the setting, when it is a sensible one', async () => {
      env.AI_CHAT_HOURLY_LIMIT = '15'
      await call({ action: 'check', ip: '1.2.3.4' })
      env.AI_CHAT_HOURLY_LIMIT = 'lots'
      await call({ action: 'check', ip: '1.2.3.4' })
      expect(rpcCalls.map((c) => c.args.p_limit)).toEqual([15, 20])
    })
    it('a refusal comes with the wait', async () => {
      rpcAnswer = () => ({ data: { allowed: false, limit: 20, remaining: 0, retry_after: 1380 }, error: null })
      const res = await call({ action: 'check', ip: '1.2.3.4' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, allowed: false, limit: 20, remaining: 0, retry_after: 1380, paying: false })
    })
    it('a database that cannot answer is 503 "unavailable": the chat lets the question through', async () => {
      for (const answer of [{ data: null, error: { message: 'boom' } }, { data: null, error: null }, { data: { allowed: 'yes' }, error: null }]) {
        rpcAnswer = () => answer
        const res = await call({ action: 'check', ip: '1.2.3.4' })
        expect(res.status, JSON.stringify(answer)).toBe(503)
        expect(((await res.json()) as { error: string }).error).toBe('unavailable')
      }
    })
  })

  describe('log', () => {
    it('stores the cleaned line under the same identifier the limit uses', async () => {
      const res = await call({ action: 'log', ip: '203.0.113.7', token: await token({ telegram_id: 777_000_111 }), entry })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(rpcCalls).toEqual([{
        name: 'record_ai_chat_log',
        args: {
          p_user_identifier: 'tg:777000111', p_prompt: entry.prompt, p_intent: expect.objectContaining({ platform: 'instagram', cheap: true, actions: [], quantity: null }),
          p_matched: ['IG-FOL-STD-ROOT1'], p_recommended: ['IG-FOL-STD-ROOT1'], p_found_count: 1, p_tool_calls: 1, p_model: 'gemini-3.5-flash-lite',
        },
      }])
    })
    it('a guest\'s line has a hash, not an address', async () => {
      await call({ action: 'log', ip: '203.0.113.7', entry })
      expect(String(rpcCalls[0]!.args.p_user_identifier)).toMatch(/^ip:[0-9a-f]{16}$/)
      expect(JSON.stringify(rpcCalls)).not.toContain('203.0.113.7')
    })
    it('what the caller sends is cleaned first: a long prompt is cut, unknown fields and bad articles are dropped', async () => {
      await call({ action: 'log', ip: '1.2.3.4', entry: { ...entry, prompt: `${'x'.repeat(900)}\n\u0000`, matched: ['IG-FOL-STD-ROOT1', '<script>'], intent: { platform: 'instagram', evil: 'x' } } })
      const args = rpcCalls[0]!.args
      expect(String(args.p_prompt)).toHaveLength(500)
      expect(args.p_matched).toEqual(['IG-FOL-STD-ROOT1'])
      expect(JSON.stringify(args.p_intent)).not.toContain('evil')
    })
    it('a database that cannot write is 503, and the answer says nothing of the question', async () => {
      rpcAnswer = () => ({ data: null, error: { message: `insert failed for "${entry.prompt}"` } })
      const res = await call({ action: 'log', ip: '1.2.3.4', entry })
      expect(res.status).toBe(503)
      expect(JSON.stringify(await res.json())).not.toContain('secret_handle')
    })
  })

  describe('what it writes to its own logs', () => {
    it('never a question, an address, a token or the secret: only that a request happened, and the kind of caller when the limit was reached', async () => {
      const t = await token({ telegram_id: 777_000_111 })
      await call({ action: 'log', ip: '203.0.113.7', token: t, entry })
      rpcAnswer = (c) => (c.name === 'chat_rate_hit' ? { data: { allowed: false, limit: 20, remaining: 0, retry_after: 60 }, error: null } : { data: null, error: { message: 'x' } })
      await call({ action: 'check', ip: '203.0.113.7', token: t })
      await call({ action: 'log', ip: '203.0.113.7', entry })
      await call({ action: 'check', ip: '203.0.113.7' }, { 'x-chat-gate-secret': 'wrong' })
      const everything = lines.join('\n')
      expect(everything.length).toBeGreaterThan(0)
      for (const forbidden of [entry.prompt, 'secret_handle', 'cheap instagram', '203.0.113.7', t, SECRET, JWT_SECRET, '777000111', 'service-key']) expect(everything, forbidden).not.toContain(forbidden)
      expect(everything).toContain('question limit reached')
    })
  })
})
