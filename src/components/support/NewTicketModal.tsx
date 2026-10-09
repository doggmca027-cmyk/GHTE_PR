import { useEffect, useState } from 'react'
import { Loader2, Send, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
import { tm } from '@/i18n/messages'
import { MESSAGE_MAX, SUBJECT_MAX, checkMessage, checkSubject, defaultSubjectFor, orderOptionLabel } from '@/lib/ticket-view'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getOrders } from '@/services/api/orders'
import type { IOrderView } from '@/types/orders'

interface Props {
  session: AuthSession
  /** The order the "Report an issue" button was pressed on: preselected, and its service names the default subject. */
  orderId?: string | null
  onClose: () => void
  /** Creates the ticket; rejects with an Error whose message is shown in the form. */
  onCreate: (input: { subject: string; message: string; orderId: string | null }) => Promise<void>
}

const field = (invalid: boolean) =>
  cn('mt-1.5 w-full rounded-2xl border bg-surface-sub px-4 py-3 text-[15px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:bg-white disabled:opacity-60', invalid ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')

/** New ticket form: subject, message and (optionally) the order it is about. */
export function NewTicketModal({ session, orderId = null, onClose, onCreate }: Props) {
  const t = useT()
  const [orders, setOrders] = useState<IOrderView[]>([])
  const [selected, setSelected] = useState<string>(orderId ?? '')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The customer's own orders for the picker. A failure only means the picker stays short: a ticket needs no order.
  useEffect(() => {
    let alive = true
    getOrders(session).then((rows) => { if (alive) setOrders(rows.slice(0, 30)) }, () => {})
    return () => { alive = false }
  }, [session])

  // Pre-fill the subject once the order is known (only if the customer has not typed one).
  const preselected = orders.find((o) => o.id === orderId) ?? null
  useEffect(() => {
    if (preselected) setSubject((s) => (s === '' ? defaultSubjectFor(preselected) : s))
  }, [preselected])

  const subjectError = touched ? checkSubject(subject) : null
  const messageError = touched ? checkMessage(message) : null

  async function submit() {
    setTouched(true)
    if (checkSubject(subject) || checkMessage(message)) return
    setBusy(true)
    setError(null)
    try {
      await onCreate({ subject: subject.trim(), message: message.trim(), orderId: selected || null })
    } catch (e) {
      setError(e instanceof Error ? tm(e.message) : t('Could not create the ticket. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={t('New support ticket')} className="absolute inset-0 z-50 flex items-end animate-fade-in">
      <button type="button" aria-label={t('Close')} onClick={() => !busy && onClose()} className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <form
        onSubmit={(e) => { e.preventDefault(); void submit() }}
        className="relative z-10 max-h-[92%] w-full animate-sheet-up overflow-y-auto rounded-t-[32px] bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_40px_rgb(0,136,204,0.14)]"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-blue-100" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-content-primary">{t('Report an issue')}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t('Close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sub text-content-secondary active:scale-90 disabled:opacity-40">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <label className="block text-sm font-bold text-content-primary">
          {t('Order')} <span className="text-xs font-medium text-content-muted">{t('(optional)')}</span>
          <select value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)} className={field(false)} aria-label={t('Order')}>
            <option value="">{t('Not about a specific order')}</option>
            {orderId && !orders.some((o) => o.id === orderId) && <option value={orderId}>{t('Order #{id}', { id: orderId.slice(0, 8) })}</option>}
            {orders.map((o) => <option key={o.id} value={o.id}>{orderOptionLabel(o)}</option>)}
          </select>
        </label>

        <label className="mt-4 block text-sm font-bold text-content-primary">
          {t('Subject')}
          <input value={subject} maxLength={SUBJECT_MAX} disabled={busy} onChange={(e) => setSubject(e.target.value)} placeholder={t('What went wrong?')} aria-invalid={Boolean(subjectError)} className={field(Boolean(subjectError))} />
          {subjectError && <span role="alert" className="mt-1 block text-xs font-medium text-rose-500">{subjectError}</span>}
        </label>

        <label className="mt-4 block text-sm font-bold text-content-primary">
          {t('Message')}
          <textarea value={message} maxLength={MESSAGE_MAX} rows={5} disabled={busy} onChange={(e) => setMessage(e.target.value)} placeholder={t('Tell us what happened. The more detail, the faster we can help.')} aria-invalid={Boolean(messageError)} className={cn(field(Boolean(messageError)), 'resize-none')} />
          {messageError && <span role="alert" className="mt-1 block text-xs font-medium text-rose-500">{messageError}</span>}
        </label>

        {error && (
          <div role="alert" className="mt-4 flex gap-2.5 rounded-2xl bg-rose-50 p-3.5 text-[13px] font-medium text-rose-700">
            <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" /> <p>{error}</p>
          </div>
        )}

        <Button type="submit" className="mt-5 h-14 w-full text-[15px]" disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 size={18} strokeWidth={2} className="animate-spin" /> : <Send size={16} strokeWidth={2} />} {busy ? t('Sending…') : t('Send to support')}
        </Button>
      </form>
    </div>
  )
}
