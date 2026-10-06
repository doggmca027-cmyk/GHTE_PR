import { useState } from 'react'
import { AlertCircle, Check, Landmark, Minus, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { parseAmount, signedUsd, treasuryTypeLabel, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { newIdempotencyKey } from '@/lib/idempotency'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { adjustTreasury, getTreasury } from '@/services/api/admin'
import type { TreasuryTx } from '@/types/admin'

export function TreasuryTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => getTreasury(session), [session.token, session.isMock])
  const [more, setMore] = useState<TreasuryTx[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined) // undefined: follow the first page
  const [loadingMore, setLoadingMore] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  if (!data && loading) return <div className="h-[180px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load the treasury.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  const cursor = nextBefore === undefined ? data.nextBefore : nextBefore
  const rows = [...data.transactions, ...more.filter((m) => !data.transactions.some((t) => t.id === m.id))]

  async function loadMore() {
    if (cursor === null) return
    setLoadingMore(true)
    try {
      const page = await getTreasury(session, cursor)
      setMore((m) => [...m, ...page.transactions])
      setNextBefore(page.nextBefore)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card className="space-y-1 p-5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-content-secondary"><Landmark size={14} strokeWidth={1.75} /> Treasury balance</p>
        <p className="text-4xl font-extrabold tracking-tight text-content-primary">{usd(data.balance)}</p>
        <p className="text-xs text-content-secondary">Updated {timeAgo(data.updatedAt)} · separate from customer wallets and provider balances</p>
        <Button className="mt-3 h-11 w-full text-sm" onClick={() => { haptic.tap(); setMessage(null); setAdjusting(true) }}>Manual Adjustment</Button>
      </Card>

      {message && <p role="status" className="rounded-2xl bg-emerald-50 px-3.5 py-2.5 text-[13px] font-medium text-emerald-700">{message}</p>}

      <h2 className="px-1 text-sm font-bold text-content-primary">Ledger</h2>
      {rows.length === 0 && <Card className="p-4 text-sm text-content-secondary">No treasury transactions yet.</Card>}
      <ul className="space-y-2">
        {rows.map((t) => (
          <li key={t.id} className="rounded-2xl border border-blue-100/70 bg-white px-3.5 py-3 shadow-card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-content-primary">{treasuryTypeLabel(t.type)}</p>
                {t.description && <p className="mt-0.5 break-words text-xs text-content-secondary">{t.description}</p>}
              </div>
              <p className={cn('shrink-0 text-[15px] font-extrabold', t.type === 'deposit' ? 'text-emerald-600' : 'text-content-primary')}>{signedUsd(t.amount)}</p>
            </div>
            <p className="mt-1 text-[11px] text-content-secondary">{timeAgo(t.createdAt)} · balance after {usd(t.balanceAfter)}</p>
          </li>
        ))}
      </ul>
      {cursor !== null && (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="h-11 w-full rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95 disabled:opacity-50">
          {loadingMore ? 'Loading...' : 'Load older'}
        </button>
      )}

      {adjusting && (
        <AdjustModal
          balance={data.balance}
          onClose={() => setAdjusting(false)}
          onSubmit={async (input) => {
            try {
              await adjustTreasury(session, input)
            } catch (e) {
              haptic.error()
              throw e
            }
            haptic.success()
            setMessage(`Treasury ${input.amount < 0 ? 'debited' : 'credited'} ${usd(Math.abs(input.amount))}.`)
            setAdjusting(false)
            setMore([])
            setNextBefore(undefined)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function AdjustModal({ balance, onClose, onSubmit }: { balance: number; onClose: () => void; onSubmit: (i: { amount: number; description: string; idempotencyKey: string }) => Promise<void> }) {
  const [direction, setDirection] = useState<'add' | 'remove'>('add')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // One key per opened form: a retry after a network error books the movement once, never twice.
  const [key] = useState(newIdempotencyKey)

  const value = parseAmount(amount)
  const signed = value === null || value === 0 ? null : direction === 'add' ? value : -value
  const tooMuch = direction === 'remove' && value !== null && value > balance
  const reason = description.trim()
  const valid = signed !== null && !tooMuch && reason.length >= 3 && reason.length <= 200

  return (
    <div role="dialog" aria-modal="true" aria-label="Manual treasury adjustment" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">Manual adjustment</h3>
        <div role="radiogroup" aria-label="Direction" className="flex gap-2">
          {([['add', 'Add funds', Plus], ['remove', 'Remove funds', Minus]] as const).map(([d, label, Icon]) => (
            <button key={d} type="button" role="radio" aria-checked={direction === d} onClick={() => setDirection(d)}
              className={cn('flex h-10 flex-1 items-center justify-center gap-1 rounded-2xl text-sm font-semibold', direction === d ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
              <Icon size={14} strokeWidth={2} /> {label}
            </button>
          ))}
        </div>
        <label className="block text-xs font-bold text-content-primary">
          Amount (USD)
          <input value={amount} inputMode="decimal" autoFocus onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={amount !== '' && signed === null}
            className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', amount === '' || signed !== null ? 'border-blue-100/70 focus:border-brand' : 'border-rose-300')} />
        </label>
        {tooMuch && <p role="alert" className="text-xs font-semibold text-rose-600">Only {usd(balance)} is available.</p>}
        <label className="block text-xs font-bold text-content-primary">
          Reason (kept in the ledger)
          <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Initial funding"
            className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand" />
        </label>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy}
            onClick={async () => {
              if (signed === null) return
              setBusy(true); setErr(null)
              try { await onSubmit({ amount: signed, description: reason, idempotencyKey: key }) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); setBusy(false) }
            }}>
            <Check size={16} strokeWidth={2} /> Confirm
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
