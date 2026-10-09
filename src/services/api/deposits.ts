import { tr } from '@/i18n'
import type { AuthSession } from '@/services/api/auth'
import type { IWallet } from '@/types'
import type { DepositAsset, DepositIntent, DepositQuote, LedgerEntry, LedgerType, VerifyResult } from '@/types/wallet'
import { DepositApiError, type DepositErrorCode } from './deposit-errors'
import { mockBackend } from './mock-orders'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const FUNCTION_TIMEOUT_MS = 20_000
const READ_TIMEOUT_MS = 10_000

interface FnResponse {
  success?: boolean
  error?: DepositErrorCode
  message?: string
  [key: string]: unknown
}

async function callFunction(session: AuthSession, name: string, payload: unknown): Promise<{ status: number; body: FnResponse }> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new DepositApiError('server', 'Backend is not configured.')
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FUNCTION_TIMEOUT_MS),
    })
  } catch {
    throw new DepositApiError('network', tr('Connection lost. Please check your connection and try again.'))
  }
  const body = (await res.json().catch(() => null)) as FnResponse | null
  if (!body) throw new DepositApiError('server', tr('Unexpected response from the server.'))
  if (body.success === false || !res.ok && res.status !== 202) {
    throw new DepositApiError(body.error ?? (res.status === 401 ? 'unauthorized' : 'server'), body.message ?? tr('Something went wrong. Please try again.'))
  }
  return { status: res.status, body }
}

/** Live price preview for the amount. Writes nothing on the server. */
export async function quoteDeposit(session: AuthSession, input: { amountUsd: number; asset: DepositAsset }): Promise<DepositQuote> {
  if (session.isMock) return mockBackend.quoteDeposit(input.amountUsd, input.asset)
  const { body } = await callFunction(session, 'create-deposit', { ...input, quoteOnly: true })
  return body.quote as DepositQuote
}

/** Creates the pending deposit (unique memo, locked rate). The balance is NOT touched. */
export async function createDeposit(session: AuthSession, input: { amountUsd: number; asset: DepositAsset }): Promise<DepositIntent> {
  if (session.isMock) return mockBackend.createDeposit(input.amountUsd, input.asset)
  const { body } = await callFunction(session, 'create-deposit', input)
  const { success: _success, ...intent } = body
  return intent as unknown as DepositIntent
}

/** Asks the server to look for the payment on chain. Only the server decides whether to credit. */
export async function verifyDeposit(session: AuthSession, depositId: string): Promise<VerifyResult> {
  if (session.isMock) return mockBackend.verifyDeposit(depositId)
  const { body } = await callFunction(session, 'verify-deposit', { depositId })
  return { status: body.status === 'completed' ? 'completed' : 'pending', wallet: body.wallet as IWallet | undefined }
}

/** Dev-mock only: stands in for the blockchain confirmation. Throws outside mock mode. */
export function simulateMockPayment(session: AuthSession, depositId: string): VerifyResult {
  if (!session.isMock) throw new DepositApiError('server', 'Payment simulation is only available in dev mock mode.')
  return mockBackend.completeDeposit(depositId)
}

interface LedgerRow {
  id: string
  type: LedgerType
  status: LedgerEntry['status']
  amount: number | string
  balance_after: number | string | null
  description: string | null
  created_at: string
}

interface PendingDepositRow {
  id: string
  amount_usd: number | string
  asset: string
  created_at: string
}

async function rest<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY!, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return (await res.json()) as T
}

/** The user's ledger (RLS-scoped) plus open deposits, newest first. */
export async function getLedger(session: AuthSession): Promise<LedgerEntry[]> {
  if (session.isMock) return mockBackend.listLedger()
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Backend is not configured')

  const [tx, pending] = await Promise.all([
    rest<LedgerRow[]>('wallet_transactions?select=id,type,status,amount,balance_after,description,created_at&status=eq.completed&order=created_at.desc&limit=100', session.token),
    rest<PendingDepositRow[]>(
      `deposits?select=id,amount_usd,asset,created_at&status=eq.pending&valid_until=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc&limit=10`,
      session.token,
    ),
  ])

  const entries: LedgerEntry[] = [
    ...pending.map((d): LedgerEntry => ({
      id: `pending-${d.id}`, type: 'deposit', status: 'pending', amount: Number(d.amount_usd), balanceAfter: null,
      description: `Deposit pending (${d.asset})`, createdAt: d.created_at, depositId: d.id,
    })),
    ...tx.map((t): LedgerEntry => ({
      id: t.id, type: t.type, status: t.status, amount: Number(t.amount),
      balanceAfter: t.balance_after === null ? null : Number(t.balance_after), description: t.description, createdAt: t.created_at,
    })),
  ]
  return entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}
