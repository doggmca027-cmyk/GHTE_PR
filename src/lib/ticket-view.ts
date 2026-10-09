// Display and validation rules for support tickets. Pure: no React, no I/O.
import { t, tr } from '@/i18n'
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
  open: { label: tr('Waiting for support'), className: 'bg-amber-50 text-amber-700' },
  answered: { label: tr('Support replied'), className: 'bg-emerald-50 text-emerald-700' },
  resolved: { label: tr('Resolved'), className: 'bg-brand-light text-brand-text' },
  closed: { label: tr('Closed'), className: 'bg-slate-100 text-slate-600' },
}
const ADMIN: Record<TicketStatus, StatusMeta> = {
  ...CUSTOMER,
  open: { label: tr('Needs reply'), className: 'bg-rose-50 text-rose-700' },
  answered: { label: tr('Answered'), className: 'bg-emerald-50 text-emerald-700' },
}

export const statusMeta = (status: TicketStatus, viewer: Viewer = 'customer'): StatusMeta => (viewer === 'admin' ? ADMIN : CUSTOMER)[status]

/** A closed ticket takes no more messages; every other status does (a customer reply reopens an answered / resolved one). */
export const canReply = (status: TicketStatus): boolean => status !== 'closed'

export function checkSubject(raw: string): string | null {
  const text = raw.trim()
  if (text.length < SUBJECT_MIN) return t('Describe the problem in at least {n} characters.', { n: SUBJECT_MIN })
  if (text.length > SUBJECT_MAX) return t('Keep the subject under {n} characters.', { n: SUBJECT_MAX })
  return null
}

export function checkMessage(raw: string): string | null {
  const text = raw.trim()
  if (text.length === 0) return t('Write a message.')
  if (text.length > MESSAGE_MAX) return t('Keep the message under {n} characters.', { n: MESSAGE_MAX.toLocaleString('en-US') })
  return null
}

/** "Telegram Views · 1,000 · 05-09" - how an order is named in the picker. */
export function orderOptionLabel(o: Pick<IOrderView, 'id' | 'serviceName' | 'quantity' | 'createdAt'>): string {
  return `${o.serviceName} · ${o.quantity.toLocaleString('en-US')} · ${o.createdAt.slice(5, 10)} · #${o.id.slice(0, 6)}`
}

/** A suggested subject when a ticket starts from an order's "Report an issue" button. */
export const defaultSubjectFor = (o: Pick<IOrderView, 'serviceName'> | null): string => (o ? t('Problem with my order: {name}', { name: o.serviceName }).slice(0, SUBJECT_MAX) : '')
