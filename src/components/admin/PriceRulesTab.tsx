import { useState } from 'react'
import { AlertCircle, Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { formatRuleValue, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { listPriceRules, updatePriceRule } from '@/services/api/admin'
import { calculateCustomerRate } from '../../../supabase/functions/_shared/price-engine.ts'
import type { PriceRuleView } from '@/types/admin'

export function PriceRulesTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => listPriceRules(session), [session.token, session.isMock])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function save(rule: PriceRuleView, patch: { value?: number; isActive?: boolean }, okText: string): Promise<boolean> {
    setBusyId(rule.id)
    setMessage(null)
    try {
      await updatePriceRule(session, rule.id, patch)
      haptic.success()
      setMessage({ kind: 'ok', text: okText })
      await reload()
      return true
    } catch (e) {
      haptic.error()
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not save.' })
      return false
    } finally {
      setBusyId(null)
    }
  }

  if (!data && loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[110px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
        ))}
      </div>
    )
  }
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load price rules.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Rule changes reach customer prices the next time the catalog sync runs. The most specific active rule wins: service, then category, then platform, then global.
      </p>
      {message && (
        <p role={message.kind === 'ok' ? 'status' : 'alert'} className={cn('rounded-2xl px-3.5 py-2.5 text-[13px] font-medium', message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          {message.text}
        </p>
      )}
      {data.length === 0 && <Card className="p-4 text-sm text-content-secondary">No price rules yet.</Card>}
      {data.map((rule) => (
        <RuleCard key={rule.id} rule={rule} busy={busyId === rule.id} onSave={save} />
      ))}
    </div>
  )
}

function RuleCard({ rule, busy, onSave }: { rule: PriceRuleView; busy: boolean; onSave: (rule: PriceRuleView, patch: { value?: number; isActive?: boolean }, okText: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(rule.value))

  const parsed = /^\d+(\.\d{1,2})?$/.test(draft.trim()) ? Number(draft) : null
  const valid = parsed !== null && parsed >= 0 && parsed <= 100_000
  // What a $1.00 provider rate would sell for under this value (exact, same engine as the catalog sync).
  const preview = valid
    ? calculateCustomerRate(1, [{ id: 'preview', type: rule.type, value: parsed, priority: 0, min_rate: rule.type === 'tier' ? 0 : null }])
    : null

  return (
    <article className={cn('rounded-3xl border bg-white p-4 shadow-card', rule.isActive ? 'border-blue-100/70' : 'border-slate-200 opacity-80')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-content-primary">{rule.name}</h3>
          <p className="mt-0.5 text-xs text-content-secondary">{rule.scope} · {rule.type}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={rule.isActive}
          aria-label={`${rule.isActive ? 'Disable' : 'Enable'} ${rule.name}`}
          disabled={busy}
          onClick={() => { haptic.select(); void onSave(rule, { isActive: !rule.isActive }, `${rule.name} ${rule.isActive ? 'disabled' : 'enabled'}.`) }}
          className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', rule.isActive ? 'bg-brand' : 'bg-slate-300')}
        >
          <span className={cn('absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform', rule.isActive && 'translate-x-5')} />
        </button>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-bold text-content-primary">
            {rule.type === 'fixed' ? 'Markup (USD per 1,000)' : 'Markup (%)'}
            <input
              value={draft}
              inputMode="decimal"
              onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
              aria-invalid={!valid}
              className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', valid ? 'border-blue-100/70 focus:border-brand' : 'border-rose-300')}
            />
          </label>
          <p className="text-xs font-medium text-content-secondary">
            {preview !== null ? `A $1.00 provider rate would sell for ${usd(preview)}.` : 'Enter a number from 0 to 100000 (up to 2 decimals).'}
          </p>
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1 text-sm"
              disabled={!valid || busy}
              onClick={async () => { if (valid && (await onSave(rule, { value: parsed }, `${rule.name} updated to ${formatRuleValue(rule.type, parsed)}.`))) setEditing(false) }}
            >
              <Check size={16} strokeWidth={2} /> Save
            </Button>
            <button type="button" onClick={() => { setEditing(false); setDraft(String(rule.value)) }} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
              <X size={16} strokeWidth={2} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-end justify-between">
          <p className="text-2xl font-extrabold tracking-tight text-content-primary">{formatRuleValue(rule.type, rule.value)}</p>
          <button
            type="button"
            onClick={() => { haptic.tap(); setDraft(String(rule.value)); setEditing(true) }}
            className="flex h-9 items-center gap-1.5 rounded-full bg-brand-light px-3.5 text-[13px] font-bold text-brand-text active:scale-95"
          >
            <Pencil size={14} strokeWidth={1.75} /> Edit
          </button>
        </div>
      )}
    </article>
  )
}
