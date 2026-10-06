import { useState } from 'react'
import { AlertCircle, Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { LOW_MARGIN_PERCENT, pricingHealth, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getPricing, setServiceMargin } from '@/services/api/admin'
import { calculateCustomerRate } from '../../../supabase/functions/_shared/price-engine.ts'
import type { PricingRow } from '@/types/admin'

export function PricingTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => getPricing(session), [session.token, session.isMock])
  const [editing, setEditing] = useState<PricingRow | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  if (!data && loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-[130px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}
      </div>
    )
  }
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load pricing.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Cost is the offer routing would pick right now (healthy providers only). A saved margin reprices the service immediately.
      </p>
      {message && (
        <p role="status" className={cn('rounded-2xl px-3.5 py-2.5 text-[13px] font-medium', message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          {message.text}
        </p>
      )}
      {data.length === 0 && <Card className="p-4 text-sm text-content-secondary">No active services.</Card>}
      {data.map((row) => <PricingCard key={row.serviceId} row={row} onEdit={() => { haptic.tap(); setMessage(null); setEditing(row) }} />)}

      {editing && (
        <MarginModal
          row={editing}
          onClose={() => setEditing(null)}
          onSave={async (type, value) => {
            try {
              await setServiceMargin(session, { serviceId: editing.serviceId, type, value })
            } catch (e) {
              haptic.error()
              throw e
            }
            haptic.success()
            setMessage({ kind: 'ok', text: `${editing.name}: margin updated.` })
            setEditing(null)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function PricingCard({ row, onEdit }: { row: PricingRow; onEdit: () => void }) {
  const health = pricingHealth(row)
  const bad = health === 'loss' || health === 'low'
  return (
    <article className={cn('rounded-3xl border bg-white p-4 shadow-card', health === 'loss' ? 'border-rose-300' : health === 'low' ? 'border-amber-300' : 'border-blue-100/70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-content-primary">{row.name}</h3>
          <p className="mt-0.5 text-xs text-content-secondary">{row.platform} · {row.category}</p>
        </div>
        <button type="button" onClick={onEdit} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-brand-light px-3.5 text-[13px] font-bold text-brand-text active:scale-95">
          <Pencil size={14} strokeWidth={1.75} /> Edit Margin
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-content-secondary">Best cost</dt><dd className="font-bold text-content-primary">{row.bestCost === null ? 'No offer' : usd(row.bestCost)}</dd></div>
        <div><dt className="text-xs text-content-secondary">Retail</dt><dd className="font-bold text-content-primary">{usd(row.customerRate)}</dd></div>
        <div>
          <dt className="text-xs text-content-secondary">Profit</dt>
          <dd className={cn('font-bold', health === 'loss' ? 'text-rose-600' : bad ? 'text-amber-600' : health === 'unknown' ? 'text-content-secondary' : 'text-emerald-600')}>
            {row.marginAbsolute === null || row.marginPercent === null ? '-' : `${row.marginAbsolute < 0 ? '-' : ''}${usd(Math.abs(row.marginAbsolute))} (${row.marginPercent.toFixed(1)}%)`}
          </dd>
        </div>
      </dl>
      {health === 'loss' && <p role="alert" className="mt-2 text-xs font-semibold text-rose-600">Selling below cost.</p>}
      {health === 'low' && <p role="alert" className="mt-2 text-xs font-semibold text-amber-600">Margin under {LOW_MARGIN_PERCENT}%.</p>}
    </article>
  )
}

function MarginModal({ row, onClose, onSave }: { row: PricingRow; onClose: () => void; onSave: (type: 'fixed' | 'percentage', value: number) => Promise<void> }) {
  const [type, setType] = useState<'fixed' | 'percentage'>('percentage')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const parsed = /^\d+(\.\d{1,2})?$/.test(draft.trim()) ? Number(draft) : null
  const valid = parsed !== null && parsed <= 100_000
  // Preview on the best current cost; the server reprices from the primary provider rate, so this is indicative.
  const preview = valid && row.bestCost !== null ? calculateCustomerRate(row.bestCost, [{ id: 'preview', type, value: parsed, priority: 0 }]) : null

  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit margin for ${row.name}`} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">{row.name}</h3>
        <div role="radiogroup" aria-label="Margin type" className="flex gap-2">
          {(['percentage', 'fixed'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)}
              className={cn('h-10 flex-1 rounded-2xl text-sm font-semibold', type === t ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
              {t === 'percentage' ? 'Percentage' : 'Fixed'}
            </button>
          ))}
        </div>
        <label className="block text-xs font-bold text-content-primary">
          {type === 'fixed' ? 'Markup (USD per 1,000)' : 'Markup (%)'}
          <input value={draft} inputMode="decimal" autoFocus onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={draft !== '' && !valid}
            className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', draft === '' || valid ? 'border-blue-100/70 focus:border-brand' : 'border-rose-300')} />
        </label>
        <p className="text-xs font-medium text-content-secondary">
          {preview !== null ? `On the current best cost (${usd(row.bestCost ?? 0)}) the price would be ${usd(preview)}.` : 'Enter a number from 0 to 100000 (up to 2 decimals).'}
        </p>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy}
            onClick={async () => {
              if (parsed === null || !valid) return
              setBusy(true); setErr(null)
              try { await onSave(type, parsed) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save.'); setBusy(false) }
            }}>
            <Check size={16} strokeWidth={2} /> Save
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
