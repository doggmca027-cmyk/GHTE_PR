import { CheckCircle2, Loader2, Tag, TriangleAlert } from 'lucide-react'
import { useT } from '@/i18n'
import { tm } from '@/i18n/messages'
import { formatInt, formatMoneyAmount, formatUnits, toUnits } from '@/lib/order-calc'
import { cn } from '@/lib/utils'
import type { Quote, QuoteState } from '@/types/quote'

/** The units the order will cost: the server quote once it is in, otherwise the list-price estimate. */
export function displayedTotalUnits(state: QuoteState, estimateUnits: number): { units: number; estimated: boolean } {
  if (state.kind === 'ready') return { units: toUnits(state.quote.finalPrice), estimated: false }
  if (state.kind === 'loading' && state.previous) return { units: toUnits(state.previous.finalPrice), estimated: true }
  return { units: estimateUnits, estimated: true }
}

interface Props {
  quantity: number | null
  ratePer1000: number
  estimateUnits: number
  state: QuoteState
  balance: number
  sufficient: boolean
  shortfallUnits: number
}

/** The price block of the order form: list price, the tier and promo discounts, the final price, and the balance check. */
export function PriceSummary({ quantity, ratePer1000, estimateUnits, state, balance, sufficient, shortfallUnits }: Props) {
  const t = useT()
  const { units } = displayedTotalUnits(state, estimateUnits)
  const quote: Quote | null = state.kind === 'ready' ? state.quote : state.kind === 'loading' ? state.previous : null
  const loading = state.kind === 'loading'

  return (
    <div className="mt-5 rounded-3xl border border-blue-100/70 bg-surface-sub p-4" aria-busy={loading}>
      <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('Total price')}</p>
      {quantity !== null ? (
        <>
          <p className="mt-1 text-[13px] font-medium text-content-secondary">
            {formatInt(quantity)} × ({formatMoneyAmount(ratePer1000)} / 1,000)
          </p>

          {quote && quote.totalDiscount > 0 && (
            <dl className="mt-2 space-y-1 text-[13px]">
              <div className="flex justify-between text-content-secondary">
                <dt>{t('List price')}</dt>
                <dd className="line-through">{formatMoneyAmount(quote.listPrice)}</dd>
              </div>
              {quote.tier.discount > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <dt>{quote.tier.slug ? t('{tier} tier', { tier: `${quote.tier.slug[0].toUpperCase()}${quote.tier.slug.slice(1)}` }) : t('Tier')} −{quote.tier.percentage}%</dt>
                  <dd>−{formatMoneyAmount(quote.tier.discount)}</dd>
                </div>
              )}
              {quote.promo.applied && (
                <div className="flex justify-between text-emerald-700">
                  <dt className="flex items-center gap-1"><Tag size={12} strokeWidth={2} /> {t('Promo code')}</dt>
                  <dd>−{formatMoneyAmount(quote.promo.discount)}</dd>
                </div>
              )}
            </dl>
          )}

          {loading && !quote ? (
            <div className="mt-2 h-9 w-32 animate-pulse rounded-xl bg-blue-100/70" role="status" aria-label={t('Calculating the price')} />
          ) : (
            <p className={cn('mt-1 text-3xl font-extrabold tracking-tight text-content-primary transition-opacity', loading && 'opacity-50')}>
              {formatUnits(units)}
              {loading && <Loader2 size={16} strokeWidth={2} className="ml-2 inline animate-spin text-content-muted" aria-label={t('Updating the price')} />}
            </p>
          )}

          {state.kind === 'ready' && state.quote.discountReduced && (
            <p className="mt-1 text-xs font-medium text-amber-700">{t('Your discount was limited for this order.')}</p>
          )}
          {state.kind === 'error' && (
            <p role="status" className="mt-1 text-xs font-medium text-amber-700">{t('Showing the list price: {message} Your discounts are applied when you order.', { message: tm(state.message) })}</p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm font-medium text-content-muted">{t('Enter a valid quantity to see the price.')}</p>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-blue-100/70 pt-3 text-sm">
        <span className="font-medium text-content-secondary">{t('Your balance')}</span>
        <span className="flex items-center gap-1.5 font-bold text-content-primary">
          {formatMoneyAmount(balance)}
          {quantity !== null && (sufficient
            ? <CheckCircle2 size={16} strokeWidth={2} className="text-emerald-500" aria-label={t('Enough balance')} />
            : <TriangleAlert size={16} strokeWidth={2} className="text-rose-500" aria-label={t('Insufficient balance')} />)}
        </span>
      </div>
      {quantity !== null && !sufficient && (
        <p className="mt-1.5 text-xs font-medium text-rose-500">{t('You need {amount} more to place this order.', { amount: formatUnits(shortfallUnits) })}</p>
      )}
    </div>
  )
}
