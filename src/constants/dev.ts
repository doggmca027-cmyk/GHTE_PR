import type { ICatalog, ICatalogService, ICategory } from '@/types/catalog'
import type { AuthSession } from '@/services/api/auth'

/** Used only when running `npm run dev` outside Telegram. Never reaches a production build path. */
export const MOCK_SESSION: AuthSession = {
  token: '',
  expiresAt: Number.MAX_SAFE_INTEGER,
  isMock: true,
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    telegramId: 1,
    username: 'dev_user',
    firstName: 'Dev',
    languageCode: 'en',
    isAdmin: true, // dev mock user can open the admin dashboard
  },
  wallet: { balance: 24.5, currency: 'USD' },
}

// Offline catalogue for `npm run dev` outside Telegram. Mirrors supabase/seed.sql.
const cat = (n: number, platform: ICategory['platform'], name: string, slug: string): ICategory => ({
  id: `00000000-0000-4000-8000-00000000c00${n}`, platform, name, slug, iconUrl: null, sortOrder: n * 10,
})
const svc = (
  n: number, c: ICategory, name: string, rate: number, min: number, max: number, refill: boolean, sort: number,
): ICatalogService => ({
  id: `00000000-0000-4000-8000-00000000d00${n}`, categoryId: c.id, name, description: null,
  ratePer1000: rate, minQuantity: min, maxQuantity: max, refillSupported: refill, sortOrder: sort,
})

const tgViews = cat(1, 'telegram', 'Telegram Views', 'telegram-views')
const tgMembers = cat(2, 'telegram', 'Telegram Members', 'telegram-members')
const igFollowers = cat(3, 'instagram', 'Instagram Followers', 'instagram-followers')
const ttLikes = cat(4, 'tiktok', 'TikTok Likes', 'tiktok-likes')

export const MOCK_CATALOG: ICatalog = {
  categories: [tgViews, tgMembers, igFollowers, ttLikes],
  services: [
    svc(1, tgViews, 'Telegram Post Views [Instant]', 0.24, 100, 1_000_000, false, 10),
    svc(2, tgViews, 'Telegram Post Views [Real, 30 Days]', 0.75, 100, 500_000, false, 20),
    svc(3, tgMembers, 'Telegram Channel Members [Non-Drop 30D]', 5.4, 50, 50_000, true, 10),
    svc(4, tgMembers, 'Telegram Group Members [Mixed]', 2.7, 100, 100_000, true, 20),
    svc(5, igFollowers, 'Instagram Followers [Real, Refill 30D]', 6, 50, 100_000, true, 10),
    svc(6, igFollowers, 'Instagram Followers [Fast, No Refill]', 3, 100, 200_000, false, 20),
    svc(7, ttLikes, 'TikTok Likes [Instant]', 1.5, 20, 100_000, false, 10),
    svc(8, ttLikes, 'TikTok Likes [Real, Refill]', 2.5, 50, 50_000, true, 20),
  ],
}
