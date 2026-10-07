import { useState } from 'react'
import { AlertCircle, Check, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { balanceState, parseAmount, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { checkPayoutDraft, payoutChanged, shortId, type PayoutDraft } from '@/lib/payment-view'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { listProviderConfigs, setProviderPayout, updateProviderConfig } from '@/services/api/admin'
import type { ProviderConfigPatch, ProviderConfigView, ProviderHealth, ProviderPayoutInput } from '@/types/admin'

const HEALTH_BADGE: Record<ProviderHealth, { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'bg-emerald-50 text-emerald-700' },
  degraded: { label: 'Degraded', className: 'bg-amber-100 text-amber-700' },
  unavailable: { label: 'Unavailable', className: 'bg-rose-50 text-rose-700' },
  disabled: { label: 'Disabled', className: 'bg-slate-100 text-slate-600' },
}

/** What the modal saves: each part is null when unchanged. */
export interface ProviderConfigChanges {
  config: ProviderConfigPatch | null
  payout: ProviderPayoutInput | null
}

export function ProvidersTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => listProviderConfigs(session), [session.token, session.isMock])
  const [editing, setEditing] = useState<ProviderConfigView | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function toggleRouting(p: ProviderConfigView) {
    haptic.select()
    setBusyId(p.id)
    setMessage(null)
    try {
      await updateProviderConfig(session, p.id, { routingEnabled: !p.routingEnabled })
      haptic.success()
      setMessage({ kind: 'ok', text: `${p.name}: routing ${p.routingEnabled ? 'disabled' : 'enabled'}.` })
      await reload()
    } catch (e) {
      haptic.error()
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
              <div>
                <dt className="text-xs text-content-secondary">Reliability penalty</dt>
                <dd className={cn('font-bold', p.reliabilityPenalty > 1 ? 'text-amber-600' : 'text-content-primary')}>x{p.reliabilityPenalty}</dd>
              </div>
            </dl>
            {state === 'low' && <p role="alert" className="mt-2 text-xs font-semibold text-amber-600">Balance is at or below the threshold. Top up to about {usd(p.targetTopupBalance)}.</p>}
            <PayoutSummary provider={p} />
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
          onSave={async ({ config, payout }) => {
            try {
              // payout first: it is the part the server is most likely to refuse (address checksum, limits)
              if (payout) await setProviderPayout(session, editing.id, payout)
              if (config) await updateProviderConfig(session, editing.id, config)
            } catch (e) {
              haptic.error()
              await reload() // the payout part may have been saved already
              throw e
            }
            haptic.success()
            setMessage({ kind: 'ok', text: `${editing.name}: configuration saved.` })
            await reload()
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/** One line on the card: where top-ups go and under which limits, or why they are refused. */
export function PayoutSummary({ provider: p }: { provider: ProviderConfigView }) {
  if (!p.payoutWallet || p.maxTopupPerTx === null || p.maxDailyTopup === null) {
    return (
      <p role="status" className="mt-2 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
        Payouts not configured: top-ups to this provider are refused until a wallet and both limits are set.
      </p>
    )
  }
  return (
    <div className="mt-2 rounded-2xl bg-surface-sub px-3 py-2 text-xs">
      <p className="font-semibold text-content-primary">
        Payouts: {p.payoutAsset} · {p.payoutNetwork} → <code className="font-mono" title={p.payoutWallet}>{shortId(p.payoutWallet)}</code>
      </p>
      <p className="mt-0.5 text-content-secondary">
        {usd(p.maxTopupPerTx)} per top-up · {usd(p.maxDailyTopup)} per day · {usd(p.topupUsedToday)} used today
      </p>
    </div>
  )
}

const draftOf = (p: ProviderConfigView): PayoutDraft => ({
  wallet: p.payoutWallet ?? '',
  network: p.payoutNetwork,
  asset: p.payoutAsset,
  maxPerTx: p.maxTopupPerTx === null ? '' : String(p.maxTopupPerTx),
  maxDaily: p.maxDailyTopup === null ? '' : String(p.maxDailyTopup),
})

export function ConfigModal({ provider, onClose, onSave }: { provider: ProviderConfigView; onClose: () => void; onSave: (changes: ProviderConfigChanges) => Promise<void> }) {
  const [low, setLow] = useState(String(provider.lowBalanceThreshold))
  const [target, setTarget] = useState(String(provider.targetTopupBalance))
  const [routing, setRouting] = useState(provider.routingEnabled)
  const [penalty, setPenalty] = useState(String(provider.reliabilityPenalty))
  const [draft, setDraft] = useState<PayoutDraft>(() => draftOf(provider))
  const [walletConfirmed, setWalletConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const lowN = parseAmount(low)
  const targetN = parseAmount(target)
  const orderOk = lowN !== null && targetN !== null && targetN >= lowN
  const penaltyN = /^\d{1,2}(\.\d{1,3})?$/.test(penalty.trim()) ? Number(penalty) : null
  const penaltyOk = penaltyN !== null && penaltyN >= 1 && penaltyN <= 10
  const routingOk = routing === provider.routingEnabled || provider.isActive

  const payout = checkPayoutDraft(draft)
  const saved: ProviderPayoutInput = { wallet: provider.payoutWallet, network: provider.payoutNetwork, asset: provider.payoutAsset, maxTopupPerTx: provider.maxTopupPerTx, maxDailyTopup: provider.maxDailyTopup }
  const payoutDirty = payout.input !== null && payoutChanged(saved, payout.input)
  const newWallet = payout.input?.wallet ?? null
  const walletChanged = payout.input !== null && newWallet !== null && newWallet !== provider.payoutWallet

  const configPatch: ProviderConfigPatch | null = lowN === null || targetN === null ? null : {
    ...(lowN !== provider.lowBalanceThreshold ? { lowBalanceThreshold: lowN } : {}),
    ...(targetN !== provider.targetTopupBalance ? { targetTopupBalance: targetN } : {}),
    ...(penaltyN !== null && penaltyN !== provider.reliabilityPenalty ? { reliabilityPenalty: penaltyN } : {}),
    ...(routing !== provider.routingEnabled ? { routingEnabled: routing } : {}),
  }
  const configDirty = configPatch !== null && Object.keys(configPatch).length > 0
  const valid = orderOk && penaltyOk && routingOk && payout.input !== null && (configDirty || payoutDirty)
  const set = (patch: Partial<PayoutDraft>) => { setDraft((d) => ({ ...d, ...patch })); setWalletConfirmed(false) }

  async function save() {
    if (walletChanged && !walletConfirmed) {
      haptic.tap()
      setWalletConfirmed(true) // first tap only shows the warning below
      return
    }
    setBusy(true); setErr(null)
    try {
      await onSave({ config: configDirty ? configPatch : null, payout: payoutDirty ? payout.input : null })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.')
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit configuration of ${provider.name}`} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="max-h-[92vh] w-full max-w-md space-y-3 overflow-y-auto rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">{provider.name}</h3>
        <AmountField label="Low-balance threshold (alert at or below)" value={low} onChange={setLow} invalid={lowN === null} />
        <AmountField label="Target top-up balance" value={target} onChange={setTarget} invalid={targetN === null} />
        {lowN !== null && targetN !== null && targetN < lowN && <p role="alert" className="text-xs font-semibold text-rose-600">The top-up target cannot be below the threshold.</p>}
        <AmountField label="Reliability penalty (1 = reliable, up to 10)" value={penalty} onChange={setPenalty} invalid={!penaltyOk} />
        <p className="-mt-1 text-xs text-content-secondary">Routing compares cost x penalty: at x1.5 this provider must be a third cheaper to win. Prices charged are not affected.</p>
        <label className="flex items-center justify-between gap-3 rounded-2xl bg-surface-sub px-3.5 py-3 text-sm font-semibold text-content-primary">
          Routing enabled
          <input type="checkbox" checked={routing} disabled={!provider.isActive && !provider.routingEnabled} onChange={(e) => setRouting(e.target.checked)} className="h-5 w-5 accent-[var(--color-brand,#2563eb)]" />
        </label>

        <fieldset className="space-y-2.5 rounded-2xl border border-blue-100/70 p-3">
          <legend className="px-1 text-xs font-bold text-content-primary">Payouts (treasury top-ups to this provider)</legend>
          <label className="block text-xs font-bold text-content-primary">
            Allowed destination wallet (TON)
            <input value={draft.wallet} spellCheck={false} autoComplete="off" onChange={(e) => set({ wallet: e.target.value })} placeholder="UQ… or 0:…" aria-invalid={Boolean(payout.errors.wallet)}
              className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 font-mono text-[13px] outline-none', payout.errors.wallet ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')} />
          </label>
          {payout.errors.wallet && <p role="alert" className="text-xs font-semibold text-rose-600">{payout.errors.wallet}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Segmented label="Network" value={draft.network} options={['mainnet', 'testnet'] as const} onChange={(network) => set({ network })} />
            <Segmented label="Asset" value={draft.asset} options={['TON', 'USDT'] as const} onChange={(asset) => set({ asset })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <AmountField label="Max per top-up (USD)" value={draft.maxPerTx} onChange={(maxPerTx) => set({ maxPerTx })} invalid={Boolean(payout.errors.maxPerTx)} />
            <AmountField label="Max per day (USD)" value={draft.maxDaily} onChange={(maxDaily) => set({ maxDaily })} invalid={Boolean(payout.errors.maxDaily)} />
          </div>
          {(payout.errors.maxPerTx || payout.errors.maxDaily) && <p role="alert" className="text-xs font-semibold text-rose-600">{payout.errors.maxPerTx ?? payout.errors.maxDaily}</p>}
          <p className="text-xs text-content-secondary">
            {payout.incomplete
              ? 'Until a wallet and both limits are set, every top-up to this provider is refused.'
              : `Used today: ${usd(provider.topupUsedToday)}. The server enforces both limits and the treasury reserve under a lock; the app can never pick another destination.`}
          </p>
          {walletConfirmed && walletChanged && (
            <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              Every future top-up of {provider.name} goes to <span className="break-all font-mono">{newWallet}</span>. Check it character by character with the provider: a transfer to a wrong address cannot be undone. Tap Save again to confirm.
            </p>
          )}
        </fieldset>

        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy} onClick={() => void save()}>
            <Check size={16} strokeWidth={2} /> {walletChanged && !walletConfirmed ? 'Save (new wallet)' : walletChanged ? 'Confirm new wallet' : 'Save'}
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="text-xs font-bold text-content-primary">
      {label}
      <div role="radiogroup" aria-label={label} className="mt-1 flex gap-1 rounded-xl bg-surface-sub p-1">
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}
            className={cn('h-8 flex-1 rounded-lg text-[12px] font-semibold', value === o ? 'bg-white text-content-primary shadow-sm' : 'text-content-secondary')}>
            {o}
          </button>
        ))}
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
