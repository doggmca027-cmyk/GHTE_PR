import { useState } from 'react'
import { CheckCircle2, Loader2, TriangleAlert, Wallet, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DEPOSIT_ISSUE, adminActionError, depositCaseFacts, isTxHash, tonToNano } from '@/lib/deposit-case'
import { timeAgoRu, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { formatOrderDate } from '@/lib/order-view'
import { shortId } from '@/lib/payment-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { resolveDeposit } from '@/services/api/admin'
import type { ReconCase } from '@/types/admin'
import { BanControl, userLabel } from './UsersTab'

const DEPOSIT_STATUS: Record<string, string> = { pending: 'Ожидает оплаты', completed: 'Зачислен', expired: 'Истёк', failed: 'Отменён' }

/**
 * A deposit case: credit it (admin_resolve_deposit 'credit': the transaction and what arrived, pro rata when short) or dismiss it
 * with a reason. The transaction and the amount are prefilled from what the verifier wrote in the case.
 */
export function DepositCaseCard({ kase, session, severityBorder, severityBadge, onDone }: {
  kase: ReconCase
  session: AuthSession
  severityBorder: string
  severityBadge: { label: string; className: string }
  onDone: (message: string) => void
}) {
  const d = kase.deposit!
  const facts = depositCaseFacts(kase.reason)
  const issue = DEPOSIT_ISSUE[facts.issue]
  const completed = d.status === 'completed'
  const [mode, setMode] = useState<'credit' | 'dismiss' | null>(null)
  const [txHash, setTxHash] = useState(facts.txHash ?? d.txHash ?? '')
  const [received, setReceived] = useState(facts.receivedTon !== null ? String(facts.receivedTon) : d.receivedNano ? String(d.receivedNano / 1e9) : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [banned, setBanned] = useState(d.userBanned)

  const nano = tonToNano(received)
  const hashOk = isTxHash(txHash)
  // what the credit would give: the quoted USD, pro rata when less than the quoted TON arrived
  const preview = nano !== null && d.amountCrypto > 0 ? Math.round(d.amountUsd * Math.min(nano / (d.amountCrypto * 1e9), 1) * 100) / 100 : null

  async function submit() {
    if (!mode) return
    setBusy(true); setError(null)
    try {
      const r = await resolveDeposit(session, kase.entityId, mode === 'credit'
        ? { action: 'credit', txHash: txHash.trim(), receivedNano: nano!, note: note.trim() || undefined }
        : { action: 'dismiss', note: note.trim() })
      haptic.success()
      onDone(r.action === 'dismiss' ? 'Кейс депозита закрыт.' : r.replayed ? 'Этот депозит уже был зачислен этой транзакцией.' : `Зачислено клиенту: ${usd(r.credited)}.`)
    } catch (e) {
      haptic.error()
      setError(adminActionError(e instanceof Error ? e.message : 'Действие не удалось.'))
      setBusy(false)
    }
  }

  return (
    <article className={cn('rounded-3xl border bg-surface p-4 shadow-card', severityBorder)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', severityBadge.className)}>{severityBadge.label}</span>
            <span className="text-[11px] font-semibold text-content-muted">возраст: {timeAgoRu(kase.createdAt).replace(/ назад$/, '')}</span>
          </div>
          <h3 className="flex items-center gap-1.5 text-[15px] font-bold leading-snug text-content-primary"><Wallet size={16} strokeWidth={1.75} className="text-brand" /> Депозит {usd(d.amountUsd)}</h3>
          <p className="mt-0.5 text-xs text-content-secondary">{userLabel(d)} · {formatOrderDate(d.createdAt)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-800">{DEPOSIT_STATUS[d.status] ?? d.status}</span>
      </div>

      <dl className="mt-2 space-y-1 rounded-2xl bg-surface-sub px-3 py-2 text-xs">
        <div className="flex justify-between gap-2"><dt className="text-content-secondary">Счёт</dt><dd className="font-semibold text-content-primary">{d.amountCrypto} {d.asset} ({d.network})</dd></div>
        {d.receivedNano !== null && <div className="flex justify-between gap-2"><dt className="text-content-secondary">Получено</dt><dd className="font-semibold text-content-primary">{d.receivedNano / 1e9} {d.asset}</dd></div>}
        {(d.txHash ?? facts.txHash) && <div className="flex justify-between gap-2"><dt className="text-content-secondary">Транзакция</dt><dd><code className="font-mono" title={d.txHash ?? facts.txHash ?? ''}>{shortId(d.txHash ?? facts.txHash ?? '')}</code></dd></div>}
        <div className="flex justify-between gap-2"><dt className="text-content-secondary">ID депозита</dt><dd><code className="font-mono" title={kase.entityId}>{shortId(kase.entityId)}</code></dd></div>
      </dl>

      <div className="mt-3 flex gap-2.5 rounded-2xl bg-amber-50 p-3 text-[13px] text-amber-900">
        <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          <p className="font-bold">{issue.title}</p>
          <p className="mt-0.5 font-medium text-amber-800">{issue.detail}</p>
          <p className="mt-1 break-all font-mono text-[11px] text-amber-700">{kase.reason}</p>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>}

      {mode === null ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={completed}
            title={completed ? 'Депозит уже зачислен' : undefined}
            onClick={() => { haptic.tap(); setMode('credit'); setError(null) }}
            className="flex min-h-11 items-center justify-center gap-1 rounded-2xl bg-emerald-600 px-1 text-[13px] font-bold leading-tight text-white active:scale-95 disabled:opacity-40"
          >
            <CheckCircle2 size={15} strokeWidth={2} /> Зачесть на баланс
          </button>
          <button
            type="button"
            onClick={() => { haptic.tap(); setMode('dismiss'); setError(null) }}
            className="flex min-h-11 items-center justify-center gap-1 rounded-2xl border border-slate-300 bg-surface px-1 text-[13px] font-bold leading-tight text-content-secondary active:scale-95"
          >
            <XCircle size={15} strokeWidth={1.75} /> Закрыть кейс
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2 rounded-2xl border border-blue-100/70 bg-surface-sub p-3">
          {mode === 'credit' && (
            <>
              <label className="block text-xs font-bold text-content-primary">
                Хэш транзакции TON
                <input value={txHash} onChange={(e) => setTxHash(e.target.value.trim())} spellCheck={false} placeholder="base64 или hex из обозревателя" aria-invalid={txHash !== '' && !hashOk}
                  className={cn('mt-1 w-full rounded-xl border bg-surface px-3 py-2.5 font-mono text-[12px] outline-none', txHash !== '' && !hashOk ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')} />
              </label>
              <label className="block text-xs font-bold text-content-primary">
                Сколько пришло, {d.asset}
                <input value={received} onChange={(e) => setReceived(e.target.value.replace(/[^\d.,]/g, ''))} inputMode="decimal" placeholder={String(d.amountCrypto)} aria-invalid={received !== '' && nano === null}
                  className={cn('mt-1 w-full rounded-xl border bg-surface px-3 py-2.5 text-sm font-medium outline-none', received !== '' && nano === null ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')} />
              </label>
              {preview !== null && <p className="text-xs font-semibold text-emerald-700">Клиенту будет зачислено {usd(preview)}{preview < d.amountUsd ? ' (пропорционально полученному)' : ''}.</p>}
            </>
          )}
          <label className="block text-xs font-bold text-content-primary">
            {mode === 'credit' ? 'Заметка (необязательно)' : 'Причина закрытия (обязательно)'}
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={mode === 'credit' ? 'Проверено в обозревателе' : 'Например: вернули переплату вручную'}
              className="mt-1 w-full rounded-xl border border-blue-100/70 bg-surface px-3 py-2.5 text-sm font-medium outline-none focus:border-brand" />
          </label>
          <div className="flex gap-2">
            <Button
              className={cn('h-11 flex-1 text-sm', mode === 'credit' && 'bg-emerald-600 hover:bg-emerald-600')}
              disabled={busy || (mode === 'credit' ? !hashOk || nano === null : note.trim() === '')}
              onClick={() => void submit()}
            >
              {busy && <Loader2 size={15} className="animate-spin" />} {mode === 'credit' ? 'Зачислить' : 'Закрыть кейс'}
            </Button>
            <button type="button" onClick={() => { setMode(null); setError(null) }} className="h-11 flex-1 rounded-2xl bg-surface text-sm font-semibold text-content-secondary active:scale-95">Отмена</button>
          </div>
        </div>
      )}

      {d.userId && (
        <div className="mt-3">
          <BanControl session={session} userId={d.userId} banned={banned} label={userLabel(d)} onChanged={setBanned} />
        </div>
      )}
    </article>
  )
}
