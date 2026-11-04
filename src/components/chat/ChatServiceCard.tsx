import { memo } from 'react'
import { Layers, RefreshCw, ShieldOff } from 'lucide-react'
import { PlatformIcon } from '@/components/services/PlatformIcon'
import { Badge } from '@/components/ui/Badge'
import { currentLocale, useT } from '@/i18n'
import type { ChatCard } from '@/lib/ai-chat'
import { formatCompact, formatMoneyAmount } from '@/lib/order-calc'
import { shortDays } from '@/lib/variants'

interface Props {
  card: ChatCard
  /** "Select" was pressed: the order form opens on this article. */
  onSelect: (sku: string) => void
}

/**
 * A service the assistant recommended, as a small card inside the conversation: what it is, its guarantee, its price and limits, and the button that
 * opens the order form on it. Every value comes from the catalogue (the server builds the card), none from the model's text.
 */
export const ChatServiceCard = memo(function ChatServiceCard({ card, onSelect }: Props) {
  const t = useT()
  const locale = currentLocale()
  return (
    <article data-testid="chat-card" data-sku={card.sku} className="rounded-2xl border border-blue-100/70 bg-surface p-3 shadow-card">
      <div className="flex items-start gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-light text-brand">
          <PlatformIcon platform={card.platform} name={card.category} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 break-words text-[13.5px] font-bold leading-snug text-content-primary">{card.name}</h3>
          <p className="mt-0.5 truncate font-mono text-[11px] font-semibold text-content-muted">{card.sku}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="chat-card-badges">
        {card.lifetime && <Badge><RefreshCw size={12} strokeWidth={2} /> {t('Recovery: {time}', { time: t('lifetime') })}</Badge>}
        {!card.lifetime && card.refill && card.refillDays !== undefined && <Badge><RefreshCw size={12} strokeWidth={2} /> {t('Recovery: {time}', { time: shortDays(card.refillDays, locale) })}</Badge>}
        {!card.lifetime && card.refill && card.refillDays === undefined && <Badge><RefreshCw size={12} strokeWidth={2} /> {t('Refill')}</Badge>}
        {!card.refill && <Badge><ShieldOff size={12} strokeWidth={2} /> {t('No refill')}</Badge>}
        {card.dripfeed && <Badge><Layers size={12} strokeWidth={2} /> Drip-feed</Badge>}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-extrabold leading-none text-content-primary">
            {formatMoneyAmount(card.price)}
            <span className="ms-1 text-[11px] font-semibold text-content-muted">/ 1,000</span>
          </p>
          <p className="mt-1 text-[11px] font-medium text-content-secondary">{t('Min {min} · Max {max}', { min: formatCompact(card.min), max: formatCompact(card.max) })}</p>
        </div>
        <button
          type="button"
          onClick={() => onSelect(card.sku)}
          aria-label={`${t('Select')}: ${card.sku}`}
          className="h-9 shrink-0 rounded-full bg-brand px-5 text-[13px] font-bold text-white transition-transform active:scale-95"
        >
          {t('Select')}
        </button>
      </div>
    </article>
  )
})
