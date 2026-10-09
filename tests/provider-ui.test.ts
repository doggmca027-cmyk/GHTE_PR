import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkProviderDraft, checkProviderUrl, draftOf, emptyDraft } from '../src/lib/provider-form'
import type { AdminProvider } from '../src/types/admin-providers'
import type { AuthSession } from '../src/services/api/auth'

const KEY = 'sk_live_super_secret_key_123'

const provider = (over: Partial<AdminProvider> = {}): AdminProvider => ({
  id: '00000000-0000-4000-8000-000000000001', name: 'Secsers', slug: 'secsers', apiUrl: 'https://secsers.example.com/api/v2', apiVersion: 'v2', isActive: true,
  routingEnabled: false, priority: 5, healthStatus: 'disabled', lastHealthCheck: null, balance: 0, currency: 'USD', lastBalanceSync: null, lowBalanceThreshold: 0,
  targetTopupBalance: 0, reliabilityPenalty: 1, hasApiKey: true, createdAt: 't', updatedAt: 't', ...over,
})

const session = (over: Partial<AuthSession> = {}, admin = true): AuthSession => ({
  token: 'jwt-token', expiresAt: 0, isMock: false, wallet: { balance: 0, currency: 'USD' },
  user: { id: 'u1', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: admin }, ...over,
})

describe('checkProviderUrl', () => {
  it('requires https:// and a parsable URL', () => {
    expect(checkProviderUrl('')).toBe('Укажите адрес API.')
    expect(checkProviderUrl('http://panel.example.com')).toMatch(/https:\/\//)
    expect(checkProviderUrl('panel.example.com')).toMatch(/https:\/\//)
    expect(checkProviderUrl('https://')).toMatch(/ссылку/)
    expect(checkProviderUrl(' https://panel.example.com/api ')).toBeNull()
  })
})

describe('checkProviderDraft: adding', () => {
  it('needs a name and an https URL; the key and priority are optional / defaulted', () => {
    const d = emptyDraft()
    expect(checkProviderDraft(d, null).request).toBeNull()
    expect(checkProviderDraft(d, null).errors).toMatchObject({ name: expect.any(String), apiUrl: expect.any(String) })
    const ok = checkProviderDraft({ ...d, name: ' Panel ', apiUrl: 'https://p.example.com' }, null)
    expect(ok.request).toEqual({ action: 'UPSERT_PROVIDER', name: 'Panel', apiUrl: 'https://p.example.com', priority: 0, isActive: true })
  })

  it('sends the key when one is typed, trimmed', () => {
    const r = checkProviderDraft({ ...emptyDraft(), name: 'P', apiUrl: 'https://p.example.com', apiKey: `  ${KEY}  ` }, null).request
    expect(r).toMatchObject({ apiKey: KEY })
  })

  it('validates key and priority', () => {
    const base = { ...emptyDraft(), name: 'P', apiUrl: 'https://p.example.com' }
    expect(checkProviderDraft({ ...base, apiKey: 'short' }, null).errors.apiKey).toBeTruthy()
    expect(checkProviderDraft({ ...base, apiKey: 'has some spaces here' }, null).errors.apiKey).toBeTruthy()
    expect(checkProviderDraft({ ...base, priority: '1.5' }, null).errors.priority).toBeTruthy()
    expect(checkProviderDraft({ ...base, priority: '' }, null).errors.priority).toBeTruthy()
    expect(checkProviderDraft({ ...base, priority: '10001' }, null).errors.priority).toBeTruthy()
    expect(checkProviderDraft({ ...base, priority: '-3' }, null).request).toMatchObject({ priority: -3 })
  })

  it('refuses a non-https URL before any request is built', () => {
    expect(checkProviderDraft({ ...emptyDraft(), name: 'P', apiUrl: 'http://p.example.com' }, null).request).toBeNull()
  })

  it('never puts the key in an error message', () => {
    const r = checkProviderDraft({ ...emptyDraft(), name: 'P', apiUrl: 'https://p.example.com', apiKey: 'has some spaces here' }, null)
    expect(JSON.stringify(r.errors)).not.toContain('spaces here')
  })
})

describe('checkProviderDraft: editing (the API key is optional)', () => {
  const p = provider()

  it('prefills everything but the key', () => {
    expect(draftOf(p)).toEqual({ name: 'Secsers', apiUrl: p.apiUrl, apiKey: '', priority: '5', isActive: true })
  })

  it('an untouched form has nothing to send', () => {
    expect(checkProviderDraft(draftOf(p), p).request).toBeNull()
    expect(checkProviderDraft(draftOf(p), p).errors).toEqual({})
  })

  it('an empty key field keeps the stored key: apiKey is not in the request at all', () => {
    const r = checkProviderDraft({ ...draftOf(p), name: 'Secsers 2', apiKey: '' }, p).request
    expect(r).toEqual({ action: 'UPSERT_PROVIDER', id: p.id, name: 'Secsers 2' })
    expect(r).not.toHaveProperty('apiKey')
    // whitespace only counts as empty too
    expect(checkProviderDraft({ ...draftOf(p), name: 'Secsers 2', apiKey: '   ' }, p).request).not.toHaveProperty('apiKey')
  })

  it('a typed key replaces it; only the changed fields are sent', () => {
    expect(checkProviderDraft({ ...draftOf(p), apiKey: KEY }, p).request).toEqual({ action: 'UPSERT_PROVIDER', id: p.id, apiKey: KEY })
    expect(checkProviderDraft({ ...draftOf(p), priority: '9', isActive: false }, p).request).toEqual({ action: 'UPSERT_PROVIDER', id: p.id, priority: 9, isActive: false })
    expect(checkProviderDraft({ ...draftOf(p), apiUrl: 'https://other.example.com' }, p).request).toEqual({ action: 'UPSERT_PROVIDER', id: p.id, apiUrl: 'https://other.example.com' })
  })

  it('a bad URL blocks the save even when only the name changed elsewhere', () => {
    expect(checkProviderDraft({ ...draftOf(p), apiUrl: 'http://x.example.com' }, p).request).toBeNull()
  })
})

describe('ProviderModal markup', () => {
  const render = async (props: { provider: AdminProvider | null }) => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { ProviderModal } = await import('../src/components/admin/ProviderModal')
    return renderToStaticMarkup(createElement(ProviderModal, { ...props, onClose: () => {}, onSave: async () => {} }))
  }

  it('add: empty fields, a password input, no key warning', async () => {
    const out = await render({ provider: null })
    expect(out).toContain('Добавить провайдера')
    expect(out).toContain('type="password"')
    expect(out).toContain('Вставьте API-ключ провайдера')
    expect(out).toContain('placeholder="https://panel.example.com/api/v2"')
    expect(out).not.toContain('ещё нет API-ключа')
  })

  it('edit: prefilled, the key field is empty with the "keep" placeholder, and nothing secret is in the markup', async () => {
    const out = await render({ provider: provider() })
    expect(out).toContain('Изменить: Secsers')
    expect(out).toContain('value="Secsers"')
    expect(out).toContain('value="https://secsers.example.com/api/v2"')
    expect(out).toContain('placeholder="Пусто — оставить текущий ключ"')
    expect(out).toContain('Ключ сохранён. Оставьте поле пустым, чтобы не менять его.')
    expect(out).toMatch(/autocomplete="new-password"/i)
    expect(out).not.toContain('ещё нет API-ключа')
  })

  it('edit without a stored key: shows the warning', async () => {
    const out = await render({ provider: provider({ hasApiKey: false }) })
    expect(out).toContain('У этого провайдера ещё нет API-ключа')
    expect(out).toContain('маршрутизацию включить нельзя')
  })

  it('escapes provider names', async () => {
    const out = await render({ provider: provider({ name: '<img src=x onerror=alert(1)>' }) })
    expect(out).not.toContain('<img src=x')
  })
})

describe('Toast', () => {
  it('renders nothing without a message, an alert for errors and a status for successes', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Toast } = await import('../src/components/ui/Toast')
    expect(renderToStaticMarkup(createElement(Toast, { message: null, onDismiss: () => {} }))).toBe('')
    expect(renderToStaticMarkup(createElement(Toast, { message: { kind: 'error', text: 'No key' }, onDismiss: () => {} }))).toContain('role="alert"')
    expect(renderToStaticMarkup(createElement(Toast, { message: { kind: 'ok', text: 'Saved' }, onDismiss: () => {} }))).toContain('role="status"')
  })
})

describe('admin-providers client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
  const load = () => import('../src/services/api/admin-providers')

  it('LIST_PROVIDERS posts to the function with the user JWT and returns the providers', async () => {
    reply(200, { success: true, providers: [provider()] })
    const { listAdminProviders } = await load()
    expect((await listAdminProviders(session()))).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://proj.supabase.co/functions/v1/admin-providers')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
    expect(JSON.parse(init.body)).toEqual({ action: 'LIST_PROVIDERS' })
  })

  it('UPSERT_PROVIDER sends the key in the body only and never logs it', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    reply(200, { success: true, created: true, provider: provider() })
    const { upsertProvider } = await load()
    const r = await upsertProvider(session(), { action: 'UPSERT_PROVIDER', name: 'P', apiUrl: 'https://p.example.com', apiKey: KEY })
    expect(r.created).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).not.toContain(KEY)
    expect(JSON.parse(init.body)).toMatchObject({ action: 'UPSERT_PROVIDER', apiKey: KEY })
    expect(JSON.stringify(r)).not.toContain(KEY)
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(KEY)
    spies.forEach((s) => s.mockRestore())
  })

  it('a failed request does not leak the key into the error', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`socket hang up while sending ${KEY}`))
    const { upsertProvider } = await load()
    const err = await upsertProvider(session(), { action: 'UPSERT_PROVIDER', name: 'P', apiUrl: 'https://p.example.com', apiKey: KEY }).catch((e: Error) => e)
    expect((err as Error).message).toBe('Connection lost. Please try again.')
    expect(JSON.stringify(err)).not.toContain(KEY)
  })

  it('TOGGLE_ROUTING: a 409 becomes a conflict error carrying the server message', async () => {
    reply(409, { success: false, error: 'no_api_key', message: 'Save the API key of the provider before switching routing on.' })
    const { toggleProviderRouting } = await load()
    const err = (await toggleProviderRouting(session(), provider().id, true).catch((e) => e)) as { code: string; message: string }
    expect(err.code).toBe('conflict')
    expect(err.message).toBe('Save the API key of the provider before switching routing on.')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'TOGGLE_ROUTING', id: provider().id, enabled: true })
  })

  it('maps 400 / 403 / 404 / 500', async () => {
    const { toggleProviderRouting } = await load()
    for (const [status, code] of [[400, 'invalid_input'], [403, 'forbidden'], [404, 'not_found'], [500, 'server']] as const) {
      reply(status, { success: false, message: 'x' })
      expect(((await toggleProviderRouting(session(), 'id', true).catch((e) => e)) as { code: string }).code).toBe(code)
    }
  })

  it('dev mock mode: add, toggle and the same rules as the server', async () => {
    const { listAdminProviders, upsertProvider, toggleProviderRouting } = await load()
    const s = session({ isMock: true })
    const before = await listAdminProviders(s)
    const noKey = before.find((p) => !p.hasApiKey)!
    await expect(toggleProviderRouting(s, noKey.id, true)).rejects.toMatchObject({ code: 'conflict' })

    const created = await upsertProvider(s, { action: 'UPSERT_PROVIDER', name: 'Fresh', apiUrl: 'https://fresh.example.com', apiKey: KEY })
    expect(created.created).toBe(true)
    expect(created.provider.routingEnabled).toBe(false)
    expect(created.provider.hasApiKey).toBe(true)
    expect(JSON.stringify(created)).not.toContain(KEY)
    await expect(upsertProvider(s, { action: 'UPSERT_PROVIDER', name: 'fresh', apiUrl: 'https://f2.example.com' })).rejects.toMatchObject({ code: 'conflict' })
    expect((await toggleProviderRouting(s, created.provider.id, true)).routingEnabled).toBe(true)

    // an edit without apiKey keeps hasApiKey
    const edited = await upsertProvider(s, { action: 'UPSERT_PROVIDER', id: created.provider.id, name: 'Fresh 2' })
    expect(edited.provider).toMatchObject({ name: 'Fresh 2', hasApiKey: true })
    // switching it off also switches routing off
    expect((await upsertProvider(s, { action: 'UPSERT_PROVIDER', id: created.provider.id, isActive: false })).provider.routingEnabled).toBe(false)
    await expect(toggleProviderRouting(s, created.provider.id, true)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('dev mock mode: a non-admin is refused', async () => {
    const { listAdminProviders } = await load()
    await expect(listAdminProviders(session({ isMock: true }, false))).rejects.toMatchObject({ code: 'forbidden' })
  })
})
