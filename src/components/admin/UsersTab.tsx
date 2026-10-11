import { useState } from 'react'
import { Ban, Loader2, Search, ShieldCheck, UserRound } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { adminActionError } from '@/lib/deposit-case'
import { timeAgoRu, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { findUsers, setUserBan } from '@/services/api/admin'
import type { AdminUserView } from '@/types/admin'

/**
 * Suspend or restore a customer (admin_set_user_ban). Suspending asks for a reason (it goes to the audit log) and a second tap;
 * restoring is one tap. Used on the Users tab and on the cases of the Reconciliation Center.
 */
export function BanControl({ session, userId, banned, label, onChanged }: {
  session: AuthSession
  userId: string
  banned: boolean
  /** Who, for the confirmation ("@alice" / "id 910001"). */
  label: string
  onChanged: (banned: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply(next: boolean) {
    setBusy(true); setError(null)
    try {
      const r = await setUserBan(session, userId, next, next ? reason : undefined)
      haptic.success()
      setOpen(false); setReason('')
      onChanged(r.isBanned)
    } catch (e) {
      haptic.error()
      setError(adminActionError(e instanceof Error ? e.message : 'Не удалось.'))
    } finally {
      setBusy(false)
    }
  }

  if (banned) {
    return (
      <div className="space-y-1.5">
        <button type="button" disabled={busy} onClick={() => void apply(false)} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-2xl border border-emerald-200 bg-surface text-[13px] font-bold text-emerald-700 active:scale-95 disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} strokeWidth={1.75} />} Разблокировать {label}
        </button>
        {error && <p role="alert" className="text-xs font-semibold text-rose-600">{error}</p>}
      </div>
    )
  }
  if (!open) {
    return (
      <button type="button" onClick={() => { haptic.tap(); setOpen(true) }} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-2xl border border-rose-200 bg-surface text-[13px] font-bold text-rose-600 active:scale-95">
        <Ban size={15} strokeWidth={1.75} /> Заблокировать {label}
      </button>
    )
  }
  return (
    <div className="space-y-2 rounded-2xl border border-rose-200 bg-rose-50 p-3">
      <label className="block text-xs font-bold text-rose-800">
        Причина блокировки (обязательно)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Например: мошеннические депозиты" className="mt-1 w-full rounded-xl border border-rose-200 bg-surface px-3 py-2.5 text-sm font-medium text-content-primary outline-none focus:border-rose-400" />
      </label>
      <p className="text-[12px] font-medium text-rose-700">Клиент не сможет покупать, пополнять баланс и писать в поддержку. Деньги на балансе остаются.</p>
      {error && <p role="alert" className="text-xs font-semibold text-rose-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void apply(true)} className="flex h-10 flex-1 items-center justify-center gap-1 rounded-xl bg-rose-600 text-[13px] font-bold text-white active:scale-95 disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />} Заблокировать
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null) }} className="h-10 flex-1 rounded-xl bg-surface text-[13px] font-semibold text-content-secondary active:scale-95">Отмена</button>
      </div>
    </div>
  )
}

export const userLabel = (u: { username: string | null; telegramId: number }) => (u.username ? `@${u.username}` : `id ${u.telegramId}`)

/** Find a customer by Telegram id, user id or @username, and suspend or restore them. */
export function UsersTab({ session }: { session: AuthSession }) {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<AdminUserView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function search() {
    if (query.trim().length < 2) return
    setBusy(true); setError(null)
    try {
      setUsers(await findUsers(session, query))
    } catch (e) {
      setError(adminActionError(e instanceof Error ? e.message : 'Не удалось найти.'))
    } finally {
      setBusy(false)
    }
  }

  const update = (id: string, banned: boolean) => setUsers((list) => list?.map((u) => (u.id === id ? { ...u, isBanned: banned } : u)) ?? null)

  return (
    <div className="space-y-3">
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Найдите клиента по Telegram ID, ID пользователя или @username. Заблокированный клиент не может покупать, пополнять баланс и писать в поддержку; каждое действие пишется в журнал аудита.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void search() }} className="flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Найти клиента</span>
          <Search size={15} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={64} placeholder="910001, @alice или UUID" className="h-11 w-full rounded-xl border border-blue-100/70 bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand" />
        </label>
        <button type="submit" disabled={busy || query.trim().length < 2} className="h-11 rounded-xl bg-brand px-4 text-sm font-bold text-white disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin" /> : 'Найти'}
        </button>
      </form>
      {error && <p role="alert" className="rounded-2xl bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-700">{error}</p>}
      {users && users.length === 0 && <Card className="py-8 text-center text-sm text-content-secondary">Никого не нашли.</Card>}
      {users?.map((u) => (
        <article key={u.id} className={cn('space-y-3 rounded-3xl border bg-surface p-4 shadow-card', u.isBanned ? 'border-rose-300' : 'border-blue-100/70')}>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-light text-brand"><UserRound size={20} strokeWidth={1.75} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold text-content-primary">{u.firstName ?? userLabel(u)} {u.username && <span className="font-medium text-content-secondary">@{u.username}</span>}</p>
              <p className="text-xs text-content-secondary">Telegram {u.telegramId} · с нами {timeAgoRu(u.createdAt).replace(/ назад$/, '')}</p>
              <p className="mt-0.5 truncate font-mono text-[11px] text-content-muted" title={u.id}>{u.id}</p>
            </div>
            {u.isBanned && <span className="shrink-0 rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white">Заблокирован</span>}
            {u.isAdmin && <span className="shrink-0 rounded-full bg-brand-light px-2.5 py-1 text-[11px] font-bold text-brand-text">Админ</span>}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-2xl bg-surface-sub px-3 py-2"><dt className="text-xs text-content-secondary">Баланс</dt><dd className="font-bold text-content-primary">{usd(u.balance)}</dd></div>
            <div className="rounded-2xl bg-surface-sub px-3 py-2"><dt className="text-xs text-content-secondary">Заказов</dt><dd className="font-bold text-content-primary">{u.orders}</dd></div>
          </dl>
          {u.isYou ? (
            <p className="text-xs font-medium text-content-secondary">Это вы: себя заблокировать нельзя.</p>
          ) : (
            <BanControl session={session} userId={u.id} banned={u.isBanned} label={userLabel(u)} onChanged={(b) => update(u.id, b)} />
          )}
        </article>
      ))}
    </div>
  )
}
