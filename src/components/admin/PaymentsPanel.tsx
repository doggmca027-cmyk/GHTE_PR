import { useEffect, useRef, useState } from 'react'
import { Ban, Check, ChevronDown, Copy, FastForward, Radio, Send, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { timeAgoRu, usd } from '@/lib/admin-view'
import { copyText } from '@/lib/clipboard'
import { haptic } from '@/lib/haptics'
import { ADVANCE_STEP, PAYMENT_STATUS, describePaymentIssue, isPaymentOpen, nextPaymentStep, paymentOps, shortId, type PaymentTone } from '@/lib/payment-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { runPaymentAction } from '@/services/api/admin'
import type { PaymentAdvanceTarget, ProviderPayment, ProviderPaymentAction } from '@/types/admin'

const TONE: Record<PaymentTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  progress: 'bg-blue-50 text-blue-700',
  action: 'bg-amber-100 text-amber-800',
  ok: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-rose-50 text-rose-700',
}

type Dialog = { kind: 'broadcast' | 'fail' | 'cancel'; payment: ProviderPayment }

/**
 * Provider payments in Admin -> Treasury. Every button is one guarded transition on the server (admin-treasury ->
 * the SQL state machine); the buttons shown are only the valid ones for each state.
 */
export function PaymentsPanel({ session, payments, onChanged }: { session: AuthSession; payments: ProviderPayment[]; onChanged: (message: string | null) => Promise<void> }) {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const [showDone, setShowDone] = useState(false)
  const open = payments.filter((p) => isPaymentOpen(p.status))
  const done = payments.filter((p) => !isPaymentOpen(p.status))

  async function act(action: ProviderPaymentAction, message: string): Promise<void> {
    await runPaymentAction(session, action)
    haptic.success()
    await onChanged(message)
  }

  async function quick(p: ProviderPayment, action: ProviderPaymentAction, message: string) {
    setBusyId(p.id)
    setError(null)
    try {
      await act(action, message)
    } catch (e) {
      haptic.error()
      setError({ id: p.id, text: e instanceof Error ? e.message : 'Действие не удалось.' })
      await onChanged(null) // someone else may have moved it: show the current state
    } finally {
      setBusyId(null)
    }
  }

  if (payments.length === 0) return null
  return (
    <section aria-label="Платежи провайдерам" className="space-y-2">
      <h2 className="px-1 text-sm font-bold text-content-primary">Платежи провайдерам</h2>
      {open.length === 0 && <p className="px-1 text-xs text-content-secondary">Сейчас ничего не идёт.</p>}
      {open.map((p) => (
        <PaymentCard
          key={p.id}
          payment={p}
          busy={busyId === p.id}
          error={error?.id === p.id ? error.text : null}
          onAdvance={(to) => void quick(p, { action: 'ADVANCE_PAYMENT', paymentId: p.id, to }, `${p.providerName}: шаг «${ADVANCE_STEP[to].label}» записан.`)}
          onCreateInstruction={() => void quick(p, { action: 'CREATE_INSTRUCTION', paymentId: p.id }, `${p.providerName}: инструкция по переводу создана.`)}
          onDialog={(kind) => { haptic.tap(); setError(null); setDialog({ kind, payment: p }) }}
        />
      ))}

      {done.length > 0 && (
        <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}
          className="flex w-full items-center justify-between rounded-2xl bg-surface-sub px-3.5 py-2.5 text-[13px] font-semibold text-content-secondary active:scale-[0.99]">
          Завершённые платежи ({done.length})
          <ChevronDown size={16} strokeWidth={2} className={cn('transition-transform', showDone && 'rotate-180')} />
        </button>
      )}
      {showDone && done.map((p) => <PaymentCard key={p.id} payment={p} busy={false} error={null} onAdvance={() => {}} onCreateInstruction={() => {}} onDialog={() => {}} />)}

      {dialog?.kind === 'broadcast' && (
        <RecordBroadcastModal
          payment={dialog.payment}
          onClose={() => setDialog(null)}
          onSubmit={async (txHash, markConfirming) => {
            await act({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: dialog.payment.id, txHash, markConfirming },
              `${dialog.payment.providerName}: перевод записан${markConfirming ? ', ждёт подтверждений' : ''}.`)
            setDialog(null)
          }}
        />
      )}
      {(dialog?.kind === 'fail' || dialog?.kind === 'cancel') && (
        <ReasonModal
          payment={dialog.payment}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const kind = dialog.kind
            await act({ action: kind === 'fail' ? 'FAIL_PAYMENT' : 'CANCEL_PAYMENT', paymentId: dialog.payment.id, reason },
              `${dialog.payment.providerName}: платёж ${kind === 'fail' ? 'отмечен неудачным' : 'отменён'}, ${usd(dialog.payment.amount)} возвращено в казну.`)
            setDialog(null)
          }}
        />
      )}
    </section>
  )
}

export function PaymentCard({ payment: p, busy, error, onAdvance, onCreateInstruction, onDialog }: {
  payment: ProviderPayment
  busy: boolean
  error: string | null
  onAdvance: (to: PaymentAdvanceTarget) => void
  onCreateInstruction: () => void
  onDialog: (kind: Dialog['kind']) => void
}) {
  const [confirming, setConfirming] = useState<'advance' | 'instruction' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const status = PAYMENT_STATUS[p.status] ?? { label: p.status, tone: 'neutral' as const }
  const ops = paymentOps(p)
  const next = nextPaymentStep(p)
  const issue = p.issue

  function ask(which: 'advance' | 'instruction') {
    haptic.tap()
    setConfirming(which)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setConfirming(null), 6000) // an accidental tap expires on its own
  }

  return (
    <article className={cn('rounded-2xl border bg-white px-3.5 py-3 shadow-card', issue ? 'border-amber-300' : 'border-blue-100/70')} aria-label={`Платёж провайдеру ${p.providerName}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-content-primary">{p.providerName}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-content-secondary">
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', TONE[status.tone])}>{status.label}</span>
            <span>{timeAgoRu(p.createdAt)}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[15px] font-extrabold text-content-primary">{usd(p.amount)}</p>
          <p className="text-[11px] font-semibold text-content-secondary">{p.asset} · {p.network}</p>
        </div>
      </div>

      {p.status === 'PAYMENT_CREATED' ? (
        <div className="mt-2 space-y-1 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900">
          <p className="font-bold">Отправьте {p.asset} на {usd(p.amount)} в сети {p.network} на адрес:</p>
          <CopyValue value={p.destinationWallet} label="адрес получателя" full />
          <p className="font-medium text-amber-800">Затем запишите хеш транзакции. Адрес задан в настройках выплат провайдера.</p>
        </div>
      ) : (
        <dl className="mt-2 space-y-1 text-xs">
          <div className="flex items-center justify-between gap-2"><dt className="text-content-secondary">Кому</dt><dd><CopyValue value={p.destinationWallet} label="адрес получателя" /></dd></div>
          {p.txHash && <div className="flex items-center justify-between gap-2"><dt className="text-content-secondary">Транзакция</dt><dd><CopyValue value={p.txHash} label="хеш транзакции" /></dd></div>}
        </dl>
      )}

      {issue && (
        <div role="alert" className="mt-2 flex gap-2 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900">
          <TriangleAlert size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-bold">{describePaymentIssue(issue.reason).title}{p.openCaseId ? ' · открыт кейс сверки' : ''}</p>
            <p className="mt-0.5 font-medium text-amber-800">{describePaymentIssue(issue.reason).detail}</p>
          </div>
        </div>
      )}
      {p.failureReason && !issue && <p className="mt-2 break-words text-xs text-content-secondary">{p.status === 'FAILED' || p.status === 'CANCELED' ? 'Причина: ' : 'Заметка: '}{p.failureReason}{p.treasuryReversed ? ' · сумма возвращена в казну' : ''}</p>}

      {error && <p role="alert" className="mt-2 rounded-xl bg-rose-50 px-2.5 py-2 text-xs font-medium text-rose-700">{error}</p>}

      {ops.length > 0 && (
        <div className="mt-2.5 flex gap-2">
          {ops.includes('create_instruction') && (
            <Button className="h-10 flex-1 text-[13px]" disabled={busy} onClick={() => (confirming === 'instruction' ? (setConfirming(null), onCreateInstruction()) : ask('instruction'))}>
              <Send size={15} strokeWidth={2} /> {confirming === 'instruction' ? 'Подтвердить' : 'Создать инструкцию'}
            </Button>
          )}
          {ops.includes('record_broadcast') && (
            <Button className="h-10 flex-1 text-[13px]" disabled={busy} onClick={() => onDialog('broadcast')}>
              <Radio size={15} strokeWidth={2} /> Записать отправку
            </Button>
          )}
          {ops.includes('advance') && next && (
            <Button className="h-10 flex-1 text-[13px]" disabled={busy} onClick={() => (confirming === 'advance' ? (setConfirming(null), onAdvance(next)) : ask('advance'))}>
              <FastForward size={15} strokeWidth={2} /> {confirming === 'advance' ? `Подтвердить: ${ADVANCE_STEP[next].label}` : ADVANCE_STEP[next].label}
            </Button>
          )}
          {ops.includes('fail') && (
            <button type="button" disabled={busy} onClick={() => onDialog('fail')} className="flex h-10 flex-1 items-center justify-center gap-1 rounded-2xl border border-rose-200 bg-white text-[13px] font-bold text-rose-600 active:scale-95 disabled:opacity-50">
              <X size={15} strokeWidth={2} /> Неудачен
            </button>
          )}
          {ops.includes('cancel') && (
            <button type="button" disabled={busy} onClick={() => onDialog('cancel')} className="flex h-10 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-[13px] font-semibold text-content-secondary active:scale-95 disabled:opacity-50">
              <Ban size={15} strokeWidth={2} /> Отменить
            </button>
          )}
        </div>
      )}
      {confirming === 'advance' && next && <p className="mt-1.5 text-[12px] font-medium text-brand-text">{ADVANCE_STEP[next].assert}</p>}
      {confirming === 'instruction' && <p className="mt-1.5 text-[12px] font-medium text-brand-text">Фиксирует инструкцию по переводу (адрес, сумму, сеть), чтобы её можно было отправить.</p>}
    </article>
  )
}

function CopyValue({ value, label, full = false }: { value: string; label: string; full?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className={cn('flex items-center gap-1.5', full && 'justify-between')}>
      <code className={cn('font-mono text-[11px] text-content-primary', full ? 'break-all' : 'whitespace-nowrap')} title={value}>{full ? value : shortId(value)}</code>
      <button type="button" aria-label={`Скопировать: ${label}`} onClick={async () => { if (await copyText(value)) { haptic.success(); setCopied(true); setTimeout(() => setCopied(false), 1500) } }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/80 text-content-secondary active:scale-90">
        {copied ? <Check size={13} strokeWidth={2.25} className="text-emerald-600" /> : <Copy size={13} strokeWidth={1.75} />}
      </button>
    </span>
  )
}

const TX_HASH = /^\S{1,200}$/

/** PAYMENT_CREATED (or a reconciliation that found the transfer) -> BROADCASTED, optionally CONFIRMING. */
export function RecordBroadcastModal({ payment, onClose, onSubmit }: { payment: ProviderPayment; onClose: () => void; onSubmit: (txHash: string, markConfirming: boolean) => Promise<void> }) {
  const [hash, setHash] = useState(payment.txHash ?? '')
  const [confirmingToo, setConfirmingToo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const value = hash.trim()
  const valid = TX_HASH.test(value)

  return (
    <div role="dialog" aria-modal="true" aria-label="Запись отправки" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">Запись отправки · {payment.providerName}</h3>
        <p className="text-xs text-content-secondary">
          {payment.asset} на {usd(payment.amount)} в сети {payment.network} на <code className="font-mono">{shortId(payment.destinationWallet)}</code>.
          Вставьте хеш отправленной транзакции. Потом его нельзя изменить, и он может относиться только к одному платежу.
        </p>
        <label className="block text-xs font-bold text-content-primary">
          Хеш транзакции
          <input value={hash} autoFocus spellCheck={false} autoComplete="off" onChange={(e) => setHash(e.target.value)} aria-invalid={hash !== '' && !valid}
            className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 font-mono text-[13px] outline-none', hash === '' || valid ? 'border-blue-100/70 focus:border-brand' : 'border-rose-300')} />
        </label>
        {hash !== '' && !valid && <p role="alert" className="text-xs font-semibold text-rose-600">Одно значение без пробелов, не длиннее 200 символов.</p>}
        <label className="flex items-start gap-2.5 rounded-2xl bg-surface-sub px-3.5 py-3 text-[13px] font-medium text-content-primary">
          <input type="checkbox" checked={confirmingToo} onChange={(e) => setConfirmingToo(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-brand,#2563eb)]" />
          Она уже видна в обозревателе: сразу отметить как «Подтверждается»
        </label>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy}
            onClick={async () => {
              setBusy(true); setErr(null)
              try { await onSubmit(value, confirmingToo) } catch (e) { haptic.error(); setErr(e instanceof Error ? e.message : 'Не удалось сохранить.'); setBusy(false) }
            }}>
            <Check size={16} strokeWidth={2} /> Записать
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}

/** FAILED / CANCELED: the amount goes back to the treasury (once). A reason is kept on the payment. */
export function ReasonModal({ payment, kind, onClose, onSubmit }: { payment: ProviderPayment; kind: 'fail' | 'cancel'; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const text = reason.trim()
  const valid = text.length >= 3 && text.length <= 300
  const title = kind === 'fail' ? 'Отметить платёж неудачным' : 'Отменить платёж'

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">{title} · {payment.providerName}</h3>
        {kind === 'cancel' ? (
          <p className="text-xs text-content-secondary">По этому платежу ничего не отправлено. Отмена вернёт {usd(payment.amount)} в казну.</p>
        ) : (
          <p className="text-xs text-content-secondary">
            Только если перевод точно не дошёл до кошелька провайдера (отклонён, не отправлялся, провалился в сети).
            {' '}{usd(payment.amount)} вернётся в казну. Если не уверены, оставьте как есть: центр сверки следит за платежом.
          </p>
        )}
        {kind === 'fail' && payment.confirmedAt && (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            Этот платёж подтверждён в сети {timeAgoRu(payment.confirmedAt)}: деньги ушли. Отмечайте его неудачным, только если подтверждение записали по ошибке.
          </p>
        )}
        <label className="block text-xs font-bold text-content-primary">
          Причина (сохранится в платеже)
          <input value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} placeholder={kind === 'fail' ? 'например: транзакция провалилась в сети' : 'например: предложена неверная сумма'}
            className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand" />
        </label>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <button type="button" disabled={!valid || busy}
            onClick={async () => {
              setBusy(true); setErr(null)
              try { await onSubmit(text) } catch (e) { haptic.error(); setErr(e instanceof Error ? e.message : 'Не удалось сохранить.'); setBusy(false) }
            }}
            className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-rose-600 text-sm font-bold text-white active:scale-95 disabled:opacity-50">
            <Check size={16} strokeWidth={2} /> {kind === 'fail' ? `Неудачен, вернуть ${usd(payment.amount)}` : `Отменить, вернуть ${usd(payment.amount)}`}
          </button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
