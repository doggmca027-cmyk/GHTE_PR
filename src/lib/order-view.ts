import { currentLocale, t, tr } from '@/i18n'
import type { OrderStatus } from '@/types'

export type OrderFilter = 'all' | 'active' | 'completed' | 'closed'

export const ORDER_FILTERS: { id: OrderFilter; label: string }[] = [
  { id: 'all', label: tr('All') },
  { id: 'active', label: tr('Active') },
  { id: 'completed', label: tr('Completed') },
  { id: 'closed', label: tr('Canceled / Refunded') },
]

const ACTIVE: OrderStatus[] = ['awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress']
const COMPLETED: OrderStatus[] = ['completed', 'partial']
const CLOSED: OrderStatus[] = ['canceled', 'refunded', 'failed']

export const isActiveStatus = (s: OrderStatus): boolean => ACTIVE.includes(s)

export function matchesFilter(status: OrderStatus, filter: OrderFilter): boolean {
  if (status === 'draft') return false // never shown to customers
  switch (filter) {
    case 'all': return true
    case 'active': return ACTIVE.includes(status)
    case 'completed': return COMPLETED.includes(status)
    case 'closed': return CLOSED.includes(status)
  }
}

export type StatusTone = 'success' | 'brand' | 'warning' | 'neutral' | 'danger'

export interface StatusMeta {
  label: string
  tone: StatusTone
  /** Animated dot for orders that are still moving. */
  pulse: boolean
}

export function statusMeta(status: OrderStatus): StatusMeta {
  switch (status) {
    case 'completed': return { label: t('Completed'), tone: 'success', pulse: false }
    case 'partial': return { label: t('Partial'), tone: 'success', pulse: false }
    case 'submitted': return { label: t('Submitted'), tone: 'brand', pulse: true }
    case 'in_progress': return { label: t('In progress'), tone: 'brand', pulse: true }
    case 'paid':
    case 'awaiting_payment': return { label: t('Paid'), tone: 'brand', pulse: true }
    case 'processing': return { label: t('Processing'), tone: 'warning', pulse: true }
    case 'canceled': return { label: t('Canceled'), tone: 'neutral', pulse: false }
    case 'refunded': return { label: t('Refunded'), tone: 'neutral', pulse: false }
    case 'failed': return { label: t('Failed'), tone: 'danger', pulse: false }
    case 'draft': return { label: t('Draft'), tone: 'neutral', pulse: false }
  }
}

/** Share of the order delivered so far (0-1), or null when the provider has not reported `remains`. */
export function deliveredRatio(quantity: number, remains: number | null): number | null {
  if (remains === null || quantity <= 0) return null
  return Math.min(1, Math.max(0, (quantity - remains) / quantity))
}

/** "https://t.me/very/long/path" -> "t.me/very/long/p…" */
export function truncateUrl(url: string, max = 34): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
  return bare.length <= max ? bare : `${bare.slice(0, max - 1)}…`
}

export function formatOrderDate(iso: string, locale = currentLocale()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
