// @vitest-environment jsdom
// The Home screen: catalogue figures, platform tiles, featured services, orders summary, the invite card and the header fix.
import fs from 'node:fs'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { featuredCategories, ordersSummary, quickPlatforms, referralLink, totalServices } from '../src/lib/home-view'
import { applyStartReferral, inviteStartParam } from '../src/lib/referral-start'
import type { AuthSession } from '../src/services/api/auth'
import type { ICategory } from '../src/types/catalog'

vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ refreshWallet: async () => {}, applyWallet: () => {} }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cat = (id: string, platform: string, name: string, count: number, sortOrder = 0): ICategory => ({ id, platform, name, slug: id, iconUrl: null, sortOrder, count })
const session = (over: Partial<AuthSession> = {}): AuthSession => ({
  token: 'jwt', expiresAt: 0, isMock: true, wallet: { balance: 0, currency: 'USD' },
  user: { id: 'u1', telegramId: 1, username: 'a', firstName: 'A', languageCode: 'en', isAdmin: false }, ...over,
})

describe('home-view', () => {
  it('counts every active service', () => {
    expect(totalServices([cat('a', 'telegram', 'x', 1862), cat('b', 'website', 'y', 1026), { ...cat('c', 'x', 'z', 0), count: undefined }])).toBe(2888)
  })

  it('platform tiles: the popular ones first in a fixed order, then the busiest others, never an empty platform, at most 8', () => {
    const entries = [
      { slug: 'website', name: 'Website', count: 1026 }, { slug: 'kick', name: 'Kick', count: 86 }, { slug: 'telegram', name: 'Telegram', count: 1862 },
      { slug: 'vk', name: 'VK', count: 0 }, { slug: 'instagram', name: 'Instagram', count: 956 }, { slug: 'twitch', name: 'Twitch', count: 69 },
      { slug: 'youtube', name: 'YouTube', count: 852 }, { slug: 'tiktok', name: 'TikTok', count: 527 }, { slug: 'twitter', name: 'X', count: 243 },
      { slug: 'facebook', name: 'Facebook', count: 388 }, { slug: 'spotify', name: 'Spotify', count: 553 },
    ]
    expect(quickPlatforms(entries).map((e) => e.slug)).toEqual(['telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'spotify', 'website'])
    expect(quickPlatforms(entries.filter((e) => e.slug !== 'spotify' && e.slug !== 'website')).map((e) => e.slug).slice(-2)).toEqual(['kick', 'twitch'])
    expect(quickPlatforms(entries, 3)).toHaveLength(3)
  })

  it('featured: the busiest plain category of each slot (the production names), niche variants left out', () => {
    const cats = [
      cat('tg-target', 'telegram', 'Telegram Post Views [country targeting]', 96),
      cat('tg-single', 'telegram', 'Telegram Post Views [single post]', 40),
      cat('tg-premium', 'telegram', 'Telegram Premium Views, Reactions and Reposts', 48),
      cat('tg-auto', 'telegram', 'Telegram Auto Views [future posts]', 36),
      cat('tg-pm', 'telegram', 'Telegram Premium Members [targeted]', 105),
      cat('tg-m', 'telegram', 'Telegram Members [0% drops]', 103),
      cat('tg-ai', 'telegram', 'Telegram AI Members', 78),
      cat('ig-story', 'instagram', 'Instagram Story Views', 56),
      cat('ig-likes', 'instagram', 'Instagram Likes', 43),
      cat('tt-live', 'tiktok', 'TikTok Live Stream Viewers [country targeting]', 57),
      cat('tt-ads', 'tiktok', 'TikTok Views [ads method ADS]', 43),
      cat('tt-views', 'tiktok', 'TikTok Views', 46),
    ]
    expect(featuredCategories(cats).map((c) => c.id)).toEqual(['tg-single', 'tg-m', 'ig-likes', 'tt-views'])
    expect(featuredCategories([cat('x', 'instagram', 'Instagram Likes', 0)])).toEqual([]) // an empty category is never featured
  })

  it('orders summary', () => {
    expect(ordersSummary([{ status: 'processing' }, { status: 'paid' }, { status: 'completed' }, { status: 'canceled' }] as never)).toEqual({ total: 4, active: 2, completed: 1 })
    expect(ordersSummary([])).toEqual({ total: 0, active: 0, completed: 0 })
  })

  it('invite link: only from a real t.me Mini App link', () => {
    expect(referralLink('https://t.me/GHTE_PR_BOT', 'ref_AB12')).toBe('https://t.me/GHTE_PR_BOT?startapp=ref_AB12')
    expect(referralLink('https://t.me/GHTE_PR_BOT/app/', 'ref_AB12')).toBe('https://t.me/GHTE_PR_BOT/app?startapp=ref_AB12')
    expect(referralLink(undefined, 'ref_AB12')).toBeNull()
    expect(referralLink('', 'ref_AB12')).toBeNull()
    expect(referralLink('https://evil.example.com/x', 'ref_AB12')).toBeNull()
    expect(referralLink('https://t.me/bot?x=1', 'ref_AB12')).toBeNull()
  })
})

describe('invite from the start parameter', () => {
  beforeEach(() => localStorage.clear())

  it('only a ref_ start parameter is an invite', () => {
    expect(inviteStartParam('ref_AB12cd')).toBe('ref_AB12cd')
    expect(inviteStartParam('promo_x')).toBeNull()
    expect(inviteStartParam('ref_')).toBeNull()
    expect(inviteStartParam(undefined)).toBeNull()
  })

  it('is sent once per user and invite; a refusal is swallowed', async () => {
    const apply = vi.fn().mockRejectedValueOnce(new Error('own code'))
    const s = session({ isMock: false })
    expect(await applyStartReferral(s, 'ref_AB12', apply)).toBe(true)
    expect(await applyStartReferral(s, 'ref_AB12', apply)).toBe(false)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(s, 'ref_AB12')
    expect(await applyStartReferral(s, 'something_else', apply)).toBe(false)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('referrals client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('SUMMARY and APPLY_CODE post to the referrals function with the user JWT', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, code: 'AB12', startParam: 'ref_AB12', percentage: 5, invitees: 2 }), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, applied: true, alreadyApplied: false }), { status: 200 }))
    const { applyReferralCode, getReferralSummary } = await import('../src/services/api/referrals')
    const s = session({ isMock: false })
    expect(await getReferralSummary(s)).toMatchObject({ code: 'AB12', percentage: 5 })
    await applyReferralCode(s, 'ref_AB12')
    expect(fetchMock.mock.calls[0][0]).toBe('https://proj.supabase.co/functions/v1/referrals')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: 'APPLY_CODE', code: 'ref_AB12' })
  })

  it('a refusal is an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'own_code' }), { status: 409 }))
    const { applyReferralCode } = await import('../src/services/api/referrals')
    await expect(applyReferralCode(session({ isMock: false }), 'ref_AB12')).rejects.toThrow()
  })
})

describe('HomeScreen (dev mock data)', () => {
  let root: Root
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  it('shows the hero, platform tiles, featured services, the orders summary and the invite card; tiles open the platform', async () => {
    const { HomeScreen } = await import('../src/components/home/HomeScreen')
    const browse: (string | undefined)[] = []
    const topUp = vi.fn()
    await act(async () => {
      root.render(createElement(HomeScreen, { session: session(), onBrowse: (p?: string) => browse.push(p), onTopUp: topUp, onViewOrders: () => {} }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const text = host.textContent ?? ''
    expect(text).toContain('Boost your socials')
    expect(text).not.toContain('Placeholder')
    expect(text).toContain('Auto start')
    expect(text).toContain('Popular services')
    expect(text).toContain('Telegram Post Views') // the cheapest service of the mock "Telegram Views" category
    expect(text).toContain('Earn 5% of every order your friends place.')
    expect(text).toContain('My orders')

    const tile = [...host.querySelectorAll('button')].find((b) => b.querySelector('[data-logo]') && [...b.querySelectorAll('span')].some((s) => s.textContent === 'Telegram'))!
    act(() => tile.click())
    expect(browse).toEqual(['telegram'])

    const topUpButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Top up')!
    act(() => topUpButton.click())
    expect(topUp).toHaveBeenCalledTimes(1)
  })
})

describe('header balance on narrow phones', () => {
  it('the amount never truncates into "$..."; the logo gives way instead', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/components/layout/Header.tsx'), 'utf8')
    const amount = src.split('\n').find((l) => l.includes('formatMoney(balance, currency)'))!
    expect(amount).toContain('whitespace-nowrap')
    expect(amount).not.toContain('truncate')
    expect(src).toMatch(/className="flex shrink-0 items-center gap-1 rounded-full/) // the balance pill does not shrink
    expect(src).toMatch(/<div className="min-w-0 overflow-hidden">\s*<Logo \/>/)
  })
})
