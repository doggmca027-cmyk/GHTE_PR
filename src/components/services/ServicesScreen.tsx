import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Loader2, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FALLBACK_PLATFORMS, type PlatformInfo } from '@/constants/platforms'
import { useAuth } from '@/context/AuthContext'
import { useServiceSearch } from '@/hooks/useServiceSearch'
import { useLanguage, useT } from '@/i18n'
import { track } from '@/lib/analytics-client'
import { haptic } from '@/lib/haptics'
import { localizedName } from '@/lib/service-view'
import { SERVICES_PAGE, fetchCategories, fetchCategoryServices, fetchPlatforms } from '@/services/api/services'
import { cachedLoad, isFresh, peekCached } from '@/lib/catalog-cache'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalogService, ICategory, Platform } from '@/types/catalog'
import { CategoryRows } from './CategoryRows'
import { OrderModal } from './OrderModal'
import { PlatformList, type PlatformEntry } from './PlatformList'
import { ServiceCard } from './ServiceCard'
import { ServiceSearchBox } from './ServiceSearchBox'
import { VariantCard } from './VariantCard'

type Overview = { status: 'loading' } | { status: 'error' } | { status: 'ready'; categories: ICategory[]; platforms: PlatformInfo[] }

/** The services of the opened category, loaded a page at a time. */
type Page = { categoryId: string; items: ICatalogService[]; status: 'loading' | 'ready' | 'error'; more: boolean; loadingMore: boolean }

interface Props {
  session: AuthSession
  onTopUp: (shortfallUsd?: number) => void
  onViewOrders: () => void
  /** Open straight on this platform (a tile of the Home screen was tapped). */
  initialPlatform?: string | null
}

function SkeletonCard() {
  return <div className="h-[132px] animate-pulse rounded-3xl border border-blue-100/70 bg-surface/80" />
}

const titleCase = (slug: string) => slug.replace(/-/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/**
 * The platforms to list: the registry's, plus any platform that has categories but is missing from it (it would otherwise be
 * unreachable). When the registry cannot be read the built-in few are used.
 */
export function mergePlatforms(registry: PlatformInfo[] | null, categories: ReadonlyArray<Pick<ICategory, 'platform'>>): PlatformInfo[] {
  const list = [...(registry ?? FALLBACK_PLATFORMS)]
  for (const c of categories) {
    if (!list.some((p) => p.slug === c.platform)) list.push({ slug: c.platform, name: titleCase(c.platform), category: 'other', sortOrder: 900 })
  }
  return list
}

/** Platforms with services first (the busiest first), then the registry's own order. */
export function platformEntries(platforms: PlatformInfo[], categories: ReadonlyArray<Pick<ICategory, 'platform' | 'count'>>): PlatformEntry[] {
  const counts = new Map<string, number>()
  for (const c of categories) counts.set(c.platform, (counts.get(c.platform) ?? 0) + (c.count ?? 0))
  return platforms
    .map((p) => ({ slug: p.slug, name: p.name, count: counts.get(p.slug) ?? 0, sortOrder: p.sortOrder }))
    .sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || (a.count > 0 ? b.count - a.count : 0) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ slug, name, count }) => ({ slug, name, count }))
}

export function ServicesScreen({ session, onTopUp, onViewOrders, initialPlatform = null }: Props) {
  const t = useT()
  const { lang } = useLanguage()
  const { refreshWallet } = useAuth()
  const [state, setState] = useState<Overview>({ status: 'loading' })
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  const [selected, setSelected] = useState<ICatalogService | null>(null)
  const [serviceQuery, setServiceQuery] = useState('')
  const request = useRef(0)

  // The catalogue is kept in memory for a few minutes (lib/catalog-cache.ts): reopening the tab shows it at once and refreshes it quietly.
  const who = session.isMock ? 'mock' : session.user.id
  const load = useCallback(() => {
    const key = `overview:${who}`
    const hit = peekCached<{ categories: ICategory[]; platforms: PlatformInfo[] }>(key)
    setState(hit ? { status: 'ready', ...hit } : { status: 'loading' })
    if (hit && isFresh(key)) return
    cachedLoad(key, () => Promise.all([fetchCategories(session), fetchPlatforms(session).catch(() => null)])
      .then(([categories, registry]) => ({ categories, platforms: mergePlatforms(registry, categories) }))).then(
      (v) => setState({ status: 'ready', ...v }),
      () => { if (!hit) setState({ status: 'error' }) },
    )
  }, [session.token, session.isMock]) // reload only when the identity changes, not on balance refresh

  useEffect(load, [load])

  const categories = state.status === 'ready' ? state.categories : []
  const entries = useMemo(() => (state.status === 'ready' ? platformEntries(state.platforms, state.categories) : []), [state])
  const current = platform && state.status === 'ready' ? state.platforms.find((p) => p.slug === platform) ?? null : null
  const platformCategories = useMemo(
    () => (platform ? categories.filter((c) => c.platform === platform).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)) : []),
    [categories, platform],
  )
  const category = categoryId ? platformCategories.find((c) => c.id === categoryId) ?? null : null

  // The search covers the opened category, or every category of the opened platform.
  const searchScope = useMemo(() => (categoryId ? [categoryId] : platformCategories.map((c) => c.id)), [categoryId, platformCategories])
  const search = useServiceSearch(session, searchScope, platform ? serviceQuery : '')

  // The first page of a category's services, when the category is opened.
  // (from memory first when it was opened or touched a moment ago, see prefetch below)
  const firstPageKey = (id: string) => `category:${who}:${id}`
  const loadFirstPage = (id: string) => cachedLoad(firstPageKey(id), () => fetchCategoryServices(session, id, 0, SERVICES_PAGE))
  useEffect(() => {
    if (!categoryId) { setPage(null); return }
    const mine = ++request.current
    const key = firstPageKey(categoryId)
    const hit = peekCached<ICatalogService[]>(key)
    setPage(hit
      ? { categoryId, items: hit, status: 'ready', more: hit.length === SERVICES_PAGE, loadingMore: false }
      : { categoryId, items: [], status: 'loading', more: false, loadingMore: false })
    if (hit && isFresh(key)) return
    loadFirstPage(categoryId).then(
      (items) => { if (request.current === mine) setPage({ categoryId, items, status: 'ready', more: items.length === SERVICES_PAGE, loadingMore: false }) },
      () => { if (request.current === mine && !hit) setPage({ categoryId, items: [], status: 'error', more: false, loadingMore: false }) },
    )
  }, [categoryId, session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps
  /** A category row is being pressed: its first page starts loading now (errors are ignored here; opening shows them). */
  const prefetch = (id: string) => { if (!isFresh(firstPageKey(id))) loadFirstPage(id).catch(() => undefined) }

  const loadMore = () => {
    if (!page || page.status !== 'ready' || page.loadingMore || !page.more) return
    const mine = ++request.current
    haptic.tap()
    setPage({ ...page, loadingMore: true })
    fetchCategoryServices(session, page.categoryId, page.items.length, SERVICES_PAGE).then(
      (items) => { if (request.current === mine) setPage((p) => (p && p.categoryId === page.categoryId ? { ...p, items: [...p.items, ...items], more: items.length === SERVICES_PAGE, loadingMore: false } : p)) },
      () => { if (request.current === mine) setPage((p) => (p ? { ...p, loadingMore: false } : p)) },
    )
  }

  // The catalog was looked at: when a category is opened.
  useEffect(() => {
    if (platform && categoryId) track('catalog_view', { platform, category_id: categoryId })
  }, [platform, categoryId])

  const open = (service: ICatalogService) => {
    haptic.tap()
    setSelected(service)
    void refreshWallet() // make sure the balance check uses a fresh value
  }

  const selectPlatform = (slug: string) => {
    const own = categories.filter((c) => c.platform === slug)
    setPlatform(slug)
    setServiceQuery('')
    // a platform with a single category goes straight to its services
    setCategoryId(own.length === 1 ? own[0].id : null)
  }

  // A platform picked on the Home screen: opened once the catalogue is here (a single-category platform goes to its services).
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !initialPlatform || state.status !== 'ready') return
    opened.current = true
    if (state.categories.some((c) => c.platform === initialPlatform)) selectPlatform(initialPlatform)
  }, [state, initialPlatform]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => {
    haptic.select()
    setServiceQuery('')
    if (categoryId && platformCategories.length > 1) setCategoryId(null)
    else { setCategoryId(null); setPlatform(null) }
  }

  const title = category ? localizedName(category.name, category.nameI18n, lang) : current?.name ?? (platform ? titleCase(platform) : t('Services'))

  return (
    <>
      {platform === null ? (
        <h1 className="mb-3 text-2xl font-extrabold tracking-tight text-content-primary">{t('Services')}</h1>
      ) : (
        <div className="mb-3 flex items-center gap-3">
          <button type="button" onClick={back} aria-label={category && platformCategories.length > 1 ? t('Back to categories') : t('Back to platforms')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-blue-100/70 bg-surface text-content-secondary shadow-sm active:scale-90">
            <ArrowLeft size={18} strokeWidth={1.75} className="rtl:rotate-180" />
          </button>
          <div className="min-w-0">
            <h1 className="line-clamp-2 text-xl font-extrabold leading-tight tracking-tight text-content-primary">{title}</h1>
            {category && current && platformCategories.length > 1 && <p className="truncate text-xs font-medium text-content-muted">{current.name}</p>}
          </div>
        </div>
      )}

      {state.status === 'loading' && <div className="space-y-3">{[0, 1, 2].map((i) => <SkeletonCard key={i} />)}</div>}

      {state.status === 'error' && (
        <Card className="space-y-3 text-center">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{t("Couldn't load services. Check your connection and retry.")}</p>
          <Button className="w-full" onClick={load}>{t('Retry')}</Button>
        </Card>
      )}

      {state.status === 'ready' && platform === null && <PlatformList platforms={entries} onSelect={selectPlatform} />}

      {state.status === 'ready' && platform !== null && platformCategories.length > 0 && (
        <ServiceSearchBox value={serviceQuery} onChange={setServiceQuery} />
      )}

      {state.status === 'ready' && platform !== null && search.active && (
        <div className="mt-1 space-y-3">
          {(search.status === 'idle' || search.status === 'loading') && [0, 1, 2].map((i) => <SkeletonCard key={i} />)}

          {search.status === 'error' && (
            <Card className="space-y-3 text-center">
              <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
              <p className="text-sm font-medium text-content-secondary">{t("Couldn't load services. Check your connection and retry.")}</p>
              <Button className="w-full" onClick={search.retry}>{t('Retry')}</Button>
            </Card>
          )}

          {search.status === 'ready' && search.items.length === 0 && (
            <Card className="space-y-2 py-10 text-center">
              <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
              <p className="text-sm font-semibold text-content-primary">{t('No services found')}</p>
              <p className="text-xs text-content-secondary">{t('Try other words or a country.')}</p>
            </Card>
          )}

          {search.status === 'ready' && search.items.map((service) => (
            <ServiceCard key={service.id} service={service} platform={platform} platformName={current?.name} onSelect={open} />
          ))}

          {search.status === 'ready' && search.more && (
            <Button className="w-full" onClick={search.loadMore} disabled={search.loadingMore} aria-busy={search.loadingMore}>
              {search.loadingMore && <Loader2 size={16} strokeWidth={2} className="animate-spin" />} {t('Show more')}
            </Button>
          )}
        </div>
      )}

      {state.status === 'ready' && platform !== null && !search.active && categoryId === null && (
        platformCategories.length === 0 ? (
          <Card className="space-y-2 py-10 text-center">
            <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
            <p className="text-sm font-semibold text-content-primary">{t('No services here yet')}</p>
            <p className="text-xs text-content-secondary">{t('Try another platform or category.')}</p>
          </Card>
        ) : (
          <CategoryRows categories={platformCategories} onSelect={setCategoryId} onIntent={prefetch} />
        )
      )}

      {state.status === 'ready' && platform !== null && !search.active && categoryId !== null && (
        <div className="space-y-3">
          {(!page || page.status === 'loading') && [0, 1, 2].map((i) => <SkeletonCard key={i} />)}

          {page?.status === 'error' && (
            <Card className="space-y-3 text-center">
              <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
              <p className="text-sm font-medium text-content-secondary">{t("Couldn't load services. Check your connection and retry.")}</p>
              <Button className="w-full" onClick={() => { const id = categoryId; setCategoryId(null); setTimeout(() => setCategoryId(id), 0) }}>{t('Retry')}</Button>
            </Card>
          )}

          {page?.status === 'ready' && page.items.length === 0 && (
            <Card className="space-y-2 py-10 text-center">
              <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
              <p className="text-sm font-semibold text-content-primary">{t('No services here yet')}</p>
              <p className="text-xs text-content-secondary">{t('Try another platform or category.')}</p>
            </Card>
          )}

          {page?.status === 'ready' && page.items.map((service) => (service.variants?.length
            ? <VariantCard key={service.id} service={service} platform={platform} platformName={current?.name} onSelect={open} />
            : <ServiceCard key={service.id} service={service} platform={platform} platformName={current?.name} onSelect={open} />
          ))}

          {page?.status === 'ready' && page.more && (
            <Button className="w-full" onClick={loadMore} disabled={page.loadingMore} aria-busy={page.loadingMore}>
              {page.loadingMore && <Loader2 size={16} strokeWidth={2} className="animate-spin" />} {t('Show more')}
            </Button>
          )}
        </div>
      )}

      {selected && platform && (
        <OrderModal
          service={selected}
          platform={platform}
          platformName={current?.name}
          session={session}
          onClose={() => setSelected(null)}
          onTopUp={(shortfall) => { setSelected(null); onTopUp(shortfall) }}
          onViewOrders={() => { setSelected(null); onViewOrders() }}
        />
      )}
    </>
  )
}
