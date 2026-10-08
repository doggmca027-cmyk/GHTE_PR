import { useState } from 'react'
import { AlertCircle, CheckCheck, Inbox, Lock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Toast, type ToastMessage } from '@/components/ui/Toast'
import { StatusPill, TicketThread } from '@/components/support/TicketThread'
import { useLoader } from '@/hooks/useLoader'
import { haptic } from '@/lib/haptics'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { adminGetTicket, adminListTickets, adminReply, adminSetTicketStatus } from '@/services/api/admin-tickets'
import type { Ticket, TicketStatus } from '@/types/tickets'

type Filter = TicketStatus | 'all'

/** Support inbox: tickets waiting for a reply first (the one waiting longest on top), a chat view to read and answer, Resolve / Close. */
export function SupportTab({ session, onWaitingCount }: { session: AuthSession; onWaitingCount?: (n: number) => void }) {
  const [filter, setFilter] = useState<Filter>('open')
  const [openId, setOpenId] = useState<string | null>(null)
  const [thread, setThread] = useState<Ticket | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, error, loading, reload } = useLoader(async () => {
    const result = await adminListTickets(session, filter === 'all' ? null : filter)
    onWaitingCount?.(result.counts.open)
    return result
  }, [filter, session.token, session.isMock])

  async function open(id: string) {
    haptic.tap()
    try {
      setThread(await adminGetTicket(session, id))
      setOpenId(id)
    } catch (e) {
      setToast({ kind: 'error', text: e instanceof Error ? e.message : 'Could not open the ticket.' })
    }
  }

  async function setStatus(status: 'resolved' | 'closed') {
    if (!thread || busy) return
    setBusy(true)
    try {
      setThread(await adminSetTicketStatus(session, thread.id, status))
      haptic.success()
      setToast({ kind: 'ok', text: status === 'closed' ? 'Ticket closed.' : 'Ticket marked as resolved.' })
      void reload()
    } catch (e) {
      haptic.error()
      setToast({ kind: 'error', text: e instanceof Error ? e.message : 'Could not update the ticket.' })
    } finally {
      setBusy(false)
    }
  }

  if (openId && thread) {
    return (
      <>
        <TicketThread
          ticket={thread}
          viewer="admin"
          onBack={() => { setOpenId(null); setThread(null); void reload() }}
          onSend={async (text) => {
            setThread(await adminReply(session, thread.id, text))
            haptic.success()
            setToast({ kind: 'ok', text: 'Reply sent. The customer is notified on Telegram.' })
          }}
          actions={thread.status === 'closed' ? null : (
            <>
              {thread.status !== 'resolved' && (
                <button type="button" disabled={busy} onClick={() => void setStatus('resolved')} className="flex h-9 items-center gap-1.5 rounded-full bg-emerald-50 px-3.5 text-[13px] font-bold text-emerald-700 active:scale-95 disabled:opacity-50">
                  <CheckCheck size={14} strokeWidth={2} /> Resolve
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void setStatus('closed')} className="flex h-9 items-center gap-1.5 rounded-full bg-slate-100 px-3.5 text-[13px] font-bold text-slate-700 active:scale-95 disabled:opacity-50">
                <Lock size={14} strokeWidth={2} /> Close
              </button>
            </>
          )}
        />
        <Toast message={toast} onDismiss={() => setToast(null)} />
      </>
    )
  }

  const filters: { id: Filter; label: string; count?: number }[] = [
    { id: 'open', label: 'Needs reply', count: data?.counts.open },
    { id: 'answered', label: 'Answered', count: data?.counts.answered },
    { id: 'resolved', label: 'Resolved', count: data?.counts.resolved },
    { id: 'closed', label: 'Closed', count: data?.counts.closed },
    { id: 'all', label: 'All' },
  ]

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Ticket status" className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5 py-1">
        {filters.map(({ id, label, count }) => (
          <button key={id} role="tab" type="button" aria-selected={filter === id} onClick={() => { if (filter !== id) haptic.select(); setFilter(id) }}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-2xl px-3.5 py-2 text-[13px] font-semibold active:scale-95', filter === id ? 'bg-brand-light text-brand-text' : 'bg-white/70 text-content-secondary hover:bg-white')}>
            {label}
            {count ? <span className={cn('rounded-full px-1.5 text-[11px] font-bold', id === 'open' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600')}>{count}</span> : null}
          </button>
        ))}
      </div>

      {!data && loading && <div className="space-y-3" role="status" aria-label="Loading tickets">{[0, 1, 2].map((i) => <div key={i} className="h-[84px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}</div>}

      {!data && error && (
        <Card className="space-y-3 text-center" role="alert">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{error}</p>
          <Button className="w-full" onClick={() => void reload()}>Retry</Button>
        </Card>
      )}

      {data && data.tickets.length === 0 && (
        <Card className="space-y-2 py-10 text-center">
          <Inbox size={28} strokeWidth={1.5} className="mx-auto text-content-muted" />
          <p className="text-sm font-semibold text-content-primary">{filter === 'open' ? 'Nothing is waiting for a reply' : 'No tickets here'}</p>
        </Card>
      )}

      {data && data.tickets.length > 0 && <TicketQueue tickets={data.tickets} onOpen={(t) => void open(t.id)} />}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}

export function TicketQueue({ tickets, onOpen }: { tickets: Ticket[]; onOpen: (t: Ticket) => void }) {
  return (
    <ul className="space-y-2.5" aria-label="Tickets">
      {tickets.map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => onOpen(t)} className={cn('w-full rounded-3xl border bg-white p-4 text-left shadow-card active:scale-[0.99]', t.status === 'open' ? 'border-rose-200' : 'border-blue-100/70')}>
            <div className="flex items-start justify-between gap-2">
              <p className="line-clamp-2 break-words text-[15px] font-bold leading-snug text-content-primary">{t.subject}</p>
              <StatusPill status={t.status} viewer="admin" />
            </div>
            {t.lastMessage && <p className="mt-1 line-clamp-2 break-words text-[13px] text-content-secondary">{t.lastMessage}</p>}
            <p className="mt-1.5 text-xs text-content-muted">
              {t.user?.firstName ?? 'Customer'}{t.user?.username ? ` · @${t.user.username}` : ''}
              {t.order ? ` · order #${t.order.id.slice(0, 8)}` : ''} · {t.status === 'open' ? `waiting ${timeAgo(t.updatedAt).replace(/ ago$/, '')}` : `updated ${timeAgo(t.updatedAt)}`}
            </p>
          </button>
        </li>
      ))}
    </ul>
  )
}

