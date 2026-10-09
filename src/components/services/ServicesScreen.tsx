import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowLeft, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FALLBACK_PLATFORMS, type PlatformInfo } from '@/constants/platforms'
import { useAuth } from '@/context/AuthContext'
import { useT } from '@/i18n'
import { track } from '@/lib/analytics-client'
import { haptic } from '@/lib/haptics'
import { fetchCatalog, fetchPlatforms } from '@/services/api/services'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalog, ICatalogService, Platform } from '@/types/catalog'
import { ALL_CATEGORIES, CategoryList } from './CategoryList'
import { OrderModal } from './OrderModal'
import { PlatformList, type PlatformEntry } from './PlatformList'
import { ServiceCard } from './ServiceCard'

type CatalogState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; catalog: ICatalog; platforms: PlatformInfo[] }

interface Props {
  session: AuthSession
  onTopUp: (shortfallUsd?: number) => void
  onViewOrders: () => void
}

function SkeletonCard() {
  return <div className="h-[132px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
}

const titleCase = (slug: string) => slug.replace(/-/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/**
 * The platforms to list: the registry's, plus any platform that has categories but is missing from it (it would otherwise be
 * unreachable). When the registry cannot be read the built-in few are used.
 */
export function mergePlatforms(registry: PlatformInfo[] | null, catalog: ICatalog): PlatformInfo[] {
  const list = [...(registry ?? FALLBACK_PLATFORMS)]
  for (const c of catalog.categories) {
    if (!list.some((p) => p.slug === c.platform)) list.push({ slug: c.platform, name: titleCase(c.platform), category: 'other', sortOrder: 900 })
  }
  return list
}

/** Platforms with services first (the busiest first), then the registry's own order. */
export function platformEntries(platforms: PlatformInfo[], catalog: ICatalog): PlatformEntry[] {
  const platformOfCategory = new Map(catalog.categories.map((c) => [c.id, c.platform]))
  const counts = new Map<string, number>()
  for (const s of catalog.services) {
    const p = platformOfCategory.get(s.categoryId)
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return platforms
    .map((p) => ({ slug: p.slug, name: p.name, count: counts.get(p.slug) ?? 0, sortOrder: p.sortOrder }))
    .sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || (a.count > 0 ? b.count - a.count : 0) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ slug, name, count }) => ({ slug, name, count }))
}

export function ServicesScreen({ session, onTopUp, onViewOrders }: Props) {
  const t = useT()
  const { refreshWallet } = useAuth()
  const [state, setState] = useState<CatalogState>({ status: 'loading' })
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES)
  const [selected, setSelected] = useState<ICatalogService | null>(null)

  const load = useCallback(() => {
    setState({ status: 'loading' })
    Promise.all([fetchCatalog(session), fetchPlatforms(session).catch(() => null)]).then(
      ([catalog, registry]) => setState({ status: 'ready', catalog, platforms: mergePlatforms(registry, catalog) }),
      () => setState({ status: 'error' }),
    )
  }, [session.token, session.isMock]) // reload only when the identity changes, not on balance refresh

  useEffect(load, [load])

  const catalog = state.status === 'ready' ? state.catalog : null
  const entries = useMemo(() => (state.status === 'ready' ? platformEntries(state.platforms, state.catalog) : []), [state])
  const current = platform && state.status === 'ready' ? state.platforms.find((p) => p.slug === platform) ?? null : null

  const categories = useMemo(
    () => (catalog && platform ? catalog.categories.filter((c) => c.platform === platform).sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [catalog, platform],
  )
  const services = useMemo(() => {
    if (!catalog) return []
    const ids = new Set(categories.filter((c) => categoryId === ALL_CATEGORIES || c.id === categoryId).map((c) => c.id))
    return catalog.services
      .filter((s) => ids.has(s.categoryId))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.ratePer1000 - b.ratePer1000 || a.name.localeCompare(b.name))
  }, [catalog, categories, categoryId])

  // The catalog was looked at: when a platform is opened, and again when the customer switches category.
  const ready = state.status === 'ready'
  useEffect(() => {
    if (ready && platform) track('catalog_view', { platform, ...(categoryId !== ALL_CATEGORIES ? { category_id: categoryId } : {}) })
  }, [ready, platform, categoryId])

  const open = (service: ICatalogService) => {
    haptic.tap()
    setSelected(service)
    void refreshWallet() // make sure the balance check uses a fresh value
  }

  const back = () => {
    haptic.select()
    setPlatform(null)
    setCategoryId(ALL_CATEGORIES)
  }

  return (
    <>
      {platform === null ? (
        <h1 className="mb-3 text-2xl font-extrabold tracking-tight text-content-primary">{t('Services')}</h1>
      ) : (
        <div className="mb-3 flex items-center gap-3">
          <button type="button" onClick={back} aria-label={t('Back to platforms')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-blue-100/70 bg-white text-content-secondary shadow-sm active:scale-90">
            <ArrowLeft size={18} strokeWidth={1.75} className="rtl:rotate-180" />
          </button>
          <h1 className="min-w-0 truncate text-2xl font-extrabold tracking-tight text-content-primary">{current?.name ?? titleCase(platform)}</h1>
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

      {state.status === 'ready' && platform === null && <PlatformList platforms={entries} onSelect={(slug) => { setPlatform(slug); setCategoryId(ALL_CATEGORIES) }} />}

      {state.status === 'ready' && platform !== null && (
        <>
          <CategoryList categories={categories} value={categoryId} onChange={setCategoryId} />

          <div className="mt-4 space-y-3">
            {services.length === 0 && (
              <Card className="space-y-2 py-10 text-center">
                <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
                <p className="text-sm font-semibold text-content-primary">{t('No services here yet')}</p>
                <p className="text-xs text-content-secondary">{t('Try another platform or category.')}</p>
              </Card>
            )}

            {services.map((service) => (
              <ServiceCard key={service.id} service={service} platform={platform} platformName={current?.name} onSelect={open} />
            ))}
          </div>
        </>
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

