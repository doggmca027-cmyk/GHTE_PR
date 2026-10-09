import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { haptic } from '@/lib/haptics'
import type { AuthSession } from '@/services/api/auth'
import { AnalyticsTab } from './AnalyticsTab'
import { ControlCenterTab } from './ControlCenterTab'
import { ObservabilityTab } from './ObservabilityTab'
import { OverviewTab } from './OverviewTab'
import { PriceRulesTab } from './PriceRulesTab'
import { PricingTab } from './PricingTab'
import { PromosTab } from './PromosTab'
import { ProvidersTab } from './ProvidersTab'
import { ReconciliationTab } from './ReconciliationTab'
import { SupportTab } from './SupportTab'
import { TreasuryTab } from './TreasuryTab'

type AdminTab = 'overview' | 'analytics' | 'support' | 'health' | 'queue' | 'prices' | 'pricing' | 'promos' | 'providers' | 'treasury' | 'controls'

export function AdminScreen({ session }: { session: AuthSession }) {
  const [tab, setTab] = useState<AdminTab>('overview')
  const [problems, setProblems] = useState(0)
  const [waiting, setWaiting] = useState(0)
  const onProblemCount = useCallback((n: number) => setProblems(n), [])

  const tabs: { id: AdminTab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Обзор' },
    { id: 'analytics', label: 'Аналитика' },
    { id: 'support', label: 'Поддержка', badge: waiting },
    { id: 'health', label: 'Состояние системы' },
    { id: 'queue', label: 'Сверка', badge: problems },
    { id: 'pricing', label: 'Цены и наценки' },
    { id: 'promos', label: 'Промокоды' },
    { id: 'prices', label: 'Правила цен' },
    { id: 'providers', label: 'Провайдеры' },
    { id: 'treasury', label: 'Финансы' },
    { id: 'controls', label: 'Управление' },
  ]

  return (
    <>
      <h1 className="mb-3 text-2xl font-extrabold tracking-tight text-content-primary">Админка</h1>

      <div role="tablist" aria-label="Разделы админки" className="no-scrollbar -mx-5 mb-4 flex gap-1.5 overflow-x-auto px-5 py-1">
        {tabs.map(({ id, label, badge }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => { if (tab !== id) haptic.select(); setTab(id) }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-2xl px-3.5 py-2 text-[13px] font-semibold transition-colors active:scale-95',
              tab === id ? 'bg-brand text-white shadow-sm' : 'bg-white/70 text-content-secondary hover:bg-white',
            )}
          >
            {label}
            {badge ? (
              <span className={cn('rounded-full px-1.5 text-[11px] font-bold', tab === id ? 'bg-white/25 text-white' : 'bg-amber-100 text-amber-700')}>{badge}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab session={session} onOpenQueue={() => setTab('queue')} onProblemCount={onProblemCount} />}
      {tab === 'analytics' && <AnalyticsTab session={session} />}
      {tab === 'support' && <SupportTab session={session} onWaitingCount={setWaiting} />}
      {tab === 'health' && <ObservabilityTab session={session} />}
      {tab === 'queue' && <ReconciliationTab session={session} onProblemCount={onProblemCount} onOpenPayments={() => setTab('treasury')} />}
      {tab === 'prices' && <PriceRulesTab session={session} />}
      {tab === 'pricing' && <PricingTab session={session} />}
      {tab === 'promos' && <PromosTab session={session} />}
      {tab === 'providers' && <ProvidersTab session={session} />}
      {tab === 'treasury' && <TreasuryTab session={session} />}
      {tab === 'controls' && <ControlCenterTab session={session} />}
    </>
  )
}
