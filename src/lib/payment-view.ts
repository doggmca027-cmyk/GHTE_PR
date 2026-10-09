// Pure helpers for the provider payment screens (Admin -> Treasury, Providers). The database enforces every rule;
// these only decide which buttons and warnings to show.
import { parseTonAddress, tonAddressFlags } from '../../supabase/functions/_shared/ton.ts'
import { parseAmount } from '@/lib/admin-view'
import type { PaymentAdvanceTarget, PayoutAsset, PayoutNetwork, ProviderPaymentStatus, ProviderPayoutInput } from '@/types/admin'

export const PAYMENT_STATUSES: readonly ProviderPaymentStatus[] = [
  'PROPOSED', 'APPROVED', 'VALIDATED', 'PAYMENT_CREATED', 'BROADCASTED', 'CONFIRMING', 'CONFIRMED',
  'PROVIDER_BALANCE_VERIFIED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'CANCELED',
]

/** Mirror of public.is_valid_provider_payment_transition (a test compares both on every pair). */
export const PAYMENT_TRANSITIONS: Record<ProviderPaymentStatus, readonly ProviderPaymentStatus[]> = {
  PROPOSED: ['APPROVED', 'CANCELED'],
  APPROVED: ['VALIDATED', 'FAILED', 'CANCELED'],
  VALIDATED: ['PAYMENT_CREATED', 'FAILED', 'CANCELED'],
  PAYMENT_CREATED: ['BROADCASTED', 'FAILED', 'UNKNOWN', 'CANCELED'],
  BROADCASTED: ['CONFIRMING', 'FAILED', 'UNKNOWN'],
  CONFIRMING: ['CONFIRMED', 'FAILED', 'UNKNOWN'],
  CONFIRMED: ['PROVIDER_BALANCE_VERIFIED', 'RECONCILIATION_REQUIRED'],
  PROVIDER_BALANCE_VERIFIED: ['COMPLETED'],
  UNKNOWN: ['RECONCILIATION_REQUIRED'],
  RECONCILIATION_REQUIRED: ['BROADCASTED', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELED: [],
}

export type PaymentTone = 'neutral' | 'progress' | 'action' | 'ok' | 'warn' | 'bad'

export const PAYMENT_STATUS: Record<ProviderPaymentStatus, { label: string; tone: PaymentTone }> = {
  PROPOSED: { label: 'Предложен', tone: 'neutral' },
  APPROVED: { label: 'Одобрен', tone: 'neutral' },
  VALIDATED: { label: 'Проверен', tone: 'action' },
  PAYMENT_CREATED: { label: 'Готов к отправке', tone: 'action' },
  BROADCASTED: { label: 'Отправлен в сеть', tone: 'progress' },
  CONFIRMING: { label: 'Подтверждается', tone: 'progress' },
  CONFIRMED: { label: 'Подтверждён в сети', tone: 'progress' },
  PROVIDER_BALANCE_VERIFIED: { label: 'Баланс проверен', tone: 'progress' },
  COMPLETED: { label: 'Завершён', tone: 'ok' },
  FAILED: { label: 'Неудачен', tone: 'bad' },
  UNKNOWN: { label: 'Результат неизвестен', tone: 'warn' },
  RECONCILIATION_REQUIRED: { label: 'Нужна сверка', tone: 'warn' },
  CANCELED: { label: 'Отменён', tone: 'neutral' },
}

export const isPaymentOpen = (status: ProviderPaymentStatus): boolean => PAYMENT_TRANSITIONS[status].length > 0

/** What confirming each manual step asserts (shown before the second tap). */
export const ADVANCE_STEP: Record<PaymentAdvanceTarget, { label: string; assert: string }> = {
  CONFIRMING: { label: 'Отметить «Подтверждается»', assert: 'Транзакция видна в сети и ждёт подтверждений.' },
  CONFIRMED: { label: 'Отметить «Подтверждён»', assert: 'Транзакция окончательно подтверждена в сети (проверено в обозревателе).' },
  PROVIDER_BALANCE_VERIFIED: { label: 'Баланс проверен', assert: 'Вы проверили панель провайдера: его баланс вырос примерно на оплаченную сумму.' },
  COMPLETED: { label: 'Завершить', assert: 'Закрывает платёж: деньги у провайдера.' },
}

/** The next step of the happy path an admin can confirm by hand, if any. */
export function nextPaymentStep(p: { status: ProviderPaymentStatus; txHash: string | null }): PaymentAdvanceTarget | null {
  switch (p.status) {
    case 'BROADCASTED': return 'CONFIRMING'
    case 'CONFIRMING': return 'CONFIRMED'
    case 'CONFIRMED': return 'PROVIDER_BALANCE_VERIFIED'
    case 'PROVIDER_BALANCE_VERIFIED': return 'COMPLETED'
    case 'RECONCILIATION_REQUIRED': return p.txHash ? 'COMPLETED' : null // without a hash: record the broadcast first
    default: return null
  }
}

export type PaymentOp = 'create_instruction' | 'record_broadcast' | 'advance' | 'fail' | 'cancel'

/**
 * Buttons per state, all valid transitions of the state machine:
 *   before anything is sent        -> Cancel (money back to the treasury)
 *   sent, outcome not final        -> Mark as Failed (money back) only alongside the way forward
 *   confirmed on chain             -> forward only: the money has left, it can no longer "fail"
 */
export function paymentOps(p: { status: ProviderPaymentStatus; txHash: string | null }): PaymentOp[] {
  switch (p.status) {
    case 'VALIDATED': return ['create_instruction', 'cancel']
    case 'PAYMENT_CREATED': return ['record_broadcast', 'cancel']
    case 'BROADCASTED':
    case 'CONFIRMING': return ['advance', 'fail']
    case 'CONFIRMED':
    case 'PROVIDER_BALANCE_VERIFIED': return ['advance']
    case 'RECONCILIATION_REQUIRED': return p.txHash ? ['advance', 'fail'] : ['record_broadcast', 'fail']
    default: return []
  }
}

/** Headline + detail for a reconciliation reason written by the payment detector (provider_payment_issue). */
export function describePaymentIssue(reason: string): { title: string; detail: string } {
  if (reason.startsWith('outcome unknown:')) return { title: 'Результат платежа неизвестен', detail: reason.replace(/^outcome unknown:\s*/, '') || 'Причина не записана.' }
  if (reason.startsWith('Stuck in')) return { title: 'Платёж завис', detail: reason }
  if (reason.includes('did not rise in proportion')) return { title: 'Баланс провайдера не пополнился', detail: reason }
  if (reason.startsWith('Confirmed on chain')) return { title: 'Подтверждён, но не завершён', detail: reason }
  return { title: 'Платёж провайдеру требует внимания', detail: reason }
}

/** "EQDtFp…p4q2" */
export function shortId(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}

// ---------------------------------------------------------------------------
// Payout configuration form
// ---------------------------------------------------------------------------

export interface PayoutDraft {
  wallet: string
  network: PayoutNetwork
  asset: PayoutAsset
  maxPerTx: string
  maxDaily: string
}

export interface PayoutCheck {
  /** null while a field is invalid. */
  input: ProviderPayoutInput | null
  errors: { wallet?: string; maxPerTx?: string; maxDaily?: string }
  /** Top-ups to this provider will be refused until the wallet and both limits are set (fail closed). */
  incomplete: boolean
}

/** Same rules as admin_set_provider_payout (which re-checks everything, including the address checksum). */
export function checkPayoutDraft(d: PayoutDraft): PayoutCheck {
  const errors: PayoutCheck['errors'] = {}
  const wallet = d.wallet.trim()
  if (wallet !== '') {
    try {
      parseTonAddress(wallet)
      if (d.network === 'mainnet' && tonAddressFlags(wallet)?.testOnly) errors.wallet = 'Это адрес только для тестовой сети, а выбрана основная сеть (mainnet).'
    } catch {
      errors.wallet = 'Это не адрес TON: используйте 0:<64 hex> или EQ…/UQ… (48 символов, скопированных полностью).'
    }
  }
  const limit = (text: string, key: 'maxPerTx' | 'maxDaily'): number | null => {
    if (text.trim() === '') return null
    const n = parseAmount(text)
    if (n === null || n <= 0 || n >= 1_000_000_000) {
      errors[key] = 'Введите сумму больше 0.'
      return null
    }
    return n
  }
  const maxPerTx = limit(d.maxPerTx, 'maxPerTx')
  const maxDaily = limit(d.maxDaily, 'maxDaily')
  if (maxPerTx !== null && maxDaily !== null && maxDaily < maxPerTx) errors.maxDaily = 'Дневной лимит не может быть меньше лимита на одно пополнение.'
  const ok = Object.keys(errors).length === 0
  return {
    input: ok ? { wallet: wallet === '' ? null : wallet, network: d.network, asset: d.asset, maxTopupPerTx: maxPerTx, maxDailyTopup: maxDaily } : null,
    errors,
    incomplete: wallet === '' || maxPerTx === null || maxDaily === null,
  }
}

/** True when the saved payout config differs from the form's result. */
export function payoutChanged(saved: ProviderPayoutInput, next: ProviderPayoutInput): boolean {
  return saved.wallet !== next.wallet || saved.network !== next.network || saved.asset !== next.asset
    || saved.maxTopupPerTx !== next.maxTopupPerTx || saved.maxDailyTopup !== next.maxDailyTopup
}
