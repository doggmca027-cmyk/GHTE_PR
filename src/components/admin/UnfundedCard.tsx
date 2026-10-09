import { Hourglass } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { plural, timeAgoRu, usd } from '@/lib/admin-view'
import type { UnfundedSummary } from '@/types/admin'

/**
 * Paid orders that wait for a provider top-up (deferred funding): how many, what to transfer and where. They are sent by themselves within a
 * minute of the top-up; the ones still waiting after the limit are refunded in full.
 */
export function UnfundedCard({ unfunded, ttlHours }: { unfunded: UnfundedSummary; ttlHours: number }) {
  if (unfunded.count === 0) return null
  return (
    <Card className="space-y-2.5 border-amber-300 bg-amber-50/60 p-4" role="status" aria-label="Заказы ждут пополнения провайдера">
      <div className="flex items-start gap-2.5">
        <Hourglass size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-content-primary">
            {unfunded.count} {plural(unfunded.count, ['оплаченный заказ ждёт', 'оплаченных заказа ждут', 'оплаченных заказов ждут'])} пополнения провайдера
          </h3>
          <p className="mt-0.5 text-xs font-medium text-content-secondary">
            Клиенты заплатили {usd(unfunded.charge)}, провайдерам нужно перевести около {usd(unfunded.cost)}. Заказы уйдут сами в течение минуты после пополнения,
            а если не пополнить за {ttlHours} ч, клиентам вернутся деньги.
          </p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {unfunded.providers.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/80 px-3 py-2 text-[13px]">
            <span className="min-w-0 truncate font-semibold text-content-primary">{p.name}</span>
            <span className="shrink-0 text-right text-content-secondary">
              перевести <b className="text-content-primary">{usd(p.cost)}</b> · {p.count} шт. · на панели {usd(p.balance)}
              {p.oldest ? ` · ждёт ${timeAgoRu(p.oldest).replace(/ назад$/, '')}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
