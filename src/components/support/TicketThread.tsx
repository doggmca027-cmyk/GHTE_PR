import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Loader2, Lock, Send, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { MESSAGE_MAX, canReply, checkMessage, statusMeta, type Viewer } from '@/lib/ticket-view'
import { formatMoneyAmount } from '@/lib/order-calc'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { Ticket } from '@/types/tickets'

export function StatusPill({ status, viewer = 'customer' }: { status: Ticket['status']; viewer?: Viewer }) {
  const meta = statusMeta(status, viewer)
  return <span className={cn('inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold', meta.className)}>{meta.label}</span>
}

interface Props {
  ticket: Ticket
  viewer: Viewer
  /** Sends a message; rejects with an Error whose message is shown under the box. */
  onSend: (text: string) => Promise<void>
  onBack?: () => void
  /** Extra controls in the header (the admin's Resolve / Close). */
  actions?: ReactNode
}

/** The conversation: header, the order it is about, the messages as chat bubbles, and the reply box. Used by customers and admins. */
export function TicketThread({ ticket, viewer, onSend, onBack, actions }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const messages = ticket.messages ?? []
  const open = canReply(ticket.status)

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length])

  async function send() {
    const problem = checkMessage(text)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSend(text.trim())
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={`Ticket: ${ticket.subject}`} className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to tickets" className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-blue-100/70 bg-white text-content-secondary shadow-sm active:scale-90">
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-[17px] font-extrabold leading-snug text-content-primary">{ticket.subject}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill status={ticket.status} viewer={viewer} />
            <span className="text-xs text-content-muted">updated {timeAgo(ticket.updatedAt)}</span>
            {viewer === 'admin' && ticket.user && (
              <span className="text-xs font-medium text-content-secondary">{ticket.user.firstName ?? 'Customer'}{ticket.user.username ? ` · @${ticket.user.username}` : ''}</span>
            )}
          </div>
        </div>
      </div>

      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}

      {ticket.order && (
        <p className="rounded-2xl bg-surface-sub px-3.5 py-2.5 text-xs font-medium text-content-secondary">
          About order <span className="font-bold text-content-primary">#{ticket.order.id.slice(0, 8)}</span>
          {ticket.order.serviceName ? ` · ${ticket.order.serviceName}` : ''} · {ticket.order.quantity.toLocaleString('en-US')} · {formatMoneyAmount(ticket.order.chargeAmount)} · {ticket.order.status}
        </p>
      )}

      <ol className="flex flex-col gap-2" aria-label="Messages">
        {messages.map((m) => {
          const mine = viewer === 'admin' ? m.isAdmin : !m.isAdmin
          return (
            <li key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
              <div className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2.5 text-sm', mine ? 'rounded-br-lg bg-brand text-white' : 'rounded-bl-lg border border-blue-100/70 bg-white text-content-primary')}>
                {m.text}
              </div>
              <span className="mt-0.5 px-2 text-[11px] text-content-muted">{m.isAdmin ? 'Support' : viewer === 'admin' ? 'Customer' : 'You'} · {timeAgo(m.createdAt)}</span>
            </li>
          )
        })}
        <div ref={endRef} />
      </ol>

      {open ? (
        <div>
          <label className="sr-only" htmlFor="ticket-reply">Your message</label>
          <textarea
            id="ticket-reply"
            value={text}
            maxLength={MESSAGE_MAX}
            rows={3}
            disabled={busy}
            placeholder={viewer === 'admin' ? 'Reply to the customer…' : 'Write a message…'}
            onChange={(e) => { setText(e.target.value); if (error) setError(null) }}
            aria-invalid={Boolean(error)}
            className={cn('w-full resize-none rounded-2xl border bg-white px-4 py-3 text-[15px] outline-none transition-colors placeholder:text-content-muted focus:border-brand disabled:opacity-60', error ? 'border-rose-300' : 'border-blue-100/70')}
          />
          {error && (
            <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-rose-600"><TriangleAlert size={14} strokeWidth={1.75} /> {error}</p>
          )}
          <Button className="mt-2 h-12 w-full text-[15px]" disabled={busy || text.trim() === ''} aria-busy={busy} onClick={() => void send()}>
            {busy ? <Loader2 size={18} strokeWidth={2} className="animate-spin" /> : <Send size={16} strokeWidth={2} />} {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-2 rounded-2xl bg-slate-100 px-4 py-3 text-sm font-medium text-content-secondary">
          <Lock size={16} strokeWidth={1.75} /> This ticket is closed. Open a new one if you still need help.
        </p>
      )}
    </section>
  )
}
