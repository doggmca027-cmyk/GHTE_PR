import { useState } from 'react'
import { AlertCircle, Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { balanceState, parseAmount, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { listProviderConfigs, updateProviderConfig } from '@/services/api/admin'
import type { ProviderConfigPatch, ProviderConfigView, ProviderHealth } from '@/types/admin'

const HEALTH_BADGE: Record<ProviderHealth, { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'bg-emerald-50 text-emerald-700' },
  degraded: { label: 'Degraded', className: 'bg-amber-100 text-amber-700' },
  unavailable: { label: 'Unavailable', className: 'bg-rose-50 text-rose-700' },
  disabled: { label: 'Disabled', className: 'bg-slate-100 text-slate-600' },
}

export function ProvidersTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => listProviderConfigs(session), [session.token, session.isMock])
  const [editing, setEditing] = useState<ProviderConfigView | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function save(p: ProviderConfigView, patch: ProviderConfigPatch, okText: string): Promise<void> {
    try {
      await updateProviderConfig(session, p.id, patch)
    } catch (e) {
      haptic.error()
      throw e
    }
    haptic.success()
    setMessage({ kind: 'ok', text: okText })
    await reload()
  }

  async function toggleRouting(p: ProviderConfigView) {
    haptic.select()
    setBusyId(p.id)
    setMessage(null)
    try {
      await save(p, { routingEnabled: !p.routingEnabled }, `${p.name}: routing ${p.routingEnabled ? 'disabled' : 'enabled'}.`)
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not save.' })
    } finally {
      setBusyId(null)
    }
  }

  if (!data && loading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => <div key={i} className="h-[140px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}
      </div>
    )
  }
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load providers.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Health and balance are refreshed every minute for providers with routing on. You get one Telegram alert when a balance reaches its threshold.
      </p>
      {message && (
        <p role="status" className={cn('rounded-2xl px-3.5 py-2.5 text-[13px] font-medium', message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          {message.text}
        </p>
      )}
      {data.length === 0 && <Card className="p-4 text-sm text-content-secondary">No providers yet.</Card>}
      {data.map((p) => {
        const state = balanceState(p.balance, p.lowBalanceThreshold, p.lastBalanceSync)
        return (
          <article key={p.id} className={cn('rounded-3xl border bg-white p-4 shadow-card', state === 'low' ? 'border-amber-300' : 'border-blue-100/70')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[15px] font-bold leading-snug text-content-primary">{p.name}</h3>
                <span className={cn('mt-1 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold', HEALTH_BADGE[p.health].className)}>{HEALTH_BADGE[p.health].label}</span>
                {!p.isActive && <span className="ml-1.5 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">Inactive</span>}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={p.routingEnabled}
                aria-label={`${p.routingEnabled ? 'Disable' : 'Enable'} routing for ${p.name}`}
                disabled={busyId === p.id || (!p.isActive && !p.routingEnabled)}
                onClick={() => void toggleRouting(p)}
                className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', p.routingEnabled ? 'bg-brand' : 'bg-slate-300')}
              >
                <span className={cn('absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform', p.routingEnabled && 'translate-x-5')} />
              </button>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-content-secondary">Balance</dt>
                <dd className={cn('font-bold', state === 'low' ? 'text-amber-600' : 'text-content-primary')}>
                  {state === 'unknown' ? 'Not read yet' : `${usd(p.balance)} ${p.currency}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-content-secondary">Low-balance threshold</dt>
                <dd className="font-bold text-content-primary">{usd(p.lowBalanceThreshold)}</dd>
              </div>
            </dl>
            {state === 'low' && <p role="alert" className="mt-2 text-xs font-semibold text-amber-600">Balance is at or below the threshold. Top up to about {usd(p.targetTopupBalance)}.</p>}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-content-secondary">{p.lastHealthCheck ? `Checked ${timeAgo(p.lastHealthCheck)}` : 'Never checked'}</p>
              <button type="button" onClick={() => { haptic.tap(); setMessage(null); setEditing(p) }} className="flex h-9 items-center gap-1.5 rounded-full bg-brand-light px-3.5 text-[13px] font-bold text-brand-text active:scale-95">
                <Pencil size={14} strokeWidth={1.75} /> Edit Config
              </button>
            </div>
          </article>
        )
      })}

      {editing && (
        <ConfigModal
          provider={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await save(editing, patch, `${editing.name}: configuration saved.`)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function ConfigModal({ provider, onClose, onSave }: { provider: ProviderConfigView; onClose: () => void; onSave: (patch: ProviderConfigPatch) => Promise<void> }) {
  const [low, setLow] = useState(String(provider.lowBalanceThreshold))
  const [target, setTarget] = useState(String(provider.targetTopupBalance))
  const [routing, setRouting] = useState(provider.routingEnabled)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const lowN = parseAmount(low)
  const targetN = parseAmount(target)
  const orderOk = lowN !== null && targetN !== null && targetN >= lowN
  const valid = orderOk && (routing === provider.routingEnabled || provider.isActive)

  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit configuration of ${provider.name}`} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">{provider.name}</h3>
        <AmountField label="Low-balance threshold (alert at or below)" value={low} onChange={setLow} invalid={lowN === null} />
        <AmountField label="Target top-up balance" value={target} onChange={setTarget} invalid={targetN === null} />
        {lowN !== null && targetN !== null && targetN < lowN && <p role="alert" className="text-xs font-semibold text-rose-600">The top-up target cannot be below the threshold.</p>}
        <label className="flex items-center justify-between gap-3 rounded-2xl bg-surface-sub px-3.5 py-3 text-sm font-semibold text-content-primary">
          Routing enabled
          <input type="checkbox" checked={routing} disabled={!provider.isActive && !provider.routingEnabled} onChange={(e) => setRouting(e.target.checked)} className="h-5 w-5 accent-[var(--color-brand,#2563eb)]" />
        </label>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy}
            onClick={async () => {
              if (lowN === null || targetN === null) return
              setBusy(true); setErr(null)
              try {
                await onSave({ lowBalanceThreshold: lowN, targetTopupBalance: targetN, ...(routing !== provider.routingEnabled ? { routingEnabled: routing } : {}) })
              } catch (e) {
                setErr(e instanceof Error ? e.message : 'Could not save.')
                setBusy(false)
              }
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

function AmountField({ label, value, onChange, invalid }: { label: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <label className="block text-xs font-bold text-content-primary">
      {label}
      <input value={value} inputMode="decimal" onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={invalid}
        className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', invalid ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')} />
    </label>
  )
}
