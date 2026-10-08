import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { mapTreasuryError, parseTreasuryRequest, paymentView } from '../supabase/functions/_shared/admin-treasury.ts'
import { mapReconError } from '../supabase/functions/_shared/reconciliation.ts'
import {
  detectPaymentIssue,
  evidenceFromRow,
  reconMoney,
  reconUtc,
  type PaymentEvidence,
} from '../supabase/functions/_shared/reconciliation-detectors.ts'
import { parseTonAddress, tonAddressFlags } from '../supabase/functions/_shared/ton.ts'
import {
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  checkPayoutDraft,
  describePaymentIssue,
  isPaymentOpen,
  nextPaymentStep,
  paymentOps,
  payoutChanged,
} from '../src/lib/payment-view'
import { AdminApiError } from '../src/services/api/mock-admin'
import { createMockProviders } from '../src/services/api/mock-providers'
import { createMockTreasury } from '../src/services/api/mock-treasury'
import type { ProviderConfigView, ProviderPayment, ProviderPaymentStatus, ReconCase } from '../src/types/admin'

const PID = '11111111-1111-4111-8111-111111111111'
const MIN = 60_000
const NOW = Date.parse('2026-10-07T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

// TON user-friendly addresses built from scratch (tag, workchain, hash, CRC16-XMODEM), so tests never depend on real wallets.
function crc16(bytes: Uint8Array): number {
  let crc = 0
  for (const b of bytes) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}
function friendly(tag: number, hashByte: number, opts: { corrupt?: boolean; workchain?: number } = {}): string {
  const b = new Uint8Array(36)
  b[0] = tag
  b[1] = (opts.workchain ?? 0) & 0xff
  b.fill(hashByte, 2, 34)
  const crc = crc16(b.subarray(0, 34))
  b[34] = crc >> 8
  b[35] = crc & 0xff
  if (opts.corrupt) b[35] ^= 1
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}
const MAINNET_BOUNCEABLE = friendly(0x11, 0x5a) // EQ…
const MAINNET_PLAIN = friendly(0x51, 0x5a) //      UQ…
const TESTNET_ONLY = friendly(0xd1, 0x5a) //       0Q…
const BAD_CHECKSUM = friendly(0x51, 0x5a, { corrupt: true })
const RAW = `0:${'ab'.repeat(32)}`

// ---------------------------------------------------------------------------
// 1. The detector (pure TypeScript)
// ---------------------------------------------------------------------------

function evidence(over: Partial<PaymentEvidence>): PaymentEvidence {
  return {
    status: 'CONFIRMED', amount: 50, currency: 'USD', failureReason: null, broadcastedAt: ago(60 * MIN), confirmedAt: ago(45 * MIN),
    updatedAt: ago(45 * MIN), providerBalanceBefore: 100, providerBalance: 100, providerCurrency: 'USD', providerBalanceSyncedAt: ago(MIN),
    spentSince: 0, ...over,
  }
}

describe('reconciliation detector (TypeScript)', () => {
  it('formats money and time exactly like the SQL helpers', () => {
    expect([reconMoney(12.3), reconMoney(-1.05), reconMoney(4, true), reconMoney(-0.004, true), reconMoney(-0.005), reconMoney(1.005, true), reconMoney(1234567.891)])
      .toEqual(['$12.30', '-$1.05', '+$4.00', '+$0.00', '-$0.01', '+$1.01', '$1234567.89'])
    expect(reconUtc('2026-10-07T12:00:59.999999+02:00')).toBe('2026-10-07 10:00 UTC')
  })

  it('leaves healthy and young payments alone', () => {
    for (const status of ['PROPOSED', 'APPROVED', 'VALIDATED', 'PAYMENT_CREATED', 'PROVIDER_BALANCE_VERIFIED', 'COMPLETED', 'FAILED', 'CANCELED']) {
      expect(detectPaymentIssue(evidence({ status, confirmedAt: ago(10 * 3600_000), broadcastedAt: ago(10 * 3600_000) }), NOW)).toBeNull()
    }
    expect(detectPaymentIssue(evidence({ confirmedAt: ago(29 * MIN) }), NOW)).toBeNull() // CONFIRMED, under 30 min
    expect(detectPaymentIssue(evidence({ status: 'BROADCASTED', broadcastedAt: ago(3.9 * 3600_000) }), NOW)).toBeNull()
  })

  it('Rule B: BROADCASTED or CONFIRMING for over 4 hours since the broadcast', () => {
    const b = detectPaymentIssue(evidence({ status: 'BROADCASTED', broadcastedAt: '2026-10-07T07:30:00Z' }), NOW)
    expect(b).toEqual({
      rule: 'stuck_in_limbo',
      reason: 'Stuck in BROADCASTED for over 4 h: broadcast recorded at 2026-10-07 07:30 UTC and never confirmed on chain. Check the transaction in an explorer, then advance the payment or mark it failed.',
    })
    // moving to CONFIRMING does not reset the clock: it counts from the broadcast
    expect(detectPaymentIssue(evidence({ status: 'CONFIRMING', broadcastedAt: ago(5 * 3600_000), updatedAt: ago(MIN) }), NOW)?.rule).toBe('stuck_in_limbo')
  })

  it('Rule A: confirmed for over 30 minutes, provider balance NOT credited in proportion (orders since added back)', () => {
    const r = detectPaymentIssue(evidence({ confirmedAt: '2026-10-07T11:15:00Z', providerBalanceBefore: 100, providerBalance: 103.2, spentSince: 1.8 }), NOW)
    expect(r).toEqual({
      rule: 'confirmed_not_completed',
      verdict: 'not_credited',
      reason: 'Confirmed on chain at 2026-10-07 11:15 UTC but not completed after 30 min, and the provider balance did not rise in proportion: +$5.00 of the $50.00 paid (balance $100.00 -> $103.20, orders since $1.80).',
    })
  })

  it('Rule A: still opened when the balance did rise (never auto-completed), with a different verdict', () => {
    const r = detectPaymentIssue(evidence({ providerBalance: 145, spentSince: 3 }), NOW) // +48 of 50
    expect(r).toMatchObject({ rule: 'confirmed_not_completed', verdict: 'credited' })
    expect(r!.reason).toContain('The provider balance rose in proportion (+$48.00 of the $50.00 paid): verify it and complete the payment.')
  })

  it('Rule A: 90% is the line, compared exactly (no float rounding)', () => {
    expect(detectPaymentIssue(evidence({ providerBalance: 145 }), NOW)?.verdict).toBe('credited') // exactly 90%
    expect(detectPaymentIssue(evidence({ providerBalance: 144.9999 }), NOW)?.verdict).toBe('not_credited')
    expect(detectPaymentIssue(evidence({ amount: 0.3, providerBalanceBefore: 0.1, providerBalance: 0.37 }), NOW)?.verdict).toBe('credited') // 0.27 = 90%
  })

  it('Rule A: says when the credit cannot be checked, and why', () => {
    const why = (over: Partial<PaymentEvidence>) => /\((.*)\): compare/.exec(detectPaymentIssue(evidence(over), NOW)!.reason)?.[1]
    expect(why({ providerBalanceBefore: null })).toBe('no balance reading before the transfer')
    expect(why({ providerCurrency: 'EUR' })).toBe('provider balance in EUR, payment in USD')
    expect(why({ providerBalanceSyncedAt: null })).toBe('balance not read since the confirmation')
    expect(why({ providerBalanceSyncedAt: ago(50 * MIN) })).toBe('balance not read since the confirmation')
    expect(detectPaymentIssue(evidence({ providerBalanceBefore: null }), NOW)?.verdict).toBe('unverifiable')
  })

  it('UNKNOWN / RECONCILIATION_REQUIRED always need a human', () => {
    expect(detectPaymentIssue(evidence({ status: 'RECONCILIATION_REQUIRED', failureReason: 'timeout after send' }), NOW))
      .toEqual({ rule: 'outcome_unknown', reason: 'outcome unknown: timeout after send' })
    expect(detectPaymentIssue(evidence({ status: 'UNKNOWN', failureReason: null }), NOW)?.reason).toBe('outcome unknown: ')
  })

  it('maps a list_provider_payments row', () => {
    const ev = evidenceFromRow({ status: 'CONFIRMED', amount: 50, currency: 'USD', failure_reason: null, broadcasted_at: null, confirmed_at: ago(MIN), updated_at: ago(MIN),
      provider_balance_before: null, provider_balance: 7.5, provider_currency: 'USD', provider_balance_synced_at: null, spent_since: 0 })
    expect(ev).toMatchObject({ providerBalanceBefore: null, providerBalance: 7.5, confirmedAt: ago(MIN), spentSince: 0 })
  })
})

// ---------------------------------------------------------------------------
// 2. Edge Function helpers
// ---------------------------------------------------------------------------

describe('admin-treasury / admin-reconciliation helpers', () => {
  it('parses CREATE_INSTRUCTION and the optional markConfirming flag strictly', () => {
    expect(parseTreasuryRequest({ action: 'CREATE_INSTRUCTION', paymentId: PID })).toEqual({ action: 'CREATE_INSTRUCTION', paymentId: PID })
    expect(parseTreasuryRequest({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'abc', markConfirming: true })).toEqual({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'abc', markConfirming: true })
    expect(parseTreasuryRequest({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'abc', markConfirming: false })).toEqual({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'abc' })
    expect(parseTreasuryRequest({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: PID, txHash: 'abc', markConfirming: 'yes' })).toHaveProperty('error')
    expect(parseTreasuryRequest({ action: 'CREATE_INSTRUCTION', paymentId: 'x' })).toHaveProperty('error')
    // the client still cannot pick where money goes
    expect(parseTreasuryRequest({ action: 'CREATE_INSTRUCTION', paymentId: PID, destinationWallet: RAW })).not.toHaveProperty('destinationWallet')
  })

  it('maps the new database errors', () => {
    expect(mapTreasuryError('a payment cannot complete without a transaction hash')).toMatchObject({ status: 409, error: 'tx_hash_required' })
    expect(mapTreasuryError('the transaction hash is required')).toMatchObject({ status: 400 })
    const m = mapReconError('payment_unresolved: the payment is CONFIRMED and still needs a decision')
    expect(m).toMatchObject({ status: 409, error: 'payment_unresolved' })
    expect(m.message).toContain('(CONFIRMED)')
  })

  it('paymentView carries the live detector verdict', () => {
    const v = paymentView({ id: PID, provider_id: PID, provider_name: 'P1', amount: 50, currency: 'USD', asset: 'TON', network: 'mainnet', destination_wallet: RAW,
      tx_hash: 'T', status: 'BROADCASTED', failure_reason: null, treasury_reversed: false, created_at: ago(6 * 3600_000), updated_at: ago(6 * 3600_000),
      broadcasted_at: ago(5 * 3600_000), confirmed_at: null, completed_at: null, open_case_id: null, provider_balance_before: 10, provider_balance: 10,
      provider_currency: 'USD', provider_balance_synced_at: null, spent_since: 0 }, NOW)
    expect(v).toMatchObject({ providerName: 'P1', txHash: 'T', status: 'BROADCASTED', openCaseId: null, issue: { rule: 'stuck_in_limbo' } })
  })
})

// ---------------------------------------------------------------------------
// 3. UI helpers, payout form, dev mocks
// ---------------------------------------------------------------------------

describe('payment screen helpers', () => {
  it('offers only valid next steps; a payment confirmed on chain can no longer be failed or canceled', () => {
    const ops = (status: ProviderPaymentStatus, txHash: string | null = null) => paymentOps({ status, txHash })
    expect(ops('VALIDATED')).toEqual(['create_instruction', 'cancel'])
    expect(ops('PAYMENT_CREATED')).toEqual(['record_broadcast', 'cancel'])
    expect(ops('BROADCASTED', 'T')).toEqual(['advance', 'fail'])
    expect(ops('CONFIRMED', 'T')).toEqual(['advance'])
    expect(ops('RECONCILIATION_REQUIRED')).toEqual(['record_broadcast', 'fail'])
    expect(ops('RECONCILIATION_REQUIRED', 'T')).toEqual(['advance', 'fail'])
    for (const s of ['COMPLETED', 'FAILED', 'CANCELED'] as const) expect(ops(s, 'T')).toEqual([])
    // every button maps to an allowed transition
    const target: Record<string, (s: ProviderPaymentStatus, tx: string | null) => ProviderPaymentStatus | null> = {
      create_instruction: () => 'PAYMENT_CREATED', record_broadcast: () => 'BROADCASTED', fail: () => 'FAILED', cancel: () => 'CANCELED',
      advance: (s, tx) => nextPaymentStep({ status: s, txHash: tx }),
    }
    for (const s of PAYMENT_STATUSES) for (const tx of [null, 'T']) for (const op of paymentOps({ status: s, txHash: tx })) {
      const to = target[op](s, tx)
      expect(to && PAYMENT_TRANSITIONS[s].includes(to), `${s} --${op}--> ${to}`).toBe(true)
    }
    expect(isPaymentOpen('CONFIRMED')).toBe(true)
    expect(isPaymentOpen('CANCELED')).toBe(false)
  })

  it('names each detector reason', () => {
    expect(describePaymentIssue('outcome unknown: timeout').title).toBe('Payment outcome unknown')
    expect(describePaymentIssue('outcome unknown: timeout').detail).toBe('timeout')
    expect(describePaymentIssue('Stuck in CONFIRMING for over 4 h: x').title).toBe('Payment stuck in limbo')
    expect(describePaymentIssue('Confirmed on chain at x but not completed after 30 min, and the provider balance did not rise in proportion: y').title).toBe('Provider balance not credited')
    expect(describePaymentIssue('Confirmed on chain at x but not completed after 30 min. The provider balance rose').title).toBe('Confirmed, not completed')
  })

  it('validates the payout form like the server: TON address with checksum, testnet-only never on mainnet, sane limits', () => {
    const d = { wallet: RAW, network: 'mainnet' as const, asset: 'TON' as const, maxPerTx: '50', maxDaily: '200' }
    expect(checkPayoutDraft(d)).toMatchObject({ input: { wallet: RAW, maxTopupPerTx: 50, maxDailyTopup: 200 }, errors: {}, incomplete: false })
    expect(checkPayoutDraft({ ...d, wallet: MAINNET_PLAIN }).errors).toEqual({})
    expect(checkPayoutDraft({ ...d, wallet: BAD_CHECKSUM }).errors.wallet).toMatch(/Not a valid TON address/)
    expect(checkPayoutDraft({ ...d, wallet: 'UQ-short' }).input).toBeNull()
    expect(checkPayoutDraft({ ...d, wallet: TESTNET_ONLY }).errors.wallet).toMatch(/testnet-only/)
    expect(checkPayoutDraft({ ...d, wallet: TESTNET_ONLY, network: 'testnet' }).errors).toEqual({})
    expect(checkPayoutDraft({ ...d, maxDaily: '20' }).errors.maxDaily).toMatch(/cannot be below/)
    expect(checkPayoutDraft({ ...d, maxPerTx: '0' }).errors.maxPerTx).toBeDefined()
    // clearing is allowed, it simply disables top-ups (fail closed)
    expect(checkPayoutDraft({ ...d, wallet: ' ', maxPerTx: '' })).toMatchObject({ input: { wallet: null, maxTopupPerTx: null }, incomplete: true })
    const saved = { wallet: RAW, network: 'mainnet' as const, asset: 'TON' as const, maxTopupPerTx: 50, maxDailyTopup: 200 }
    expect(payoutChanged(saved, checkPayoutDraft(d).input!)).toBe(false)
    expect(payoutChanged(saved, checkPayoutDraft({ ...d, asset: 'USDT' }).input!)).toBe(true)
  })

  it('dev mock: approving creates a payment to send, the reserve is enforced, fail returns the money once', () => {
    const m = createMockTreasury()
    const start = m.page(null)
    expect(start.minimumReserve).toBeGreaterThan(0)
    expect(start.payments.some((p) => p.issue?.verdict === 'not_credited')).toBe(true) // the demo shows Rule A
    m.decide(start.proposals[0].id, 'approve')
    const pay = m.page(null).payments.find((p) => p.status === 'PAYMENT_CREATED')!
    expect(pay.amount).toBe(start.proposals[0].amount)
    m.paymentAction({ action: 'RECORD_PAYMENT_BROADCAST', paymentId: pay.id, txHash: 'TX-A', markConfirming: true })
    expect(m.page(null).payments.find((p) => p.id === pay.id)).toMatchObject({ status: 'CONFIRMING', txHash: 'TX-A' })
    expect(() => m.paymentAction({ action: 'CANCEL_PAYMENT', paymentId: pay.id, reason: 'too late' })).toThrow(AdminApiError) // already sent
    const before = m.page(null).balance
    m.paymentAction({ action: 'FAIL_PAYMENT', paymentId: pay.id, reason: 'failed on chain' })
    expect(() => m.paymentAction({ action: 'FAIL_PAYMENT', paymentId: pay.id, reason: 'again' })).not.toThrow()
    expect(m.page(null).balance).toBe(Math.round((before + pay.amount) * 10_000) / 10_000)
    m.setReserve(10_000)
    expect(m.page(null).minimumReserve).toBe(10_000)
    expect(() => m.setReserve(-1)).toThrow(AdminApiError)
  })

  it('dev mock providers: payout config validated like the server', () => {
    const m = createMockProviders()
    const unconfigured = m.list().find((p) => p.payoutWallet === null)!
    expect(() => m.setPayout(unconfigured.id, { wallet: BAD_CHECKSUM, network: 'mainnet', asset: 'TON', maxTopupPerTx: 10, maxDailyTopup: 20 })).toThrow(AdminApiError)
    m.setPayout(unconfigured.id, { wallet: MAINNET_BOUNCEABLE, network: 'mainnet', asset: 'USDT', maxTopupPerTx: 10, maxDailyTopup: 20 })
    expect(m.list().find((p) => p.id === unconfigured.id)).toMatchObject({ payoutWallet: MAINNET_BOUNCEABLE, payoutAsset: 'USDT', maxTopupPerTx: 10, maxDailyTopup: 20 })
  })
})

// ---------------------------------------------------------------------------
// 4. The admin screens (server-rendered markup)
// ---------------------------------------------------------------------------

const html = async (el: () => Promise<Parameters<typeof import('react-dom/server').renderToStaticMarkup>[0]>) => (await import('react-dom/server')).renderToStaticMarkup(await el())
const basePayment = (over: Partial<ProviderPayment>): ProviderPayment => ({
  id: PID, providerId: PID, providerName: 'Secsers', amount: 50, currency: 'USD', asset: 'TON', network: 'mainnet', destinationWallet: RAW, txHash: null,
  status: 'PAYMENT_CREATED', failureReason: null, treasuryReversed: false, createdAt: ago(MIN), updatedAt: ago(MIN), broadcastedAt: null, confirmedAt: null,
  completedAt: null, openCaseId: null, issue: null, ...over,
})

describe('admin screens', () => {
  const card = async (p: ProviderPayment) => html(async () => {
    const { createElement } = await import('react')
    const { PaymentCard } = await import('../src/components/admin/PaymentsPanel')
    return createElement(PaymentCard, { payment: p, busy: false, error: null, onAdvance: () => {}, onCreateInstruction: () => {}, onDialog: () => {} })
  })

  it('PAYMENT_CREATED: shows the full server-side destination, Record Broadcast and Cancel', async () => {
    const out = await card(basePayment({}))
    expect(out).toContain(RAW)
    expect(out).toContain('Record Broadcast')
    expect(out).toContain('Cancel')
    expect(out).not.toContain('Mark as Failed')
  })

  it('BROADCASTED: Advance (Mark Confirming) and Mark as Failed; CONFIRMED: forward only', async () => {
    const b = await card(basePayment({ status: 'BROADCASTED', txHash: 'TXHASH-123456789' }))
    expect(b).toContain('Mark Confirming')
    expect(b).toContain('Mark as Failed')
    const c = await card(basePayment({ status: 'CONFIRMED', txHash: 'TX', confirmedAt: ago(40 * MIN) }))
    expect(c).toContain('Balance Verified')
    expect(c).not.toContain('Mark as Failed')
    expect(c).not.toContain('Cancel')
  })

  it('shows the detector verdict on the payment', async () => {
    const issue = detectPaymentIssue(evidence({ providerBalance: 100 }), NOW)
    const out = await card(basePayment({ status: 'CONFIRMED', txHash: 'TX', issue, openCaseId: PID }))
    expect(out).toContain('Provider balance not credited')
    expect(out).toContain('reconciliation case open')
    expect(out).toContain('did not rise in proportion')
  })

  it('Record Broadcast modal and the failure warning for a payment confirmed on chain', async () => {
    const rb = await html(async () => {
      const { createElement } = await import('react')
      const { RecordBroadcastModal } = await import('../src/components/admin/PaymentsPanel')
      return createElement(RecordBroadcastModal, { payment: basePayment({}), onClose: () => {}, onSubmit: async () => {} })
    })
    expect(rb).toContain('Transaction hash')
    expect(rb).toContain('mark it as Confirming too')
    const fail = await html(async () => {
      const { createElement } = await import('react')
      const { ReasonModal } = await import('../src/components/admin/PaymentsPanel')
      return createElement(ReasonModal, { payment: basePayment({ status: 'RECONCILIATION_REQUIRED', txHash: 'T', confirmedAt: ago(MIN) }), kind: 'fail', onClose: () => {}, onSubmit: async () => {} })
    })
    expect(fail).toContain('the money has left')
    expect(fail).toContain('returns to the treasury')
  })

  const provider: ProviderConfigView = {
    id: PID, name: 'Secsers', isActive: true, routingEnabled: true, health: 'healthy', lastHealthCheck: null, balance: 10, currency: 'USD', lastBalanceSync: null,
    lowBalanceThreshold: 10, targetTopupBalance: 100, lowBalanceAlerted: false, reliabilityPenalty: 1, payoutWallet: RAW, payoutNetwork: 'mainnet',
    payoutAsset: 'TON', maxTopupPerTx: 50, maxDailyTopup: 200, topupUsedToday: 30,
  }

  it('Edit Config modal: payout wallet, network, asset and both limits, prefilled', async () => {
    const out = await html(async () => {
      const { createElement } = await import('react')
      const { ConfigModal } = await import('../src/components/admin/ProvidersTab')
      return createElement(ConfigModal, { provider, onClose: () => {}, onSave: async () => {} })
    })
    for (const text of ['Allowed destination wallet (TON)', 'Network', 'Asset', 'Max per top-up (USD)', 'Max per day (USD)', RAW, 'mainnet', 'testnet', 'USDT', 'Used today: $30.00']) expect(out).toContain(text)
  })

  it('provider card: payout summary, or a warning that top-ups are refused', async () => {
    const render = (p: ProviderConfigView) => html(async () => {
      const { createElement } = await import('react')
      const { PayoutSummary } = await import('../src/components/admin/ProvidersTab')
      return createElement(PayoutSummary, { provider: p })
    })
    expect(await render(provider)).toContain('$50.00 per top-up · $200.00 per day · $30.00 used today')
    expect(await render({ ...provider, maxDailyTopup: null })).toContain('Payouts not configured')
  })

  it('treasury reserve modal', async () => {
    const out = await html(async () => {
      const { createElement } = await import('react')
      const { ReserveModal } = await import('../src/components/admin/TreasuryTab')
      return createElement(ReserveModal, { current: 25, balance: 100, onClose: () => {}, onSubmit: async () => {} })
    })
    expect(out).toContain('Minimum treasury reserve')
    expect(out).toContain('value="25"')
  })

  it('a provider_payment case shows the payment and where to decide it', async () => {
    const kase: ReconCase = {
      id: PID, entityType: 'provider_payment', entityId: PID, reason: 'Stuck in BROADCASTED for over 4 h: broadcast recorded at 2026-10-07 07:30 UTC and never confirmed on chain.',
      createdAt: ago(MIN), order: null,
      payment: { status: 'BROADCASTED', providerName: 'Secsers', amount: 50, currency: 'USD', asset: 'TON', network: 'mainnet', destinationWallet: RAW, txHash: 'TXHASH-123456789', broadcastedAt: ago(5 * 3600_000), confirmedAt: null, createdAt: ago(6 * 3600_000) },
    }
    const out = await html(async () => {
      const { createElement } = await import('react')
      const { CaseCard } = await import('../src/components/admin/ReconciliationTab')
      const session = { token: 't', isMock: true, user: { isAdmin: true } } as never
      return createElement(CaseCard, { kase, severity: 'high', session, onDone: () => {}, onFailed: () => {}, onOpenPayments: () => {} })
    })
    for (const text of ['Top-up of Secsers', 'Payment stuck in limbo', 'Open Payment', 'Mark Resolved', '$50.00']) expect(out).toContain(text)
    expect(out).not.toContain('Force Refund')
  })
})

// ---------------------------------------------------------------------------
// 5. The database (real migrations on PGlite)
// ---------------------------------------------------------------------------

describe('payment reconciliation (real SQL)', () => {
  let db: PGlite
  let admin: string, customer: string, service: string
  type R = Record<string, unknown>
  const one = async (sql: string, p: unknown[] = []) => (await db.query<{ r: R }>(sql, p)).rows[0]?.r
  const sync = () => one(`select sync_reconciliation_cases() r`)
  const openCase = async (id: string) => (await db.query<R>(`select * from reconciliation_cases where entity_type = 'provider_payment' and entity_id = $1 and status = 'open'`, [id])).rows[0]
  const casesOf = async (id: string) => (await db.query<R>(`select * from reconciliation_cases where entity_id = $1 order by created_at`, [id])).rows
  const statusOf = async (id: string) => (await db.query<{ s: string }>(`select status::text s from provider_payments where id = $1`, [id])).rows[0].s

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true),'')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;`)
    const dir = path.resolve(__dirname, '../supabase/migrations')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
    const q = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id
    admin = await q(`insert into users(telegram_id, is_admin) values (1, true) returning id`)
    customer = await q(`insert into users(telegram_id) values (2) returning id`)
    await db.exec(`
      insert into providers(name, api_url) values ('catalog', 'https://c');
      insert into categories(platform_id, name, slug) values ((select id from platforms where slug = 'telegram'), 'Views', 'v');
      insert into provider_services(provider_id, external_service_id, name, rate_per_1000, min_quantity, max_quantity)
        select id, '9', 's', 1, 1, 1000000 from providers;
      insert into services(category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity)
        select c.id, 'Views', ps.id, 10, 1, 1000000 from categories c, provider_services ps;
      select process_treasury_transaction('deposit', 100000);`)
    service = await q(`select id from services limit 1`)
  }, 120_000)

  /** A provider with a payout config; balance null = never read by the monitor. */
  async function newProvider(balance: number | null = 100, currency = 'USD') {
    return (await db.query<{ id: string }>(
      `insert into providers(name, api_url, currency, allowed_destination_wallet, max_topup_per_tx, max_daily_topup, provider_balance, last_balance_sync)
       values ('P-' || gen_random_uuid(), 'https://p', $1, $2, 1000, 100000, coalesce($3::numeric, 0), case when $3::numeric is null then null else now() end) returning id`,
      [currency, RAW, balance])).rows[0].id
  }
  const CHAIN: ProviderPaymentStatus[] = ['VALIDATED', 'PAYMENT_CREATED', 'BROADCASTED', 'CONFIRMING', 'CONFIRMED', 'PROVIDER_BALANCE_VERIFIED', 'COMPLETED']
  /** A payment walked through the real engine functions up to `to`. */
  async function newPayment(prov: string, amount: number, to: ProviderPaymentStatus) {
    const id = (await db.query<{ id: string }>(
      `insert into provider_payments(provider_id, amount, asset, network, destination_wallet, status, idempotency_key)
       select id, $2, payout_asset, payout_network, allowed_destination_wallet, 'PROPOSED', 'test:' || gen_random_uuid() from providers where id = $1 returning id`,
      [prov, amount])).rows[0].id
    await db.query(`update provider_payments set status = 'APPROVED' where id = $1`, [id])
    for (const s of CHAIN.slice(0, CHAIN.indexOf(to) + 1)) {
      if (s === 'VALIDATED') await one(`select validate_provider_payment($1::uuid, $2::uuid) r`, [id, admin])
      else if (s === 'PAYMENT_CREATED') await one(`select create_provider_payment_instruction($1::uuid) r`, [id])
      else if (s === 'BROADCASTED') await one(`select record_provider_payment_broadcast($1::uuid, $2) r`, [id, `TX-${id}`])
      else await one(`select advance_provider_payment($1::uuid, $2::provider_payment_status_enum) r`, [id, s])
    }
    return id
  }
  const backdate = (id: string, column: 'confirmed_at' | 'broadcasted_at', minutes: number) =>
    db.query(`update provider_payments set ${column} = now() - make_interval(mins => $2) where id = $1`, [id, minutes])
  const setBalance = (prov: string, balance: number, syncedMinutesAgo = 0) =>
    db.query(`update providers set provider_balance = $2, last_balance_sync = now() - make_interval(mins => $3) where id = $1`, [prov, balance, syncedMinutesAgo])
  async function order(prov: string, reservation: number) {
    await db.query(`insert into orders(user_id, service_id, target_url, quantity, charge_amount, cost_amount, provider_id, provider_reservation) values ($1, $2, 'https://t.me/x', 100, 1, $3, $4, $3)`,
      [customer, service, reservation, prov])
  }

  describe('evidence stamped by the database', () => {
    it('snapshots the provider balance when the transfer instruction is created, and when the payment was confirmed', async () => {
      const prov = await newProvider(100)
      const id = await newPayment(prov, 50, 'PAYMENT_CREATED')
      await setBalance(prov, 999) // later changes do not move the snapshot
      await one(`select record_provider_payment_broadcast($1::uuid, 'TX1') r`, [id])
      await one(`select advance_provider_payment($1::uuid, 'CONFIRMING') r`, [id])
      const before = (await db.query<R>(`select provider_balance_before::float8 b, provider_balance_before_at is not null s, confirmed_at from provider_payments where id = $1`, [id])).rows[0]
      expect(before).toMatchObject({ b: 100, s: true, confirmed_at: null })
      await one(`select advance_provider_payment($1::uuid, 'CONFIRMED') r`, [id])
      expect((await db.query<R>(`select confirmed_at is not null c from provider_payments where id = $1`, [id])).rows[0].c).toBe(true)
    })

    it('a provider balance that was never read is not a baseline', async () => {
      const prov = await newProvider(null)
      const id = await newPayment(prov, 50, 'PAYMENT_CREATED')
      expect((await db.query<R>(`select provider_balance_before b, provider_balance_before_at is not null s from provider_payments where id = $1`, [id])).rows[0]).toEqual({ b: null, s: true })
    })
  })

  describe('Rule A: confirmed on chain, provider balance not credited', () => {
    it('opens a provider_payment case after 30 minutes, with the discrepancy in the reason', async () => {
      const prov = await newProvider(100)
      const id = await newPayment(prov, 50, 'CONFIRMED')
      expect(await sync()).toMatchObject({ payments: { opened: 0 } }) // just confirmed
      await backdate(id, 'confirmed_at', 45)
      await setBalance(prov, 103.2)
      await order(prov, 1.8) // spent on orders since the snapshot: added back
      expect(await sync()).toMatchObject({ opened: 1, payments: { opened: 1 } })
      const c = (await openCase(id))!
      expect(c.entity_type).toBe('provider_payment')
      expect(c.reason).toMatch(/^Confirmed on chain at \d{4}-\d\d-\d\d \d\d:\d\d UTC but not completed after 30 min, and the provider balance did not rise in proportion: \+\$5\.00 of the \$50\.00 paid \(balance \$100\.00 -> \$103\.20, orders since \$1\.80\)\.$/)
    })

    it('keeps the wording current, never completes by itself, and closes when the admin advances the payment', async () => {
      const prov = await newProvider(100)
      const id = await newPayment(prov, 50, 'CONFIRMED')
      await backdate(id, 'confirmed_at', 45)
      await setBalance(prov, 100)
      await sync()
      await setBalance(prov, 149)
      expect(await sync()).toMatchObject({ payments: { opened: 0, updated: 1 } })
      expect((await openCase(id))!.reason).toContain('rose in proportion (+$49.00 of the $50.00 paid)')
      expect(await statusOf(id)).toBe('CONFIRMED') // a human still has to verify it
      expect(await sync()).toMatchObject({ payments: { opened: 0, updated: 0, closed: 0 } }) // idempotent
      await one(`select advance_provider_payment($1::uuid, 'PROVIDER_BALANCE_VERIFIED') r`, [id])
      expect(await sync()).toMatchObject({ closed: 1, payments: { closed: 1 } })
      expect((await casesOf(id))[0]).toMatchObject({ status: 'resolved', resolution: 'auto', resolution_note: 'No longer needs attention (payment PROVIDER_BALANCE_VERIFIED)' })
    })

    it('cannot be closed with Mark Resolved while the payment still needs a decision', async () => {
      const prov = await newProvider(100)
      const id = await newPayment(prov, 50, 'CONFIRMED')
      await backdate(id, 'confirmed_at', 45)
      await sync()
      const c = String((await openCase(id))!.id)
      await expect(one(`select resolve_case_manual($1::uuid, $2::uuid, 'looked at it') r`, [c, admin])).rejects.toThrow(/payment_unresolved: the payment is CONFIRMED/)
      for (const to of ['PROVIDER_BALANCE_VERIFIED', 'COMPLETED']) await one(`select advance_provider_payment($1::uuid, $2::provider_payment_status_enum) r`, [id, to])
      expect(await openCase(id)).toBeUndefined() // completing closed it
    })

    it('fix: a CONFIRMED payment can now be sent to reconciliation (no CONFIRMED -> UNKNOWN step)', async () => {
      const prov = await newProvider(100)
      const id = await newPayment(prov, 50, 'CONFIRMED')
      expect(await one(`select mark_provider_payment_unknown($1::uuid, 'confirmed on chain but the provider balance did not increase') r`, [id])).toMatchObject({ status: 'RECONCILIATION_REQUIRED' })
      expect((await openCase(id))!.reason).toBe('outcome unknown: confirmed on chain but the provider balance did not increase')
      expect(await sync()).toMatchObject({ payments: { opened: 0, updated: 0, closed: 0 } }) // the detector agrees with the wording
      // the money left on chain: it can still be completed once the provider credits it
      await one(`select advance_provider_payment($1::uuid, 'COMPLETED') r`, [id])
      expect(await openCase(id)).toBeUndefined()
    })
  })

  describe('Rule B: stuck in BROADCASTED / CONFIRMING', () => {
    it('opens a case after 4 hours since the broadcast, not before', async () => {
      const prov = await newProvider(100)
      const b = await newPayment(prov, 20, 'BROADCASTED')
      const c = await newPayment(prov, 30, 'CONFIRMING')
      const young = await newPayment(prov, 40, 'BROADCASTED')
      await backdate(b, 'broadcasted_at', 5 * 60)
      await backdate(c, 'broadcasted_at', 4 * 60 + 5)
      await backdate(young, 'broadcasted_at', 3 * 60)
      expect(await sync()).toMatchObject({ payments: { opened: 2 } })
      expect((await openCase(b))!.reason).toMatch(/^Stuck in BROADCASTED for over 4 h: broadcast recorded at .+ UTC and never confirmed on chain\./)
      expect((await openCase(c))!.reason).toMatch(/^Stuck in CONFIRMING for over 4 h/)
      expect(await openCase(young)).toBeUndefined()
    })

    it('marking it failed returns the money and closes the case; advancing to CONFIRMED closes it too', async () => {
      const prov = await newProvider(100)
      const a = await newPayment(prov, 20, 'BROADCASTED')
      const b = await newPayment(prov, 30, 'CONFIRMING')
      await backdate(a, 'broadcasted_at', 300)
      await backdate(b, 'broadcasted_at', 300)
      await sync()
      const t0 = Number((await db.query<{ b: string }>(`select balance::text b from treasury_state`)).rows[0].b)
      await one(`select fail_provider_payment($1::uuid, 'never confirmed on chain', $2::uuid) r`, [a, admin])
      expect(Number((await db.query<{ b: string }>(`select balance::text b from treasury_state`)).rows[0].b)).toBe(t0 + 20)
      expect((await casesOf(a))[0]).toMatchObject({ status: 'resolved', resolution: 'manual' })
      await one(`select advance_provider_payment($1::uuid, 'CONFIRMED') r`, [b])
      expect(await sync()).toMatchObject({ payments: { closed: 1 } })
      expect(await openCase(b)).toBeUndefined()
    })
  })

  it('a payment that needs reconciliation always has an open case (re-opened if closed by hand)', async () => {
    const prov = await newProvider(100)
    const id = await newPayment(prov, 25, 'PAYMENT_CREATED')
    await one(`select mark_provider_payment_unknown($1::uuid, 'timeout after send') r`, [id])
    await db.query(`update reconciliation_cases set status = 'resolved', resolution = 'manual', resolved_at = now() where entity_id = $1`, [id])
    expect(await sync()).toMatchObject({ payments: { opened: 1 } })
    expect((await openCase(id))!.reason).toBe('outcome unknown: timeout after send')
  })

  it('cases for entity ids that are not payments are left alone', async () => {
    await db.query(`insert into reconciliation_cases(entity_type, entity_id, reason) values ('provider_payment', 'tx-1', 'unmatched')`)
    expect(await sync()).toMatchObject({ payments: { closed: 0 } })
    expect((await db.query(`select 1 from reconciliation_cases where entity_id = 'tx-1' and status = 'open'`)).rows).toHaveLength(1)
  })

  it('lists cases with their payment, and payments with the detector evidence', async () => {
    const prov = await newProvider(100)
    const id = await newPayment(prov, 50, 'CONFIRMED')
    await backdate(id, 'confirmed_at', 45)
    const done = await newPayment(prov, 10, 'COMPLETED')
    await sync()
    const cases = (await one(`select list_reconciliation_cases() r`)) as unknown as R[]
    expect(cases[0]).toMatchObject({ entity_type: 'provider_payment', entity_id: id, order: null, payment: { status: 'CONFIRMED', amount: 50, asset: 'TON', network: 'mainnet', destination_wallet: RAW, tx_hash: `TX-${id}` } })
    const list = (await one(`select list_provider_payments(20) r`)) as unknown as R[]
    expect(list.map((r) => r.id)).toEqual([done, id]) // newest first
    expect(list[1]).toMatchObject({ provider_balance_before: 100, provider_balance: 100, spent_since: 0, open_case_id: cases[0].id })
    // payments still in progress are always listed, however many finished ones are newer
    expect(((await one(`select list_provider_payments(1) r`)) as unknown as R[]).map((r) => r.id)).toEqual([done, id])
  })

  it('SQL and TypeScript detectors agree on every scenario (rule, verdict and exact reason)', async () => {
    const scenarios: { name: string; make: () => Promise<string> }[] = [
      { name: 'A not credited', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 45); await setBalance(p, 103.2); await order(p, 1.8); return id } },
      { name: 'A credited', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 45); await setBalance(p, 148); return id } },
      { name: 'A exactly 90%', make: async () => { const p = await newProvider(10.0001); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 31); await setBalance(p, 55.0001); return id } },
      { name: 'A just below 90%', make: async () => { const p = await newProvider(10.0001); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 31); await setBalance(p, 55); return id } },
      { name: 'A odd amounts', make: async () => { const p = await newProvider(0.1); const id = await newPayment(p, 0.3, 'CONFIRMED'); await backdate(id, 'confirmed_at', 40); await setBalance(p, 0.37); await order(p, 0.0049); return id } },
      { name: 'A no snapshot', make: async () => { const p = await newProvider(null); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 45); await setBalance(p, 70); return id } },
      { name: 'A stale balance', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 45); await setBalance(p, 100, 50); return id } },
      { name: 'A other currency', make: async () => { const p = await newProvider(100, 'EUR'); const id = await newPayment(p, 50, 'CONFIRMED'); await backdate(id, 'confirmed_at', 45); return id } },
      { name: 'A too young', make: async () => { const p = await newProvider(100); return newPayment(p, 50, 'CONFIRMED') } },
      { name: 'B broadcasted', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'BROADCASTED'); await backdate(id, 'broadcasted_at', 300); return id } },
      { name: 'B confirming', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'CONFIRMING'); await backdate(id, 'broadcasted_at', 250); return id } },
      { name: 'B too young', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'BROADCASTED'); await backdate(id, 'broadcasted_at', 200); return id } },
      { name: 'unknown', make: async () => { const p = await newProvider(100); const id = await newPayment(p, 50, 'PAYMENT_CREATED'); await one(`select mark_provider_payment_unknown($1::uuid, 'lost connection after send') r`, [id]); return id } },
      { name: 'created', make: async () => newPayment(await newProvider(100), 50, 'PAYMENT_CREATED') },
      { name: 'completed', make: async () => newPayment(await newProvider(100), 50, 'COMPLETED') },
    ]
    const ids: string[] = []
    for (const s of scenarios) ids.push(await s.make())
    const now = new Date(Date.now() + 1000).toISOString()
    const rows = (await one(`select list_provider_payments(100) r`)) as unknown as R[]
    const seen = new Set<string>()
    for (const [i, id] of ids.entries()) {
      const sql = (await db.query<{ r: R | null }>(`select provider_payment_issue(p, $2::timestamptz) r from provider_payments p where id = $1`, [id, now])).rows[0].r
      const ts = detectPaymentIssue(evidenceFromRow(rows.find((r) => r.id === id)!), Date.parse(now))
      expect(ts, scenarios[i].name).toEqual(sql)
      seen.add(sql ? `${sql.rule}:${sql.verdict ?? ''}` : 'none')
    }
    expect([...seen].sort()).toEqual(['confirmed_not_completed:credited', 'confirmed_not_completed:not_credited', 'confirmed_not_completed:unverifiable', 'none', 'outcome_unknown:', 'stuck_in_limbo:'])
  })

  it('the state machine twin matches the database on every transition', async () => {
    const rows = (await db.query<{ a: string; b: string; ok: boolean }>(
      `select a::text a, b::text b, is_valid_provider_payment_transition(a, b) ok
         from unnest(enum_range(null::provider_payment_status_enum)) a, unnest(enum_range(null::provider_payment_status_enum)) b`)).rows
    expect(rows).toHaveLength(PAYMENT_STATUSES.length ** 2)
    for (const r of rows) expect(PAYMENT_TRANSITIONS[r.a as ProviderPaymentStatus].includes(r.b as ProviderPaymentStatus), `${r.a} -> ${r.b}`).toBe(r.ok)
  })

  describe('payout configuration', () => {
    const asAdmin = async <T,>(fn: () => Promise<T>) => {
      await db.exec(`set role authenticated; select set_config('request.jwt.sub', '${admin}', false)`)
      try { return await fn() } finally { await db.exec('reset role') }
    }
    const setPayout = (prov: string, wallet: string | null, network = 'mainnet', perTx: number | null = 50, daily: number | null = 200) =>
      asAdmin(() => db.query(`select admin_set_provider_payout($1::uuid, $2, $3, 'TON', $4, $5)`, [prov, wallet, network, perTx, daily]))

    it('validates the wallet like the TON format: checksum, testnet-only never on mainnet', async () => {
      const prov = await newProvider(100)
      for (const ok of [RAW, MAINNET_BOUNCEABLE, MAINNET_PLAIN, `-1:${'cd'.repeat(32)}`]) await expect(setPayout(prov, ok)).resolves.toBeTruthy()
      await expect(setPayout(prov, BAD_CHECKSUM)).rejects.toThrow(/invalid_payout_config: the wallet is not a valid TON address/)
      await expect(setPayout(prov, 'definitely not an address')).rejects.toThrow(/not a valid TON address/)
      await expect(setPayout(prov, TESTNET_ONLY)).rejects.toThrow(/testnet-only address but the network is mainnet/)
      await expect(setPayout(prov, TESTNET_ONLY, 'testnet')).resolves.toBeTruthy()
      await expect(setPayout(prov, RAW, 'mainnet', 300, 200)).rejects.toThrow(/daily limit cannot be below/)
      await expect(setPayout(prov, RAW, 'mainnet', 0, 200)).rejects.toThrow(/greater than 0/)
      await expect(setPayout(prov, RAW, 'devnet')).rejects.toThrow(/mainnet or testnet/)
      // clearing the wallet is allowed: top-ups are then refused (fail closed)
      await setPayout(prov, '  ', 'mainnet', null, null)
      expect((await db.query<R>(`select allowed_destination_wallet w, max_topup_per_tx m from providers where id = $1`, [prov])).rows[0]).toEqual({ w: null, m: null })
      const audit = (await db.query<{ d: R }>(`select details d from admin_audit_log where action = 'set_provider_payout' and target_id = $1 order by created_at desc limit 1`, [prov])).rows[0].d
      expect(audit.wallet).toEqual([TESTNET_ONLY, null])
    })

    it('the SQL address check agrees with the TypeScript parser', async () => {
      const samples = [RAW, MAINNET_BOUNCEABLE, MAINNET_PLAIN, TESTNET_ONLY, friendly(0x91, 1), friendly(0x11, 7, { workchain: -1 }), BAD_CHECKSUM, friendly(0x22, 3), 'EQ' + 'A'.repeat(46), '', 'x']
      for (const a of samples) {
        let ts: R | null
        try {
          parseTonAddress(a)
          const flags = tonAddressFlags(a)
          ts = flags ? { format: 'friendly', test_only: flags.testOnly } : { format: 'raw' }
        } catch {
          ts = null
        }
        expect((await db.query<{ r: R | null }>(`select ton_address_info($1) r`, [a])).rows[0].r, a).toEqual(ts)
      }
    })

    it('admin_list_providers shows the payout config and what was used today', async () => {
      const prov = await newProvider(100)
      await newPayment(prov, 30, 'VALIDATED')
      const canceled = await newPayment(prov, 40, 'VALIDATED')
      await one(`select cancel_provider_payment($1::uuid, 'not needed') r`, [canceled]) // given back: not counted
      const list = await asAdmin(async () => (await db.query<{ r: R[] }>(`select admin_list_providers() r`)).rows[0].r)
      expect(list.find((p) => p.id === prov)).toMatchObject({ allowed_destination_wallet: RAW, payout_network: 'mainnet', payout_asset: 'TON', max_topup_per_tx: 1000, max_daily_topup: 100000, topup_used_today: 30 })
    })
  })

  it('clients cannot reach the detector or the payment list', async () => {
    const prov = await newProvider(100)
    await newPayment(prov, 10, 'PAYMENT_CREATED')
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}; select set_config('request.jwt.sub', '${admin}', false)`)
      await expect(db.query(`select list_provider_payments()`)).rejects.toThrow()
      await expect(db.query(`select ton_address_info('x')`)).rejects.toThrow()
      await expect(db.query(`select provider_spent_since(gen_random_uuid(), now())`)).rejects.toThrow()
      await expect(db.query(`select sync_reconciliation_cases()`)).rejects.toThrow()
    }
    await db.exec('reset role')
  })
})
