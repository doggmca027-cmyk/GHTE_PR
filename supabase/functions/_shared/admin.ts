/**
 * Parses ADMIN_TELEGRAM_IDS ("123456, 789") into a set of Telegram ids. Junk entries are ignored.
 *
 * This list is a BOOTSTRAP only: telegram-auth promotes a verified (signed initData) user whose id
 * is listed. The database flag users.is_admin remains the single source of truth that every admin
 * RPC re-checks; removing an id here does NOT demote anyone (do that with SQL).
 */
export function parseAdminIds(raw: string | undefined | null): Set<number> {
  const ids = new Set<number>()
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    if (/^\d{1,15}$/.test(part)) {
      const n = Number(part)
      if (Number.isSafeInteger(n) && n > 0) ids.add(n)
    }
  }
  return ids
}
