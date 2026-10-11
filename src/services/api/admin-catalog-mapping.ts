// Client of the admin-catalog-mapping Edge Function, bundle part: one storefront service sold through several providers.
// Admins only; the server checks it on every call.

import { MOCK_CATALOG } from '@/constants/dev'
import { AdminApiError } from './mock-admin'
import type { AuthSession } from './auth'
import type { BundleSearchItem, BundleView, LinkByExternalIdResult } from '@/types/catalog-mapping'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
// linking fetches the provider's whole service list (the biggest panels answer in ~20 s)
const TIMEOUT_MS = 60_000

async function call<T>(session: AuthSession, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AdminApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-catalog-mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new AdminApiError('network', 'Нет связи с сервером. Попробуйте ещё раз.')
  }
  const data = (await res.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
  if (res.ok && data?.success) return data
  if (res.status === 401 || res.status === 403) throw new AdminApiError('forbidden', 'Нужны права администратора.')
  if (res.status === 400) throw new AdminApiError('invalid_input', data?.message ?? 'Неверные данные.')
  if (res.status === 404) throw new AdminApiError('not_found', data?.message ?? 'Не найдено.')
  if (res.status === 409 || res.status === 502) throw new AdminApiError('conflict', data?.message ?? 'Операция отклонена.')
  throw new AdminApiError('server', 'Что-то пошло не так. Попробуйте ещё раз.')
}

const guardMock = (session: AuthSession) => {
  if (!session.user.isAdmin) throw new AdminApiError('forbidden', 'Нужны права администратора.')
}

export async function searchBundleServices(session: AuthSession, search: string): Promise<BundleSearchItem[]> {
  if (session.isMock) {
    guardMock(session)
    const q = search.trim().toLowerCase()
    return MOCK_CATALOG.services
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((s) => ({ id: s.id, name: s.name, platform: MOCK_CATALOG.categories.find((c) => c.id === s.categoryId)?.platform ?? 'other', customerRatePer1000: s.ratePer1000, offers: 1 }))
  }
  return (await call<{ services: BundleSearchItem[] }>(session, { action: 'SEARCH_SERVICES', search })).services
}

export async function listBundle(session: AuthSession, serviceId: string): Promise<BundleView> {
  if (session.isMock) {
    guardMock(session)
    const s = MOCK_CATALOG.services.find((x) => x.id === serviceId)
    if (!s) throw new AdminApiError('not_found', 'Услуга не найдена.')
    return {
      service: { id: s.id, name: s.name, platform: 'other', customerRatePer1000: s.ratePer1000 },
      price: { basisCost: null, currentRate: s.ratePer1000, newRate: s.ratePer1000, changed: false },
      offers: [],
    }
  }
  const r = await call<BundleView>(session, { action: 'LIST_SERVICE_OFFERS', serviceId })
  return { service: r.service, price: r.price, offers: r.offers }
}

export async function linkByExternalId(
  session: AuthSession,
  input: { serviceId: string; providerId: string; externalServiceId: string; routingScore?: number },
): Promise<LinkByExternalIdResult> {
  if (session.isMock) {
    guardMock(session)
    throw new AdminApiError('conflict', 'В демо-режиме провайдеры не подключены: привязка недоступна.')
  }
  return call<LinkByExternalIdResult>(session, { action: 'LINK_BY_EXTERNAL_ID', ...input })
}

export async function unlinkOffer(session: AuthSession, offerId: string): Promise<BundleView> {
  if (session.isMock) {
    guardMock(session)
    throw new AdminApiError('conflict', 'В демо-режиме связки не меняются.')
  }
  const r = await call<BundleView>(session, { action: 'UNLINK_OFFER', offerId })
  return { service: r.service, price: r.price, offers: r.offers }
}
