// Deposit cases of the Reconciliation Center: what happened (read from the case reason the verifier wrote), what to prefill in the
// credit form, and the server's refusals in Russian (the admin panel is Russian). Pure, so it is tested.

export type DepositIssue = 'underpaid' | 'overpaid' | 'outside_window' | 'late_payment' | 'tx_used' | 'other'

export interface DepositCaseFacts {
  issue: DepositIssue
  /** The transaction named in the reason, if any. */
  txHash: string | null
  /** What arrived, in TON, if the reason says. */
  receivedTon: number | null
}

export const DEPOSIT_ISSUE: Record<DepositIssue, { title: string; detail: string }> = {
  underpaid: { title: 'Недоплата', detail: 'Пришло меньше, чем нужно. «Зачесть» начислит пропорционально полученному.' },
  overpaid: { title: 'Переплата', detail: 'Депозит зачислен по счёту, лишнее осталось на нашем кошельке. Верните его клиенту вне приложения и закройте кейс.' },
  outside_window: { title: 'Оплата вне окна', detail: 'Перевод пришёл, когда счёт уже истёк. Проверьте транзакцию и зачтите её или закройте кейс.' },
  late_payment: { title: 'Поздняя оплата', detail: 'Перевод пришёл после истечения счёта. Проверьте транзакцию и зачтите её или закройте кейс.' },
  tx_used: { title: 'Транзакция уже использована', detail: 'Эта транзакция уже зачислена на другой депозит. Обычно кейс просто закрывают.' },
  other: { title: 'Проблема с депозитом', detail: 'Проверьте транзакцию в обозревателе TON и решите: зачесть или закрыть.' },
}

// (the hash may end in "=", so the end is "not another hash character", not a word boundary)
const HASH = /\b(?:in tx|tx)\s+((?:0x)?[0-9a-fA-F]{64}|[A-Za-z0-9+/_-]{43}=?)(?![A-Za-z0-9+/=_-])/

export function depositCaseFacts(reason: string): DepositCaseFacts {
  const r = reason.toLowerCase()
  const issue: DepositIssue = r.startsWith('underpaid') ? 'underpaid'
    : r.startsWith('overpaid') ? 'overpaid'
      : /outside[_ ]window|outside the window/.test(r) ? 'outside_window'
        : /late|expired/.test(r) ? 'late_payment'
          : /already (used|credited)|tx_already_used/.test(r) ? 'tx_used'
            : 'other'
  const txHash = HASH.exec(reason)?.[1] ?? null
  const ton = /received\s+([0-9]+(?:\.[0-9]+)?)\s*TON/i.exec(reason)
  const nano = /received\s+([0-9]+)\s*nanoton/i.exec(reason)
  const receivedTon = ton ? Number(ton[1]) : nano ? Number(nano[1]) / 1e9 : null
  return { issue, txHash, receivedTon: receivedTon !== null && Number.isFinite(receivedTon) && receivedTon > 0 ? receivedTon : null }
}

/** TON typed by the admin -> nanoton, exactly (no binary rounding: "4.1" is 4100000000). null if it is not a positive amount. */
export function tonToNano(text: string): number | null {
  const m = /^\s*(\d{1,9})(?:[.,](\d{1,9}))?\s*$/.exec(text)
  if (!m) return null
  const nano = Number(m[1]) * 1e9 + Number((m[2] ?? '').padEnd(9, '0'))
  return nano > 0 ? nano : null
}

/** A TON transaction hash as explorers show it: base64 / base64url (44 characters) or 64 hex characters. */
export const isTxHash = (v: string): boolean => /^([A-Za-z0-9+/_-]{43}=?|(0x)?[0-9a-fA-F]{64})$/.test(v.trim())

/** The server's refusals of admin_resolve_deposit / admin_set_user_ban / admin_find_users, in Russian. */
export function adminActionError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('already credited to another deposit')) return 'Эта транзакция уже зачислена на другой депозит.'
  if (m.includes('credited with another transaction')) return 'Депозит уже зачислен другой транзакцией.'
  if (m.includes('has failed and cannot be credited')) return 'Депозит отменён, зачесть его нельзя.'
  if (m.includes('received amount')) return 'Укажите, сколько TON пришло.'
  if (m.includes('nothing to credit')) return 'Начислять нечего: сумма слишком мала.'
  if (m.includes('note is required')) return 'Укажите причину закрытия.'
  if (m.includes('cannot ban or unban yourself')) return 'Нельзя заблокировать самого себя.'
  if (m.includes('2 to 64 characters')) return 'Введите от 2 до 64 символов.'
  if (/not found/.test(m)) return 'Не найдено: возможно, кейс уже закрыт.'
  return message
}
