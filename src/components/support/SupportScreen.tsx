import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, LifeBuoy, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Toast, type ToastMessage } from '@/components/ui/Toast'
import { useT } from '@/i18n'
import { tm } from '@/i18n/messages'
import { haptic } from '@/lib/haptics'
import { timeAgo } from '@/lib/time'
import type { AuthSession } from '@/services/api/auth'
import { addTicketMessage, createTicket, getTicket, listMyTickets } from '@/services/api/tickets'
import type { Ticket } from '@/types/tickets'
import { NewTicketModal } from './NewTicketModal'
import { StatusPill, TicketThread } from './TicketThread'

export interface SupportRequest {
  /** Open the "new ticket" form about this order. */
  orderId: string
}

interface Props {
  session: AuthSession
  request: SupportRequest | null
  onRequestHandled: () => void
}

type ListState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; tickets: Ticket[] }

/** The customer's support: their tickets (active first, then past), a conversation view, and the new-ticket form. */
export function SupportScreen({ session, request, onRequestHandled }: Props) {
  const t = useT()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [open, setOpen] = useState<Ticket | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ orderId: string | null } | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)

  const load = useCallback(() => {
    setList((s) => (s.status === 'ready' ? s : { status: 'loading' }))
    listMyTickets(session).then(
      (tickets) => setList({ status: 'ready', tickets }),
      () => setList({ status: 'error' }),
    )
  }, [session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load])

  // "Report an issue" on an order card opens the form with that order selected.
  useEffect(() => {
    if (request) {
      setCreating({ orderId: request.orderId })
      onRequestHandled()
    }
  }, [request, onRequestHandled])

  async function openTicket(id: string) {
    haptic.tap()
    setThreadError(null)
    try {
      setOpen(await getTicket(session, id))
    } catch (e) {
      setToast({ kind: 'error', text: e instanceof Error ? tm(e.message) : t('Could not open the ticket.') })
    }
  }

  if (open) {
    return (
      <>
        <TicketThread
          ticket={open}
          viewer="customer"
          onBack={() => { setOpen(null); load() }}
          onSend={async (text) => {
            const updated = await addTicketMessage(session, open.id, text)
            haptic.success()
            setOpen(updated)
          }}
        />
        {threadError && <p role="alert" className="mt-2 text-xs text-rose-600">{threadError}</p>}
        <Toast message={toast} onDismiss={() => setToast(null)} />
      </>
    )
  }

  const tickets = list.status === 'ready' ? list.tickets : []
  const active = tickets.filter((x) => x.status === 'open' || x.status === 'answered')
  const past = tickets.filter((x) => x.status === 'resolved' || x.status === 'closed')

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-2xl font-extrabold tracking-tight text-content-primary">{t('Support')}</h1>
        <button type="button" onClick={() => { haptic.tap(); setCreating({ orderId: null }) }} className="flex h-10 items-center gap-1.5 rounded-full bg-brand px-4 text-sm font-bold text-white shadow-sm active:scale-95">
          <Plus size={16} strokeWidth={2} /> {t('New ticket')}
        </button>
      </div>

      {list.status === 'loading' && <div className="space-y-3" role="status" aria-label={t('Loading tickets')}>{[0, 1].map((i) => <div key={i} className="h-[88px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}</div>}

      {list.status === 'error' && (
        <Card className="space-y-3 text-center">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{t("Couldn't load your tickets. Check your connection and retry.")}</p>
          <Button className="w-full" onClick={load}>{t('Retry')}</Button>
        </Card>
      )}

      {list.status === 'ready' && tickets.length === 0 && (
        <Card className="space-y-3 py-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-light text-brand"><LifeBuoy size={26} strokeWidth={1.75} /></span>
          <p className="text-base font-bold text-content-primary">{t('No tickets yet')}</p>
          <p className="mx-auto max-w-[260px] text-sm text-content-secondary">{t('Something wrong with an order? Open a ticket and we will look into it. You can also start one from the Orders tab.')}</p>
        </Card>
      )}

      {active.length > 0 && <TicketGroup title={t('Active')} tickets={active} onOpen={(t) => void openTicket(t.id)} />}
      {past.length > 0 && <TicketGroup title={t('Past')} tickets={past} onOpen={(t) => void openTicket(t.id)} />}

      {creating && (
        <NewTicketModal
          session={session}
          orderId={creating.orderId}
          onClose={() => setCreating(null)}
          onCreate={async (input) => {
            const ticket = await createTicket(session, input)
            haptic.success()
            setCreating(null)
            setToast({ kind: 'ok', text: t('Ticket sent. We will reply here and on Telegram.') })
            setOpen(ticket)
            load()
          }}
        />
      )}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  )
}

export function TicketGroup({ title, tickets, onOpen }: { title: string; tickets: Ticket[]; onOpen: (ticket: Ticket) => void }) {
  const t = useT()
  return (
    <section className="mt-4" aria-label={title}>
      <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-content-muted">{title}</h2>
      <ul className="space-y-2.5">
        {tickets.map((tk) => (
          <li key={tk.id}>
            <button type="button" onClick={() => onOpen(tk)} className="w-full rounded-3xl border border-blue-100/70 bg-white p-4 text-left shadow-card active:scale-[0.99]">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 break-words text-[15px] font-bold leading-snug text-content-primary">{tk.subject}</p>
                <StatusPill status={tk.status} />
              </div>
              {tk.lastMessage && <p className="mt-1 line-clamp-2 break-words text-[13px] text-content-secondary">{tk.lastFromSupport ? `${t('Support')}: ` : ''}{tk.lastMessage}</p>}
              <p className="mt-1.5 text-xs text-content-muted">
                {tk.order ? `${t('Order #{id}', { id: tk.order.id.slice(0, 8) })} · ` : ''}{t('updated {time}', { time: timeAgo(tk.updatedAt) })}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
