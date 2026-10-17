import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, Gem, Globe, Hourglass, Link2, Loader2, RefreshCw, ShieldCheck, TriangleAlert, X, Zap, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Toast, type ToastMessage } from '@/components/ui/Toast'
import { currentLocale, tr, useLanguage, useT } from '@/i18n'
import { describeServiceDetails, localizedName, type DetailKind } from '@/lib/service-view'
import { tm } from '@/i18n/messages'
import { useAuth } from '@/context/AuthContext'
import { useSignIn } from '@/context/SignInContext'
import { track } from '@/lib/analytics-client'
import { newIdempotencyKey } from '@/lib/idempotency'
import { haptic } from '@/lib/haptics'
import {
  calcTotalUnits,
  checkBalance,
  deriveSpeed,
  formatInt,
  formatMoneyAmount,
  formatUnits,
  quantityPresets,
  toUnits,
  validateQuantity,
  validateTargetUrl,
} from '@/lib/order-calc'
import { useQuote } from '@/hooks/useQuote'
import { DEFAULT_DRIP_INTERVAL_MINUTES, DEFAULT_DRIP_RUNS, MAX_DRIP_RUNS, orderShape, validateDripSchedule } from '@/lib/drip-feed'
import { cn } from '@/lib/utils'
import { OrderApiError } from '@/services/api/order-errors'
import { createOrder } from '@/services/api/orders'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalogService, Platform } from '@/types/catalog'
import type { CreateOrderResult } from '@/types/orders'
import { DripFeedFields } from './DripFeedFields'
import { PlatformIcon } from './PlatformIcon'
import { PriceSummary, displayedTotalUnits } from './PriceSummary'
import { PromoField } from './PromoField'

interface Props {
  service: ICatalogService
  platform: Platform
  platformName?: string
  session: AuthSession
  onClose: () => void
  onTopUp: (shortfallUsd: number) => void
  onViewOrders: () => void
}

type Phase =
  | { kind: 'form' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: CreateOrderResult }

const inputClass = (invalid: boolean) =>
  cn(
    'w-full rounded-2xl border bg-surface-sub px-4 py-3.5 text-[15px] font-medium text-content-primary outline-none transition-colors placeholder:text-content-muted focus:bg-surface disabled:opacity-60',
    invalid ? 'border-rose-300 focus:border-rose-400' : 'border-blue-100/70 focus:border-brand',
  )

export function OrderModal({ service, platform, platformName, session, onClose, onTopUp, onViewOrders }: Props) {
  const t = useT()
  const { lang } = useLanguage()
  const { applyWallet } = useAuth()
  // a website guest prices freely; ordering asks to sign in first (this form stays open, so the order continues right after)
  const guest = session.isGuest === true
  const signIn = useSignIn()
  const wallet = session.wallet

  const [link, setLink] = useState('')
  const [quantity, setQuantity] = useState(String(service.minQuantity))
  const [promo, setPromo] = useState('')
  // Drip-feed: the quantity field then holds ONE delivery; the order's quantity is that times the runs.
  const [drip, setDrip] = useState(false)
  const [runs, setRuns] = useState(String(DEFAULT_DRIP_RUNS))
  const [dripInterval, setDripInterval] = useState(String(DEFAULT_DRIP_INTERVAL_MINUTES))
  const [linkTouched, setLinkTouched] = useState(false)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })

  // One key per opened drawer. It is only replaced when the request changes or its outcome is
  // definitive, so a double-tap or a retry after a dropped connection can never charge twice.
  const keyRef = useRef(newIdempotencyKey())
  const submittingRef = useRef(false)
  const dirtySinceAttempt = useRef(false)

  const busy = phase.kind === 'submitting'
  const done = phase.kind === 'done'

  // Funnel: opening the order form for a service IS the start of checkout. Reported once per opening, with exactly what the server's
  // allow-list accepts for the event (service_id, quantity, has_promo); the category travels with service_view, which the server
  // lists with category_id. Neither the link nor the promo code is ever reported (typing a code only reports promo_entered).
  useEffect(() => {
    track('service_view', { service_id: service.id, category_id: service.categoryId })
    track('checkout_started', { service_id: service.id, quantity: service.minQuantity, has_promo: false })
  }, [service.id, service.categoryId, service.minQuantity])
  const promoRef = useRef(false)
  useEffect(() => {
    if (!promoRef.current && promo.trim() !== '') {
      promoRef.current = true
      track('promo_entered', { service_id: service.id })
    }
  }, [promo, service.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !submittingRef.current && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Display-only maths: the server recomputes the real charge from the database.
  const qty = validateQuantity(quantity, service.minQuantity, service.maxQuantity)
  const url = validateTargetUrl(link)
  const dripOn = drip && service.dripfeedAvailable === true
  const schedule = validateDripSchedule(runs, dripInterval)
  // What is priced and sent: the TOTAL quantity (+ runs / interval for a drip-feed order). Null while anything is invalid.
  const shape = orderShape(qty.ok ? qty.value : null, dripOn, schedule)
  const orderOk = shape !== null
  const estimateUnits = shape ? calcTotalUnits(shape.quantity, service.ratePer1000) : 0

  // The live price (tier + promo applied) from the quote-order function: debounced, one request in flight (see quote-controller).
  const { state: quoteState, invalidate } = useQuote(session, service.id, shape ? shape.quantity : null, promo, shape?.runs ?? 1)
  const { units: totalUnits } = displayedTotalUnits(quoteState, estimateUnits)
  const balance = checkBalance(wallet.balance, totalUnits)
  const pricing = quoteState.kind === 'loading'
  const promoRefused = quoteState.kind === 'ready' && quoteState.promoError !== null

  const showLinkError = linkTouched && !url.ok
  const showQtyError = quantity !== '' && !qty.ok

  function edited() {
    if (dirtySinceAttempt.current) {
      keyRef.current = newIdempotencyKey() // different request => different key
      dirtySinceAttempt.current = false
    }
    if (phase.kind === 'error') setPhase({ kind: 'form' })
  }

  async function submit() {
    if (!shape || !url.ok || submittingRef.current || pricing || promoRefused) return
    submittingRef.current = true
    dirtySinceAttempt.current = true
    setPhase({ kind: 'submitting' })
    haptic.tap()
    try {
      const result = await createOrder(session, {
        serviceId: service.id,
        targetUrl: url.value,
        quantity: shape.quantity,
        ...(shape.runs > 1 ? { runs: shape.runs, interval: shape.interval } : {}),
        idempotencyKey: keyRef.current,
        ...(promo.trim() ? { promoCode: promo.trim().toUpperCase() } : {}),
      })
      if (result.wallet) applyWallet(result.wallet)
      haptic.success()
      setToast({ kind: 'ok', text: t('Order placed: charged {amount}.', { amount: formatUnits(toUnits(result.order.chargeAmount)) }) })
      setPhase({ kind: 'done', result })
    } catch (e) {
      const err = e instanceof OrderApiError ? e : new OrderApiError('server', tr('Something went wrong. Please try again.'))
      if (err.wallet) applyWallet(err.wallet)
      // A definitive answer (rejected / refunded / invalid) closes that key. Network errors keep it
      // so a retry is deduplicated by the server.
      if (err.isDefinitive) {
        keyRef.current = newIdempotencyKey()
        dirtySinceAttempt.current = false
      }
      haptic.error()
      if (err.code.startsWith('promo_')) invalidate() // the code's state changed under us: price it again
      setPhase({ kind: 'error', message: tm(err.message) })
    } finally {
      submittingRef.current = false
    }
  }

  function handleCta() {
    if (busy || !orderOk || pricing || promoRefused) return
    if (guest) {
      haptic.tap()
      signIn()
      return
    }
    if (!balance.sufficient) {
      haptic.tap()
      onTopUp(balance.shortfallUnits / 10_000)
      return
    }
    setLinkTouched(true)
    if (!url.ok) {
      haptic.error()
      return
    }
    void submit()
  }

  const ctaLabel = busy
    ? t('Placing order…')
    : !orderOk
      ? t('Enter a valid quantity')
      : pricing
        ? t('Calculating price…')
        : promoRefused
          ? t('Fix or remove the promo code')
          : guest
          ? t('Sign in with Telegram to order')
          : balance.sufficient
        ? t('Order Now (Total {total})', { total: formatUnits(totalUnits) })
        : t('Top Up Balance (Needs +{amount})', { amount: formatUnits(balance.shortfallUnits) })

  return (
    <div className="absolute inset-0 z-50 flex items-end animate-fade-in" role="dialog" aria-modal="true" aria-label={t('Configure order')}>
      <button type="button" aria-label={t('Close')} onClick={() => !busy && onClose()} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      <div className="relative z-10 max-h-[92%] w-full animate-sheet-up overflow-y-auto rounded-t-[32px] bg-surface px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_40px_rgb(0,136,204,0.14)]">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-blue-100" />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-content-primary">{done ? t('Order received') : t('Configure order')}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t('Close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sub text-content-secondary active:scale-90 disabled:opacity-40">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {phase.kind === 'done' ? (
          <SuccessPanel result={phase.result} onViewOrders={onViewOrders} onClose={onClose} />
        ) : (
          <>
            {/* Service summary */}
            <div className="flex items-start gap-3 rounded-3xl border border-blue-100/70 bg-surface-sub p-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-light text-brand">
                <PlatformIcon platform={platform} name={platformName} size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold leading-snug text-content-primary">{localizedName(service.name, service.nameI18n, lang)}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge><Zap size={12} strokeWidth={2} /> {t(deriveSpeed(service.name))}</Badge>
                  {service.refillSupported && <Badge><ShieldCheck size={12} strokeWidth={2} /> {t('Refill')}</Badge>}
                </div>
                <p className="mt-2 text-xs font-medium text-content-secondary">
                  {t('{rate} per 1,000 · {min} – {max}', { rate: formatMoneyAmount(service.ratePer1000), min: formatInt(service.minQuantity), max: formatInt(service.maxQuantity) })}
                </p>
              </div>
            </div>

            <ServiceDescription service={service} />

            {/* Link */}
            <label className="mt-5 block">
              <span className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-content-primary">
                <Link2 size={16} strokeWidth={1.75} className="text-brand" /> {t('Target link')}
              </span>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://t.me/your_channel"
                value={link}
                disabled={busy}
                onChange={(e) => { setLink(e.target.value); edited() }}
                onBlur={() => link !== '' && setLinkTouched(true)}
                aria-invalid={showLinkError}
                className={inputClass(showLinkError)}
              />
              {showLinkError && !url.ok && <p className="mt-1.5 text-xs font-medium text-rose-500">{tm(url.error)}</p>}
            </label>

            {/* Quantity */}
            <label className="mt-4 block">
              <span className="mb-1.5 block text-sm font-bold text-content-primary">{dripOn ? t('Quantity per run') : t('Quantity')}</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder={`${formatInt(service.minQuantity)} – ${formatInt(service.maxQuantity)}`}
                value={quantity}
                disabled={busy}
                onChange={(e) => { setQuantity(e.target.value.replace(/[^\d]/g, '').slice(0, 12)); edited() }}
                aria-invalid={showQtyError}
                className={inputClass(showQtyError)}
              />
              {showQtyError && !qty.ok && <p className="mt-1.5 text-xs font-medium text-rose-500">{tm(qty.error)}</p>}
            </label>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {quantityPresets(service.minQuantity, service.maxQuantity).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => { haptic.select(); setQuantity(String(preset)); edited() }}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors active:scale-95',
                    quantity === String(preset) ? 'bg-brand-light text-brand-text' : 'bg-surface-sub text-content-secondary hover:text-content-primary',
                  )}
                >
                  {formatInt(preset)}
                </button>
              ))}
            </div>

            {service.dripfeedAvailable === true && (
              <DripFeedFields
                enabled={drip}
                onToggle={(on) => { setDrip(on); edited() }}
                runs={runs}
                onRuns={(v) => { setRuns(v); edited() }}
                interval={dripInterval}
                onInterval={(v) => { setDripInterval(v); edited() }}
                schedule={schedule}
                perRun={qty.ok ? qty.value : null}
                disabled={busy}
              />
            )}

            {!guest && <PromoField value={promo} onChange={(v) => { setPromo(v); edited() }} disabled={busy} state={quoteState} />}

            {/* Price + balance */}
            <PriceSummary
              quantity={shape ? shape.quantity : null}
              // a drip-feed order may total the per-run maximum times the runs
              maxQuantity={service.dripfeedAvailable === true ? service.maxQuantity * MAX_DRIP_RUNS : service.maxQuantity}
              ratePer1000={service.ratePer1000}
              estimateUnits={estimateUnits}
              state={quoteState}
              balance={wallet.balance}
              sufficient={balance.sufficient}
              shortfallUnits={balance.shortfallUnits}
              hideBalance={guest}
            />

            {phase.kind === 'error' && (
              <div className="mt-4 flex gap-2.5 rounded-2xl bg-rose-50 p-3.5 text-[13px] font-medium text-rose-700" role="alert">
                <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <p>{phase.message}</p>
              </div>
            )}

            <Button
              className={cn('mt-5 h-14 w-full text-[15px]', (!orderOk || busy || pricing || promoRefused) && 'cursor-not-allowed opacity-60 hover:bg-brand')}
              disabled={!orderOk || busy || pricing || promoRefused}
              aria-busy={busy}
              onClick={handleCta}
            >
              {busy && <Loader2 size={18} strokeWidth={2} className="animate-spin" />}
              {ctaLabel}
            </Button>
          </>
        )}
      </div>
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}

const FACT_ICONS: Record<DetailKind, LucideIcon> = { refill: RefreshCw, guarantee: ShieldCheck, start: Hourglass, speed: Zap, quality: Gem, geo: Globe }

/**
 * The full description of a service: what it promises as one row per fact (refill, start, speed, quality, countries), built from the
 * service's facts so it reads in the customer's own language, then the text the panel sent, when it sent one.
 */
export function ServiceDescription({ service }: { service: ICatalogService }) {
  const t = useT()
  const facts = describeServiceDetails(service.attributes, currentLocale())
  const text = service.description?.trim() ?? ''
  if (facts.length === 0 && text === '') return null
  return (
    <section className="mt-3 rounded-2xl bg-surface-sub px-4 py-3.5" aria-label={t('Description')} data-testid="service-description">
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-content-muted">{t('Description')}</h3>
      {facts.length > 0 && (
        <ul className="space-y-3 text-[13px] font-medium leading-snug text-content-secondary">
          {facts.map((fact) => {
            const Icon = FACT_ICONS[fact.kind]
            return (
              <li key={fact.kind} className="flex items-start gap-2.5">
                <Icon size={16} strokeWidth={1.75} className="mt-px shrink-0 text-brand" aria-hidden="true" />
                <span>{fact.text}</span>
              </li>
            )
          })}
        </ul>
      )}
      {text !== '' && (
        <div className={cn('space-y-2 text-[13px] font-medium leading-snug text-content-secondary', facts.length > 0 && 'mt-3 border-t border-blue-100/70 pt-3')}>
          {text.split(/\n+/).map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}
    </section>
  )
}

function SuccessPanel({ result, onViewOrders, onClose }: { result: CreateOrderResult; onViewOrders: () => void; onClose: () => void }) {
  const t = useT()
  const pending = result.pending
  const waiting = result.awaitingFunds === true
  const Icon = pending ? Clock : CheckCircle2
  return (
    <div className="pb-1 text-center" role="status">
      <span className={cn('mx-auto flex h-16 w-16 items-center justify-center rounded-full', pending ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600')}>
        <Icon size={32} strokeWidth={1.75} />
      </span>
      <h3 className="mt-4 text-xl font-extrabold text-content-primary">{waiting ? t('Paid, waiting to be connected') : pending ? t('Confirming with provider') : t('Order placed!')}</h3>
      <p className="mx-auto mt-1.5 max-w-xs text-sm text-content-secondary">
        {waiting
          ? t('Your order is paid. The service is being connected and this can take up to {hours} hours. If it cannot be started in time, the full amount is returned to your balance automatically.', { hours: result.deferredTtlHours ?? 24 })
          : pending
          ? t('Your order was received and is being confirmed. No action is needed: you will see it in your orders.')
          : t('Your order has been sent for delivery. You can follow its progress in your orders.')}
      </p>

      <div className="mt-5 rounded-3xl border border-blue-100/70 bg-surface-sub p-4 text-left text-sm">
        <div className="flex justify-between"><span className="text-content-secondary">{t('Quantity')}</span><span className="font-bold">{formatInt(result.order.quantity)}</span></div>
        <div className="mt-2 flex justify-between"><span className="text-content-secondary">{t('Charged')}</span><span className="font-bold">{formatUnits(toUnits(result.order.chargeAmount))}</span></div>
        {result.wallet && (
          <div className="mt-2 flex justify-between border-t border-blue-100/70 pt-2"><span className="text-content-secondary">{t('New balance')}</span><span className="font-bold">{formatMoneyAmount(result.wallet.balance)}</span></div>
        )}
      </div>

      <Button className="mt-5 h-14 w-full text-[15px]" onClick={() => { haptic.tap(); onViewOrders() }}>{t('View my orders')}</Button>
      <button type="button" onClick={onClose} className="mt-2 w-full rounded-2xl py-3 text-sm font-semibold text-content-secondary active:scale-95">{t('Done')}</button>
    </div>
  )
}
