import { useState } from 'react'
import { AlertCircle, Check, Landmark, Minus, Plus, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { parseAmount, signedUsd, timeAgoRu, treasuryTypeLabel, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { newIdempotencyKey } from '@/lib/idempotency'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { adjustTreasury, decideTopupProposal, getTreasury, setTreasuryReserve } from '@/services/api/admin'
import type { TopupProposal, TreasuryTx } from '@/types/admin'
import { PaymentsPanel } from './PaymentsPanel'

export function TreasuryTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => getTreasury(session), [session.token, session.isMock])
  const [more, setMore] = useState<TreasuryTx[]>([])
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined) // undefined: follow the first page
  const [loadingMore, setLoadingMore] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [editingReserve, setEditingReserve] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busyProposal, setBusyProposal] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  if (!data && loading) return <div className="h-[180px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Не удалось загрузить данные казны.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
      </Card>
    )
  }

  const cursor = nextBefore === undefined ? data.nextBefore : nextBefore
  const rows = [...data.transactions, ...more.filter((m) => !data.transactions.some((t) => t.id === m.id))]

  async function decide(p: TopupProposal, decision: 'approve' | 'reject') {
    setBusyProposal(p.id)
    setMessage(null)
    setErrorMessage(null)
    try {
      await decideTopupProposal(session, p.id, decision)
      haptic.success()
      setMessage(decision === 'approve'
        ? `Одобрено: ${usd(p.amount)} списано для ${p.providerName}. Отправьте перевод из раздела «Платежи провайдерам» и запишите его хеш.`
        : `Пополнение для ${p.providerName} отклонено.`)
      setMore([])
      setNextBefore(undefined)
    } catch (e) {
      haptic.error()
      setErrorMessage(e instanceof Error ? e.message : 'Не удалось сохранить.')
    } finally {
      setBusyProposal(null)
      setConfirming(null)
      await reload() // always re-read: another admin may have decided it already
    }
  }

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
        <p className="flex items-center gap-1.5 text-xs font-semibold text-content-secondary"><Landmark size={14} strokeWidth={1.75} /> Баланс казны</p>
        <p className="text-4xl font-extrabold tracking-tight text-content-primary">{usd(data.balance)}</p>
        <p className="text-xs text-content-secondary">Обновлено {timeAgoRu(data.updatedAt)} · отдельно от кошельков клиентов и балансов провайдеров</p>
        <div className="mt-2 flex items-center justify-between gap-3 rounded-2xl bg-surface-sub px-3.5 py-2.5">
          <div className="min-w-0 text-xs">
            <p className="flex items-center gap-1 font-bold text-content-primary"><ShieldCheck size={13} strokeWidth={1.75} /> Минимальный резерв {usd(data.minimumReserve)}</p>
            <p className="mt-0.5 text-content-secondary">{usd(Math.max(0, data.balance - data.minimumReserve))} доступно для пополнения провайдеров</p>
          </div>
          <button type="button" onClick={() => { haptic.tap(); setMessage(null); setEditingReserve(true) }}
            className="h-9 shrink-0 rounded-full bg-white px-3.5 text-[13px] font-bold text-brand-text shadow-sm active:scale-95">
            Изменить резерв
          </button>
        </div>
        <Button className="mt-3 h-11 w-full text-sm" onClick={() => { haptic.tap(); setMessage(null); setAdjusting(true) }}>Ручная корректировка</Button>
      </Card>

      {message && <p role="status" className="rounded-2xl bg-emerald-50 px-3.5 py-2.5 text-[13px] font-medium text-emerald-700">{message}</p>}

      {errorMessage && <p role="alert" className="rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[13px] font-medium text-rose-700">{errorMessage}</p>}

      {data.proposals.length > 0 && (
        <section aria-label="Ожидающие пополнения" className="space-y-2">
          <h2 className="px-1 text-sm font-bold text-content-primary">Ожидающие пополнения</h2>
          {data.proposals.map((p) => {
            const short = p.amount > data.balance
            const belowReserve = !short && data.balance - p.amount < data.minimumReserve
            const busy = busyProposal === p.id
            return (
              <article key={p.id} className="rounded-2xl border border-amber-300 bg-white px-3.5 py-3 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-content-primary">{p.providerName}</p>
                    <p className="mt-0.5 text-xs text-content-secondary">Предложено {timeAgoRu(p.createdAt)}</p>
                  </div>
                  <p className="shrink-0 text-[15px] font-extrabold text-content-primary">{usd(p.amount)} {p.currency}</p>
                </div>
                {short && <p role="alert" className="mt-1 text-xs font-semibold text-amber-600">В казне только {usd(data.balance)}. Сначала пополните её.</p>}
                {belowReserve && <p role="alert" className="mt-1 text-xs font-semibold text-amber-600">Одобрение опустит казну ниже минимального резерва {usd(data.minimumReserve)}.</p>}
                <div className="mt-2 flex gap-2">
                  <Button className="h-10 flex-1 text-[13px]" disabled={busy || short || belowReserve} onClick={() => { if (confirming === p.id) void decide(p, 'approve'); else { haptic.tap(); setConfirming(p.id) } }}>
                    <Check size={15} strokeWidth={2} /> {confirming === p.id ? `Подтвердить ${usd(p.amount)}` : 'Одобрить'}
                  </Button>
                  <button type="button" disabled={busy} onClick={() => void decide(p, 'reject')} className="flex h-10 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-[13px] font-semibold text-content-secondary active:scale-95 disabled:opacity-50">
                    <X size={15} strokeWidth={2} /> Отклонить
                  </button>
                </div>
              </article>
            )
          })}
        </section>
      )}

      <PaymentsPanel
        session={session}
        payments={data.payments}
        onChanged={async (text) => {
          setErrorMessage(null)
          if (text) setMessage(text)
          setMore([])
          setNextBefore(undefined)
          await reload() // a failure or cancel books a reversal in the ledger
        }}
      />

      <h2 className="px-1 text-sm font-bold text-content-primary">Журнал операций</h2>
      {rows.length === 0 && <Card className="p-4 text-sm text-content-secondary">Операций казны пока нет.</Card>}
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
            <p className="mt-1 text-[11px] text-content-secondary">{timeAgoRu(t.createdAt)} · баланс после: {usd(t.balanceAfter)}</p>
          </li>
        ))}
      </ul>
      {cursor !== null && (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="h-11 w-full rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95 disabled:opacity-50">
          {loadingMore ? 'Загрузка…' : 'Показать более ранние'}
        </button>
      )}

      {editingReserve && (
        <ReserveModal
          current={data.minimumReserve}
          balance={data.balance}
          onClose={() => setEditingReserve(false)}
          onSubmit={async (minimum) => {
            try {
              await setTreasuryReserve(session, minimum)
            } catch (e) {
              haptic.error()
              throw e
            }
            haptic.success()
            setMessage(`Минимальный резерв казны: ${usd(minimum)}.`)
            setEditingReserve(false)
            await reload()
          }}
        />
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
            setMessage(`Казна: ${input.amount < 0 ? 'списано' : 'зачислено'} ${usd(Math.abs(input.amount))}.`)
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

/** platform_settings.minimum_treasury_reserve: provider payments that would take the balance below it are refused. */
export function ReserveModal({ current, balance, onClose, onSubmit }: { current: number; balance: number; onClose: () => void; onSubmit: (minimum: number) => Promise<void> }) {
  const [amount, setAmount] = useState(String(current))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const value = parseAmount(amount)
  const valid = value !== null && value < 1_000_000_000

  return (
    <div role="dialog" aria-modal="true" aria-label="Минимальный резерв казны" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">Минимальный резерв казны</h3>
        <p className="text-xs text-content-secondary">
          Пополнения провайдеров, после которых в казне останется меньше этой суммы, сервер отклонит (проверка под блокировкой,
          поэтому одновременные одобрения не проскочат). 0 отключает резерв.
        </p>
        <label className="block text-xs font-bold text-content-primary">
          Резерв (USD)
          <input value={amount} inputMode="decimal" autoFocus onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={!valid}
            className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', valid ? 'border-blue-100/70 focus:border-brand' : 'border-rose-300')} />
        </label>
        {valid && value > balance && <p role="status" className="text-xs font-semibold text-amber-600">Больше текущего баланса ({usd(balance)}): все пополнения будут отклоняться, пока казна не пополнена.</p>}
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy || value === current}
            onClick={async () => {
              if (value === null) return
              setBusy(true); setErr(null)
              try { await onSubmit(value) } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось сохранить.'); setBusy(false) }
            }}>
            <Check size={16} strokeWidth={2} /> Сохранить
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Отмена
          </button>
        </div>
      </div>
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
    <div role="dialog" aria-modal="true" aria-label="Ручная корректировка казны" className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">Ручная корректировка</h3>
        <div role="radiogroup" aria-label="Направление" className="flex gap-2">
          {([['add', 'Добавить', Plus], ['remove', 'Списать', Minus]] as const).map(([d, label, Icon]) => (
            <button key={d} type="button" role="radio" aria-checked={direction === d} onClick={() => setDirection(d)}
              className={cn('flex h-10 flex-1 items-center justify-center gap-1 rounded-2xl text-sm font-semibold', direction === d ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
              <Icon size={14} strokeWidth={2} /> {label}
            </button>
          ))}
        </div>
        <label className="block text-xs font-bold text-content-primary">
          Сумма (USD)
          <input value={amount} inputMode="decimal" autoFocus onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={amount !== '' && signed === null}
            className={cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', amount === '' || signed !== null ? 'border-blue-100/70 focus:border-brand' : 'border-rose-300')} />
        </label>
        {tooMuch && <p role="alert" className="text-xs font-semibold text-rose-600">Доступно только {usd(balance)}.</p>}
        <label className="block text-xs font-bold text-content-primary">
          Причина (сохранится в журнале)
          <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="например: первое пополнение казны"
            className="mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand" />
        </label>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy}
            onClick={async () => {
              if (signed === null) return
              setBusy(true); setErr(null)
              try { await onSubmit({ amount: signed, description: reason, idempotencyKey: key }) } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось сохранить.'); setBusy(false) }
            }}>
            <Check size={16} strokeWidth={2} /> Подтвердить
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Отмена
          </button>
        </div>
      </div>
    </div>
  )
}
