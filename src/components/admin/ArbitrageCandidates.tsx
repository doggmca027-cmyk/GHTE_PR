import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Search, X } from 'lucide-react'
import { usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { decideArbitrageCandidate, listArbitrageCandidates, runArbitrageMatch } from '@/services/api/admin-providers'
import type { AuthSession } from '@/services/api/auth'
import type { ArbitrageCandidate, ArbitrageCandidatesPage, CandidateMismatch, CandidateStatus } from '@/types/admin-providers'

const TABS: { status: CandidateStatus; label: string }[] = [
  { status: 'pending', label: 'На проверку' },
  { status: 'auto_linked', label: 'Подключены сами' },
  { status: 'approved', label: 'Одобрены' },
  { status: 'rejected', label: 'Отклонены' },
]

export const MISMATCH_LABEL: Record<CandidateMismatch, string> = {
  details: 'Отличаются признаки (качество, гео, аудитория)',
  refill: 'Другая или не указана гарантия',
  limits: 'Лимиты не покрывают наши',
}

const pct = (share: number) => `−${Math.round(share * 100)}%`

/**
 * Smart Arbitrage autopilot: the database links a cheaper donor service by itself only when it is the same service in every respect
 * (name, details, stated guarantee, limits) and at least 25% cheaper. Everything it is not sure about waits here for a decision.
 */
export function ArbitrageCandidates({ session }: { session: AuthSession }) {
  const [tab, setTab] = useState<CandidateStatus>('pending')
  const [page, setPage] = useState<ArbitrageCandidatesPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async (status: CandidateStatus, offset = 0) => {
    setLoading(true)
    try {
      const next = await listArbitrageCandidates(session, status, offset)
      setPage((prev) => (offset > 0 && prev ? { ...next, items: [...prev.items, ...next.items] } : next))
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось загрузить список.' })
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => { void load(tab) }, [load, tab])

  async function decide(c: ArbitrageCandidate, approve: boolean) {
    haptic.select()
    setBusy(c.id); setNote(null)
    try {
      await decideArbitrageCandidate(session, c.id, approve)
      haptic.success()
      setPage((p) => (p ? { ...p, items: p.items.filter((x) => x.id !== c.id) } : p))
      setNote({ kind: 'ok', text: approve ? `Подключено: ${c.donor.provider} обслуживает «${c.service.name}».` : 'Отклонено: эта пара больше не предлагается.' })
    } catch (e) {
      haptic.error()
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось сохранить решение.' })
    } finally {
      setBusy(null)
    }
  }

  async function runNow() {
    haptic.select()
    setBusy('run'); setNote(null)
    try {
      const r = await runArbitrageMatch(session)
      haptic.success()
      setNote({ kind: 'ok', text: `Подбор выполнен: подключено автоматически ${r.auto_linked ?? 0}, на проверке ${r.pending ?? 0}.` })
      await load(tab)
    } catch (e) {
      haptic.error()
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Подбор не выполнен.' })
    } finally {
      setBusy(null)
    }
  }

  const counts = page?.counts ?? {}
  const shown = page?.items ?? []
  const total = counts[tab] ?? 0

  return (
    <section aria-label="Автоподбор дешёвых услуг" className="space-y-3 rounded-3xl border border-blue-100 bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-content-primary">Автоподбор дешёвых услуг</h3>
          <p className="mt-0.5 text-[12px] text-content-secondary">
            Сам подключает только полное совпадение (название, признаки, гарантия, лимиты) и выгоду от 25%. Всё, в чём есть сомнение, — здесь.
            {page?.refreshedAt && ` Последний подбор: ${new Date(page.refreshedAt).toLocaleString('ru-RU')}.`}
          </p>
        </div>
        <button type="button" onClick={() => void runNow()} disabled={busy !== null} className="flex h-9 shrink-0 items-center gap-1 rounded-xl bg-brand-light px-3 text-xs font-bold text-brand-text active:scale-95 disabled:opacity-50">
          {busy === 'run' ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} strokeWidth={2} />} Найти
        </button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="tablist">
        {TABS.map((t) => (
          <button key={t.status} type="button" role="tab" aria-selected={tab === t.status} onClick={() => { haptic.select(); setNote(null); setPage(null); setTab(t.status) }}
            className={cn('shrink-0 rounded-full px-3 py-1.5 text-xs font-bold', tab === t.status ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
            {t.label}{counts[t.status] ? ` · ${counts[t.status]}` : ''}
          </button>
        ))}
      </div>

      {note && <p role={note.kind === 'error' ? 'alert' : 'status'} className={cn('rounded-xl px-3 py-2 text-xs font-semibold', note.kind === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')}>{note.text}</p>}

      {loading && !page ? (
        <p className="flex items-center gap-2 text-xs text-content-secondary"><Loader2 size={14} className="animate-spin" /> Загрузка…</p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl bg-surface-sub px-3 py-2.5 text-xs text-content-secondary">Пусто.</p>
      ) : (
        <ul className="space-y-2" data-testid="arbitrage-candidates">
          {shown.map((c) => (
            <li key={c.id} className="space-y-1.5 rounded-2xl bg-surface-sub p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 font-bold leading-snug text-content-primary">{c.service.name}</p>
                <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700">{pct(c.saving)}</span>
              </div>
              <p className="leading-snug text-content-secondary">
                <span className="font-semibold text-content-primary">{c.donor.provider} #{c.donor.externalId}:</span> {c.donor.name}
              </p>
              <p className="text-content-secondary">
                Себестоимость {usd(c.currentCost)} → <span className="font-bold text-content-primary">{usd(c.donorCost)}</span> за 1000 ·
                лимиты у нас {c.service.min.toLocaleString('ru-RU')}–{c.service.max.toLocaleString('ru-RU')}, у донора {c.donor.min.toLocaleString('ru-RU')}–{c.donor.max.toLocaleString('ru-RU')}
              </p>
              {c.mismatches.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                  {c.mismatches.map((m) => <li key={m} className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800">{MISMATCH_LABEL[m] ?? m}</li>)}
                </ul>
              )}
              {c.status !== 'rejected' && (
                <div className="flex gap-2 pt-0.5">
                  {c.status === 'pending' && (
                    <button type="button" disabled={busy !== null} onClick={() => void decide(c, true)} className="flex h-9 flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-600 font-bold text-white active:scale-[0.98] disabled:opacity-50">
                      {busy === c.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} strokeWidth={2.5} />} Подключить
                    </button>
                  )}
                  <button type="button" disabled={busy !== null} onClick={() => void decide(c, false)} className="flex h-9 flex-1 items-center justify-center gap-1 rounded-xl bg-surface font-bold text-content-primary active:scale-[0.98] disabled:opacity-50">
                    <X size={14} strokeWidth={2.5} /> {c.status === 'pending' ? 'Отклонить' : 'Отключить'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {shown.length < total && (
        <button type="button" disabled={loading} onClick={() => void load(tab, shown.length)} className="h-10 w-full rounded-2xl bg-surface-sub text-xs font-bold text-content-primary disabled:opacity-50">
          {loading ? 'Загрузка…' : `Показать ещё (${total - shown.length})`}
        </button>
      )}
    </section>
  )
}
