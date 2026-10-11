import { useState } from 'react'
import { Loader2, Zap } from 'lucide-react'
import { arbitrageView } from '@/lib/arbitrage-view'
import { usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { ArbitrageStatus, SetArbitrageModeResponse } from '@/types/admin-providers'

const SKIP_REASON = { inactive: 'не активен', no_api_key: 'нет API-ключа' } as const

/**
 * Smart Arbitrage in one switch: every donor network (catalog_mode 'linked_only') on or off at once; the primary network keeps
 * working either way. Each provider can still be switched on its own on its card below.
 */
export function ArbitrageCard({ status, onSwitch }: { status: ArbitrageStatus; onSwitch: (enabled: boolean) => Promise<SetArbitrageModeResponse> }) {
  const [busy, setBusy] = useState<boolean | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const v = arbitrageView(status)

  async function run(enabled: boolean) {
    haptic.select()
    setBusy(enabled); setNote(null)
    try {
      const r = await onSwitch(enabled)
      haptic.success()
      const unread = r.donors.filter((d) => d.routingEnabled && d.healthStatus === 'unavailable').map((d) => d.name)
      const skipped = r.skipped.map((s) => `${s.name} (${SKIP_REASON[s.reason] ?? s.reason})`)
      setNote({
        kind: 'ok',
        text: enabled
          ? ['Донорские сети включены. Заказы пойдут в самую дешёвую сеть, где хватает баланса; иначе — в основную.',
            unread.length ? `Панель не ответила, монитор перепроверит через минуту: ${unread.join(', ')}.` : '',
            skipped.length ? `Не включены: ${skipped.join(', ')}.` : ''].filter(Boolean).join(' ')
          : 'Донорские сети выключены: все заказы идут в основную сеть.',
      })
    } catch (e) {
      haptic.error()
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось переключить.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Режим Smart Arbitrage" className={cn('space-y-3 rounded-3xl border-2 bg-surface p-4 shadow-card', v.mode === 'off' ? 'border-blue-100' : 'border-emerald-300')}>
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', v.mode === 'off' ? 'bg-brand-light text-brand-text' : 'bg-emerald-50 text-emerald-700')}>
          <Zap size={16} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-content-primary">{v.title}</h3>
          <p role="status" className={cn('mt-0.5 text-[13px] font-semibold', v.mode === 'off' ? 'text-content-secondary' : 'text-emerald-700')}>{v.status}</p>
        </div>
      </div>

      {status.donors.length > 0 && (
        <ul className="space-y-1" aria-label="Донорские сети">
          {status.donors.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-sub px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate font-semibold text-content-primary">{d.name}</span>
              <span className="shrink-0 text-content-secondary">
                {usd(d.balance)} · офферов {d.activeOffers} ·{' '}
                <span className={cn('font-bold', d.ready ? 'text-emerald-700' : d.routingEnabled ? 'text-amber-700' : 'text-slate-500')}>
                  {d.ready ? 'готов' : d.routingEnabled ? 'не отвечает' : !d.hasApiKey ? 'нет ключа' : 'выключен'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        {v.enableLabel && (
          <button type="button" disabled={busy !== null} onClick={() => void run(true)} className="flex h-11 w-full items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 text-sm font-bold text-white active:scale-[0.98] disabled:opacity-50">
            {busy === true ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} strokeWidth={2} />} {v.enableLabel}
          </button>
        )}
        {v.disableLabel && (
          <button type="button" disabled={busy !== null} onClick={() => void run(false)} className="flex h-11 w-full items-center justify-center gap-1.5 rounded-2xl bg-surface-sub text-sm font-bold text-content-primary active:scale-[0.98] disabled:opacity-50">
            {busy === false && <Loader2 size={16} className="animate-spin" />} {v.disableLabel}
          </button>
        )}
      </div>
      <p className="text-[11px] text-content-secondary">
        Включение сразу запрашивает баланс у каждой донорской сети. Цены витрины не меняются: доноры дешевле основной сети, разница — ваша маржа. Каждого провайдера можно по-прежнему включать и выключать отдельно в его карточке.
      </p>
      {note && <p role={note.kind === 'error' ? 'alert' : 'status'} className={cn('rounded-xl px-3 py-2 text-xs font-semibold', note.kind === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')}>{note.text}</p>}
    </section>
  )
}
