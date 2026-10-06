import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuth } from '@/context/AuthContext'
import { haptic } from '@/lib/haptics'
import { fetchCatalog } from '@/services/api/services'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalog, ICatalogService, Platform } from '@/types/catalog'
import { ALL_CATEGORIES, CategoryList } from './CategoryList'
import { OrderModal } from './OrderModal'
import { PlatformSelector } from './PlatformSelector'
import { ServiceCard } from './ServiceCard'

type CatalogState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; catalog: ICatalog }

interface Props {
  session: AuthSession
  onTopUp: (shortfallUsd?: number) => void
  onViewOrders: () => void
}

function SkeletonCard() {
  return <div className="h-[132px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
}

export function ServicesScreen({ session, onTopUp, onViewOrders }: Props) {
  const { refreshWallet } = useAuth()
  const [state, setState] = useState<CatalogState>({ status: 'loading' })
  const [platform, setPlatform] = useState<Platform>('telegram')
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES)
  const [selected, setSelected] = useState<ICatalogService | null>(null)

  const load = useCallback(() => {
    setState({ status: 'loading' })
    fetchCatalog(session).then(
      (catalog) => setState({ status: 'ready', catalog }),
      () => setState({ status: 'error' }),
    )
  }, [session.token, session.isMock]) // reload only when the identity changes, not on balance refresh

  useEffect(load, [load])

  const catalog = state.status === 'ready' ? state.catalog : null

  const categories = useMemo(
    () => (catalog ? catalog.categories.filter((c) => c.platform === platform).sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [catalog, platform],
  )
  const services = useMemo(() => {
    if (!catalog) return []
    const ids = new Set(categories.filter((c) => categoryId === ALL_CATEGORIES || c.id === categoryId).map((c) => c.id))
    return catalog.services
      .filter((s) => ids.has(s.categoryId))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.ratePer1000 - b.ratePer1000 || a.name.localeCompare(b.name))
  }, [catalog, categories, categoryId])

  const open = (service: ICatalogService) => {
    haptic.tap()
    setSelected(service)
    void refreshWallet() // make sure the balance check uses a fresh value
  }

  return (
    <>
      <h1 className="mb-3 text-2xl font-extrabold tracking-tight text-content-primary">Services</h1>

      <div className="space-y-2">
        <PlatformSelector value={platform} onChange={(p) => { setPlatform(p); setCategoryId(ALL_CATEGORIES) }} />
        <CategoryList categories={categories} value={categoryId} onChange={setCategoryId} />
      </div>

      <div className="mt-4 space-y-3">
        {state.status === 'loading' && [0, 1, 2].map((i) => <SkeletonCard key={i} />)}

        {state.status === 'error' && (
          <Card className="space-y-3 text-center">
            <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
            <p className="text-sm font-medium text-content-secondary">Couldn't load services. Check your connection and retry.</p>
            <Button className="w-full" onClick={load}>Retry</Button>
          </Card>
        )}

        {state.status === 'ready' && services.length === 0 && (
          <Card className="space-y-2 py-10 text-center">
            <SearchX size={28} strokeWidth={1.75} className="mx-auto text-content-muted" />
            <p className="text-sm font-semibold text-content-primary">No services here yet</p>
            <p className="text-xs text-content-secondary">Try another platform or category.</p>
          </Card>
        )}

        {services.map((service) => (
          <ServiceCard key={service.id} service={service} platform={platform} onSelect={open} />
        ))}
      </div>

      {selected && (
        <OrderModal
          service={selected}
          platform={platform}
          session={session}
          onClose={() => setSelected(null)}
          onTopUp={(shortfall) => { setSelected(null); onTopUp(shortfall) }}
          onViewOrders={() => { setSelected(null); onViewOrders() }}
        />
      )}
    </>
  )
}
