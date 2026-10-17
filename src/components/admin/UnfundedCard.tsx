import { useState } from 'react'
import { Hourglass, Loader2, Rocket } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { plural, timeAgoRu, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { runOrderHub } from '@/services/api/admin-providers'
import type { AuthSession } from '@/services/api/auth'
import type { UnfundedSummary } from '@/types/admin'

/**
 * The order hub: paid orders waiting for their provider to be topped up, by provider: what the queue needs, what the panel has, what is
 * missing. They are sent by themselves within a minute of the top-up; "Run the queue" reads the balance from the panel and sends them now.
 * The ones still waiting after the limit are refunded in full.
 */
export function UnfundedCard({ unfunded, ttlHours, session, onRan }: { unfunded: UnfundedSummary; ttlHours: number; session?: AuthSession; onRan?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  if (unfunded.count === 0) return null

  const run = async (providerId: string) => {
    if (!session || busy) return
    haptic.tap()
    setBusy(providerId)
    setNote(null)
    try {
      const r = await runOrderHub(session, providerId)
      const parts = [`${r.provider}: баланс ${r.balance === null ? 'не прочитан' : usd(r.balance)}`, `отправлено ${r.submitted}`]
      if (r.returned > 0) parts.push(`вернулись в Хаб ${r.returned}`)
      if (r.rejected > 0) parts.push(`отклонены ${r.rejected}`)
      parts.push(r.waiting > 0 ? `ещё ждут ${r.waiting} на ${usd(r.needed)}` : 'очередь пуста')
      setNote({ kind: 'ok', text: parts.join(' · ') })
      onRan?.()
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось запустить очередь.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="space-y-2.5 border-amber-300 bg-amber-50/60 p-4" role="status" aria-label="Хаб ожидания">
      <div className="flex items-start gap-2.5">
        <Hourglass size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-content-primary">
            Хаб ожидания: {unfunded.count} {plural(unfunded.count, ['оплаченный заказ ждёт', 'оплаченных заказа ждут', 'оплаченных заказов ждут'])} пополнения провайдера
          </h3>
          <p className="mt-0.5 text-xs font-medium text-content-secondary">
            Клиенты заплатили {usd(unfunded.charge)}, провайдерам нужно перевести около {usd(unfunded.cost)}. Заказы уйдут сами в течение минуты после пополнения,
            а если не пополнить за {ttlHours} ч, клиентам вернутся деньги.
          </p>
        </div>
      </div>
      <ul className="space-y-1.5" data-testid="order-hub">
        {unfunded.providers.map((p) => {
          const shortfall = Math.max(0, p.cost - p.balance)
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface/80 px-3 py-2 text-[13px]">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-content-primary">{p.name}</span>
                <span className="block text-content-secondary">
                  нужно <b className="text-content-primary">{usd(p.cost)}</b> · {p.count} шт. · на панели {usd(p.balance)}
                  {shortfall > 0 ? <> · <b className="text-rose-600">не хватает {usd(shortfall)}</b></> : ' · хватает'}
                  {p.oldest ? ` · ждёт ${timeAgoRu(p.oldest).replace(/ назад$/, '')}` : ''}
                </span>
              </span>
              {session && (
                <button type="button" onClick={() => void run(p.id)} disabled={busy !== null}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-brand px-2.5 text-xs font-bold text-white active:scale-95 disabled:opacity-50">
                  {busy === p.id ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} strokeWidth={2} />} Запустить очередь
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {note && <p role={note.kind === 'error' ? 'alert' : 'status'} className={note.kind === 'error' ? 'rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700' : 'rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700'}>{note.text}</p>}
    </Card>
  )
}
