// Display and validation rules for support tickets. Pure: no React, no I/O.
import type { IOrderView } from '@/types/orders'
import type { TicketStatus } from '@/types/tickets'

export const SUBJECT_MIN = 3
export const SUBJECT_MAX = 120
export const MESSAGE_MAX = 4000

export type Viewer = 'customer' | 'admin'

export interface StatusMeta {
  label: string
  /** Tailwind classes of the pill. */
  className: string
}

const CUSTOMER: Record<TicketStatus, StatusMeta> = {
  open: { label: 'Waiting for support', className: 'bg-amber-50 text-amber-700' },
  answered: { label: 'Support replied', className: 'bg-emerald-50 text-emerald-700' },
  resolved: { label: 'Resolved', className: 'bg-brand-light text-brand-text' },
  closed: { label: 'Closed', className: 'bg-slate-100 text-slate-600' },
}
const ADMIN: Record<TicketStatus, StatusMeta> = {
  ...CUSTOMER,
  open: { label: 'Needs reply', className: 'bg-rose-50 text-rose-700' },
  answered: { label: 'Answered', className: 'bg-emerald-50 text-emerald-700' },
}

export const statusMeta = (status: TicketStatus, viewer: Viewer = 'customer'): StatusMeta => (viewer === 'admin' ? ADMIN : CUSTOMER)[status]

/** A closed ticket takes no more messages; every other status does (a customer reply reopens an answered / resolved one). */
export const canReply = (status: TicketStatus): boolean => status !== 'closed'

export function checkSubject(raw: string): string | null {
  const t = raw.trim()
  if (t.length < SUBJECT_MIN) return `Describe the problem in at least ${SUBJECT_MIN} characters.`
  if (t.length > SUBJECT_MAX) return `Keep the subject under ${SUBJECT_MAX} characters.`
  return null
}

export function checkMessage(raw: string): string | null {
  const t = raw.trim()
  if (t.length === 0) return 'Write a message.'
  if (t.length > MESSAGE_MAX) return `Keep the message under ${MESSAGE_MAX.toLocaleString('en-US')} characters.`
  return null
}

/** "Telegram Views · 1,000 · 05-09" - how an order is named in the picker. */
export function orderOptionLabel(o: Pick<IOrderView, 'id' | 'serviceName' | 'quantity' | 'createdAt'>): string {
  return `${o.serviceName} · ${o.quantity.toLocaleString('en-US')} · ${o.createdAt.slice(5, 10)} · #${o.id.slice(0, 6)}`
}

/** A suggested subject when a ticket starts from an order's "Report an issue" button. */
export const defaultSubjectFor = (o: Pick<IOrderView, 'serviceName'> | null): string => (o ? `Problem with my order: ${o.serviceName}`.slice(0, SUBJECT_MAX) : '')
