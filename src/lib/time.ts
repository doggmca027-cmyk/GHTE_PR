import { t } from '@/i18n'

/** "just now", "5 min ago", "3 h ago", "2 d ago", or "never". */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return t('never')
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return t('never')
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return t('just now')
  if (s < 3600) return t('{n} min ago', { n: Math.max(1, Math.round(s / 60)) })
  if (s < 86_400) return t('{n} h ago', { n: Math.round(s / 3600) })
  return t('{n} d ago', { n: Math.round(s / 86_400) })
}
