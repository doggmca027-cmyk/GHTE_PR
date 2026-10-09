import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, FlaskConical, Loader2, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/context/AuthContext'
import type { TonWallet } from '@/hooks/useTonWallet'
import { tr, useT } from '@/i18n'
import { tm } from '@/i18n/messages'
import { haptic } from '@/lib/haptics'
import { formatMoneyAmount } from '@/lib/order-calc'
import { DEPOSIT_PRESETS_USD, MAX_DEPOSIT_USD, MIN_DEPOSIT_USD, buildTransactionRequest, parseUsdInput, trimCrypto, validateDepositAmountUsd } from '@/lib/ton'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { DepositApiError } from '@/services/api/deposit-errors'
import { track } from '@/lib/analytics-client'
import { createDeposit, quoteDeposit, simulateMockPayment, verifyDeposit } from '@/services/api/deposits'
import type { DepositAsset, DepositIntent, DepositQuote } from '@/types/wallet'

interface Props {
  session: AuthSession
  wallet: TonWallet
  initialAmount?: number
  onClose: () => void
  /** Called after a deposit was credited so the ledger can refresh. */
  onCredited: () => void
}

type Phase =
  | { kind: 'form' }
  | { kind: 'creating' }
  | { kind: 'signing'; intent: DepositIntent }
  | { kind: 'verifying'; intent: DepositIntent }
  /** Dev mock only: payment is "sent", waiting for the Simulate button. */
  | { kind: 'mock_awaiting'; intent: DepositIntent }
  | { kind: 'credited'; amountUsd: number; balance: number }
  | { kind: 'delayed' }
  | { kind: 'error'; message: string }

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 150_000
/** Errors that mean "the answer will not change by asking again". */
const FINAL_ERRORS = new Set(['underpaid', 'payment_expired', 'tx_already_used', 'unauthorized', 'invalid_input'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function DepositModal({ session, wallet, initialAmount, onClose, onCredited }: Props) {
  const t = useT()
  const { applyWallet } = useAuth()
  const [amountText, setAmountText] = useState(initialAmount ? String(initialAmount) : '10')
  const [asset, setAsset] = useState<DepositAsset>('TON')
  const [quote, setQuote] = useState<DepositQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const cancelled = useRef(false)
  const busyRef = useRef(false)

  useEffect(() => () => { cancelled.current = true }, [])

  const parsed = parseUsdInput(amountText)
  const amount = parsed === null ? ({ ok: false, error: 'Enter a deposit amount' } as const) : validateDepositAmountUsd(parsed)
  const amountError = amountText !== '' && !amount.ok ? amount.error : null
  const usd = amount.ok ? amount.value / 100 : null

  // Debounced live quote (display only: the server quotes again, and locks the rate, on pay).
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    if (usd === null) return
    let stale = false
    const timer = setTimeout(() => {
      quoteDeposit(session, { amountUsd: usd, asset }).then(
        (q) => { if (!stale) setQuote(q) },
        (e) => { if (!stale) setQuoteError(e instanceof DepositApiError ? tm(e.message) : t('Could not get a rate right now.')) },
      )
    }, 350)
    return () => { stale = true; clearTimeout(timer) }
  }, [usd, asset, session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase.kind === 'creating' || phase.kind === 'signing' || phase.kind === 'verifying'

  async function credited(intent: DepositIntent, balance: number) {
    haptic.success()
    setPhase({ kind: 'credited', amountUsd: intent.amountUsd, balance })
    onCredited()
  }

  /** Polls the server until it has found the payment on chain. The server alone decides to credit. */
  async function pollForCredit(intent: DepositIntent) {
    setPhase({ kind: 'verifying', intent })
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (!cancelled.current && Date.now() < deadline) {
      try {
        const r = await verifyDeposit(session, intent.depositId)
        if (r.status === 'completed') {
          if (r.wallet) applyWallet(r.wallet)
          await credited(intent, r.wallet?.balance ?? session.wallet.balance + intent.amountUsd)
          return
        }
      } catch (e) {
        if (e instanceof DepositApiError && FINAL_ERRORS.has(e.code)) throw e
        // transient (network / chain lookup): keep polling
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!cancelled.current) setPhase({ kind: 'delayed' })
  }

  async function pay() {
    if (!wallet.connected) {
      haptic.tap()
      wallet.connect()
      return
    }
    if (usd === null || busyRef.current) return
    busyRef.current = true
    haptic.tap()
    try {
      setPhase({ kind: 'creating' })
      const intent = await createDeposit(session, { amountUsd: usd, asset })
      track('deposit_started', { asset, amount_usd: usd })

      if (wallet.isMock) {
        setPhase({ kind: 'mock_awaiting', intent })
        return
      }

      // The wallet shows recipient, amount and comment; the memo ties the payment to this deposit.
      const request = buildTransactionRequest(intent)
      setPhase({ kind: 'signing', intent })
      try {
        await wallet.send(request)
      } catch (e) {
        const rejected = e instanceof Error && /reject|cancel|declin/i.test(`${e.name} ${e.message}`)
        throw new DepositApiError('server', rejected ? tr('Payment cancelled in your wallet. Nothing was charged.') : tr('The wallet could not send the transaction. Nothing was charged.'))
      }
      // Signing is NOT proof of payment: ask the server to confirm it on chain.
      await pollForCredit(intent)
    } catch (e) {
      haptic.error()
      setPhase({ kind: 'error', message: e instanceof DepositApiError ? tm(e.message) : t('Something went wrong. Please try again.') })
    } finally {
      busyRef.current = false
    }
  }

  async function simulate(intent: DepositIntent) {
    haptic.tap()
    setPhase({ kind: 'verifying', intent })
    await sleep(700) // let the step indicator show the verification step
    try {
      const r = simulateMockPayment(session, intent.depositId)
      if (r.wallet) applyWallet(r.wallet)
      await credited(intent, r.wallet?.balance ?? 0)
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'Simulation failed.' })
    }
  }

  const ctaLabel =
    phase.kind === 'creating' ? t('Preparing payment…')
    : phase.kind === 'signing' ? t('Confirm in your wallet…')
    : phase.kind === 'verifying' ? t('Verifying on TON…')
    : !wallet.connected ? t('Connect Tonkeeper to Pay')
    : t('Pay with Tonkeeper')

  const inFlight = phase.kind === 'signing' || phase.kind === 'verifying' || phase.kind === 'mock_awaiting' || phase.kind === 'credited' || phase.kind === 'delayed'

  return (
    <div className="absolute inset-0 z-50 flex items-end animate-fade-in" role="dialog" aria-modal="true" aria-label={t('Top up balance')}>
      <button type="button" aria-label={t('Close')} onClick={() => !busy && onClose()} className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />

      <div className="relative z-10 max-h-[94%] w-full animate-sheet-up overflow-y-auto rounded-t-[32px] bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_40px_rgb(0,136,204,0.14)]">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-blue-100" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-content-primary">{t('Top up balance')}</h2>
          <button type="button" onClick={onClose} aria-label={t('Close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sub text-content-secondary active:scale-90">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {inFlight && phase.kind !== 'credited' && phase.kind !== 'delayed' && <Steps phase={phase.kind} />}

        {phase.kind === 'credited' && (
          <div className="py-2 text-center" role="status">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 size={32} strokeWidth={1.75} /></span>
            <h3 className="mt-4 text-xl font-extrabold text-content-primary">{t('Balance credited!')}</h3>
            <p className="mt-1 text-sm text-content-secondary">{t('+{amount} added.', { amount: formatMoneyAmount(phase.amountUsd) })} {t('New balance')}: <b className="text-content-primary">{formatMoneyAmount(phase.balance)}</b></p>
            <Button className="mt-5 h-14 w-full" onClick={onClose}>{t('Done')}</Button>
          </div>
        )}

        {phase.kind === 'delayed' && (
          <div className="py-2 text-center" role="status">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 text-amber-600"><Loader2 size={30} strokeWidth={1.75} className="animate-spin" /></span>
            <h3 className="mt-4 text-xl font-extrabold text-content-primary">{t('Still confirming')}</h3>
            <p className="mx-auto mt-1 max-w-xs text-sm text-content-secondary">{t("We haven't seen your payment on the TON network yet. It can take a few minutes: your balance is credited automatically once it confirms. You can close this.")}</p>
            <Button className="mt-5 h-14 w-full" onClick={onClose}>{t('Close')}</Button>
          </div>
        )}

        {phase.kind === 'mock_awaiting' && (
          <div className="mt-1 rounded-3xl border border-dashed border-brand/40 bg-brand-light/50 p-4 text-center">
            <FlaskConical size={22} strokeWidth={1.75} className="mx-auto text-brand" />
            <p className="mt-2 text-sm font-bold text-content-primary">Dev mode: payment "sent"</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-content-secondary">
              Pay {trimCrypto(phase.intent.amountCrypto)} TON with comment <span className="font-mono">{phase.intent.memo.slice(0, 12)}…</span> on a real network, or simulate the confirmation.
            </p>
            <Button className="mt-3 h-12 w-full" onClick={() => void simulate(phase.intent)}>Simulate Instant Payment</Button>
          </div>
        )}

        {(phase.kind === 'form' || phase.kind === 'creating' || phase.kind === 'error') && (
          <>
            <p className="mb-2 text-sm font-bold text-content-primary">{t('Amount (USD)')}</p>
            <div className="flex flex-wrap gap-2">
              {DEPOSIT_PRESETS_USD.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={busy}
                  onClick={() => { haptic.select(); setAmountText(String(p)); if (phase.kind === 'error') setPhase({ kind: 'form' }) }}
                  className={cn('rounded-full px-4 py-2 text-sm font-semibold transition-colors active:scale-95', parsed === p ? 'bg-brand text-white shadow-sm' : 'bg-surface-sub text-content-secondary hover:text-content-primary')}
                >
                  +${p}
                </button>
              ))}
            </div>

            <label className="mt-3 block">
              <input
                type="text"
                inputMode="decimal"
                placeholder={t('Custom amount ({min}-{max})', { min: MIN_DEPOSIT_USD, max: MAX_DEPOSIT_USD })}
                value={amountText}
                disabled={busy}
                onChange={(e) => { setAmountText(e.target.value.replace(/[^\d.]/g, '').slice(0, 9)); if (phase.kind === 'error') setPhase({ kind: 'form' }) }}
                aria-invalid={amountError !== null}
                className={cn('w-full rounded-2xl border bg-surface-sub px-4 py-3.5 text-[15px] font-medium outline-none transition-colors placeholder:text-content-muted focus:bg-white', amountError ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')}
              />
              {amountError && <p className="mt-1.5 text-xs font-medium text-rose-500">{tm(amountError)}</p>}
            </label>

            <p className="mb-2 mt-4 text-sm font-bold text-content-primary">{t('Pay with')}</p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('Asset')}>
              <AssetOption label="TON" selected={asset === 'TON'} onSelect={() => setAsset('TON')} />
              <AssetOption label="USDT (TON)" selected={false} disabled badge={t('Soon')} onSelect={() => {}} />
            </div>

            <div className="mt-4 rounded-3xl border border-blue-100/70 bg-surface-sub p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('You pay (estimated)')}</p>
              {quote ? (
                <>
                  <p className="mt-1 text-3xl font-extrabold tracking-tight text-content-primary">{trimCrypto(quote.amountCrypto)} <span className="text-lg">TON</span></p>
                  <p className="mt-0.5 text-xs font-medium text-content-secondary">{t('1 TON ≈ {rate} · you get {credit} credit', { rate: `$${quote.rateUsd.toFixed(2)}`, credit: formatMoneyAmount(quote.amountUsd) })}</p>
                  {quote.network === 'testnet' && <p className="mt-1 text-xs font-semibold text-amber-600">{t('Testnet: no real funds')}</p>}
                </>
              ) : quoteError ? (
                <p className="mt-1 text-sm font-medium text-rose-500">{quoteError}</p>
              ) : (
                <p className="mt-1 text-sm font-medium text-content-muted">{usd === null ? t('Enter an amount to see the price.') : t('Getting the live rate…')}</p>
              )}
            </div>

            {phase.kind === 'error' && (
              <div className="mt-4 flex gap-2.5 rounded-2xl bg-rose-50 p-3.5 text-[13px] font-medium text-rose-700" role="alert">
                <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <p>{phase.message}</p>
              </div>
            )}

            <Button
              className={cn('mt-5 h-14 w-full text-[15px]', (usd === null || !quote || busy) && wallet.connected && 'cursor-not-allowed opacity-60 hover:bg-brand')}
              disabled={busy || (wallet.connected && (usd === null || !quote))}
              aria-busy={busy}
              onClick={() => void pay()}
            >
              {busy && <Loader2 size={18} strokeWidth={2} className="animate-spin" />}
              {ctaLabel}
            </Button>
            <p className="mt-2 text-center text-[11px] text-content-muted">{t('Your balance is credited only after the payment is confirmed on the TON network.')}</p>
          </>
        )}
      </div>
    </div>
  )
}

function AssetOption({ label, selected, disabled, badge, onSelect }: { label: string; selected: boolean; disabled?: boolean; badge?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => { haptic.select(); onSelect() }}
      className={cn(
        'flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-sm font-bold transition-all active:scale-95',
        selected ? 'border-brand bg-brand-light text-brand-text' : 'border-blue-100/70 bg-white text-content-secondary',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {label}
      {badge && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{badge}</span>}
    </button>
  )
}

const STEPS = [tr('Signed'), tr('Verifying on TON'), tr('Credited')]

function Steps({ phase }: { phase: Phase['kind'] }) {
  const t = useT()
  // index of the step currently in progress
  const active = phase === 'signing' ? 0 : phase === 'verifying' ? 1 : phase === 'mock_awaiting' ? 1 : 2
  return (
    <ol className="mb-4 flex items-center justify-between rounded-3xl border border-blue-100/70 bg-surface-sub px-4 py-3" aria-label={t('Payment progress')}>
      {STEPS.map((label, i) => {
        const done = i < active
        const current = i === active
        return (
          <li key={label} className="flex flex-1 flex-col items-center gap-1.5 text-center">
            <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors', done ? 'bg-emerald-500 text-white' : current ? 'bg-brand text-white' : 'bg-blue-100 text-content-muted')}>
              {done ? <Check size={14} strokeWidth={3} /> : current && phase !== 'mock_awaiting' ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : i + 1}
            </span>
            <span className={cn('text-[11px] font-semibold', done || current ? 'text-content-primary' : 'text-content-muted')}>{t(label)}</span>
          </li>
        )
      })}
    </ol>
  )
}
