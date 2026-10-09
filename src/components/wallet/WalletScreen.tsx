import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ReceiptText, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuth } from '@/context/AuthContext'
import { useTonWallet } from '@/hooks/useTonWallet'
import { useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { LEDGER_FILTERS, matchesLedgerFilter } from '@/lib/ledger-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getLedger, verifyDeposit } from '@/services/api/deposits'
import type { LedgerEntry, LedgerFilter } from '@/types/wallet'
import { BalanceCard } from './BalanceCard'
import { DepositModal } from './DepositModal'
import { LedgerRow } from './LedgerList'
import { TonWalletButton } from './TonWalletButton'

export interface DepositRequest {
  /** Suggested USD amount (e.g. the shortfall of an order the user could not afford). */
  amount?: number
}

interface Props {
  session: AuthSession
  /** Opens the deposit drawer on mount / when set. Cleared through onRequestHandled. */
  depositRequest: DepositRequest | null
  onRequestHandled: () => void
}

export function WalletScreen({ session, depositRequest, onRequestHandled }: Props) {
  const t = useT()
  const { applyWallet } = useAuth()
  const tonWallet = useTonWallet()
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [depositOpen, setDepositOpen] = useState(false)
  const [initialAmount, setInitialAmount] = useState<number | undefined>()
  const mounted = useRef(true)

  const load = useCallback(async (): Promise<LedgerEntry[] | undefined> => {
    setRefreshing(true)
    try {
      const rows = await getLedger(session)
      if (!mounted.current) return undefined
      setEntries(rows)
      setError(false)
      return rows
    } catch {
      if (mounted.current) setError(true)
      return undefined
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load, then re-check open deposits: a payment made while the app was closed gets credited here.
  useEffect(() => {
    mounted.current = true
    void (async () => {
      const rows = await load()
      if (!rows || session.isMock) return
      let credited = false
      for (const d of rows.filter((r) => r.depositId && r.status === 'pending').slice(0, 3)) {
        try {
          const r = await verifyDeposit(session, d.depositId!)
          if (r.status === 'completed') {
            credited = true
            if (r.wallet) applyWallet(r.wallet)
          }
        } catch { /* not paid / transient: leave it pending */ }
      }
      if (credited && mounted.current) void load()
    })()
    return () => { mounted.current = false }
  }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  // Open the drawer when another screen asked for a top-up.
  useEffect(() => {
    if (!depositRequest) return
    setInitialAmount(depositRequest.amount)
    setDepositOpen(true)
    onRequestHandled()
  }, [depositRequest, onRequestHandled])

  const visible = useMemo(() => (entries ?? []).filter((e) => matchesLedgerFilter(e.type, filter)), [entries, filter])

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-2xl font-extrabold tracking-tight text-content-primary">{t('Wallet')}</h1>
        <TonWalletButton wallet={tonWallet} />
      </div>

      <BalanceCard wallet={session.wallet} onTopUp={() => { haptic.tap(); setInitialAmount(undefined); setDepositOpen(true) }} />

      <div className="mb-1 mt-6 flex items-center justify-between">
        <h2 className="text-base font-extrabold text-content-primary">{t('Transactions')}</h2>
        <button
          type="button"
          onClick={() => { haptic.tap(); void load() }}
          disabled={refreshing}
          aria-label={t('Refresh transactions')}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-blue-100/70 bg-white text-content-secondary shadow-sm active:scale-90"
        >
          <RefreshCw size={16} strokeWidth={1.75} className={cn(refreshing && 'animate-spin')} />
        </button>
      </div>

      <div role="tablist" aria-label={t('Transaction filter')} className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5 py-1">
        {LEDGER_FILTERS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={filter === id}
            onClick={() => { if (filter !== id) haptic.select(); setFilter(id) }}
            className={cn('shrink-0 rounded-2xl px-3.5 py-2 text-[13px] font-semibold transition-colors active:scale-95', filter === id ? 'bg-brand-light text-brand-text' : 'bg-white/70 text-content-secondary hover:bg-white')}
          >
            {t(label)}
          </button>
        ))}
      </div>

      <ul className="mt-3 space-y-2.5 pb-2">
        {entries === null && !error && [0, 1, 2].map((i) => <li key={i} className="h-[74px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}

        {error && (
          <li>
            <Card className="space-y-3 text-center">
              <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
              <p className="text-sm font-medium text-content-secondary">{t("Couldn't load your transactions.")}</p>
              <Button className="w-full" onClick={() => void load()}>{t('Retry')}</Button>
            </Card>
          </li>
        )}

        {entries !== null && visible.length === 0 && (
          <li>
            <Card className="space-y-2 py-8 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-light text-brand"><ReceiptText size={22} strokeWidth={1.75} /></span>
              <p className="text-sm font-bold text-content-primary">{entries.length === 0 ? t('No transactions yet') : t('Nothing here')}</p>
              <p className="text-xs text-content-secondary">{entries.length === 0 ? t('Top up your balance to get started.') : t('No transactions match this filter.')}</p>
            </Card>
          </li>
        )}

        {visible.map((entry) => <LedgerRow key={entry.id} entry={entry} />)}
      </ul>

      {depositOpen && (
        <DepositModal
          session={session}
          wallet={tonWallet}
          initialAmount={initialAmount}
          onClose={() => setDepositOpen(false)}
          onCredited={() => void load()}
        />
      )}
    </>
  )
}
