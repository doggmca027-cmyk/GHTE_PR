// Binds telegram-notify to Supabase (users + notification_log). Used by Edge Functions.
// Everything here is best effort: createNotifier()'s function NEVER throws or rejects.

import { notifyUser, resolveLang, sendTelegramMessage, type NotifyEvent, type NotifyOutcome } from './telegram-notify.ts'

/** The slice of the supabase-js client we use (kept structural so this file has no npm imports). */
// deno-lint-ignore no-explicit-any
type DbLike = { from(table: string): any }

export function createNotifier(
  db: DbLike,
  env: { get(name: string): string | undefined },
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } = console,
) {
  return async function notify(userId: string, event: NotifyEvent, dedupeKey: string): Promise<NotifyOutcome> {
    try {
      const { data: user } = await db
        .from('users')
        .select('telegram_id, language_code, notifications_enabled, bot_blocked_at')
        .eq('id', userId)
        .maybeSingle()
      if (!user) return 'error'
      // A customer who blocked the bot (Telegram answered 403) is left alone for 30 days; it only costs a refused request otherwise.
      const blockedRecently = user.bot_blocked_at != null && Date.now() - Date.parse(String(user.bot_blocked_at)) < 30 * 86_400_000
      let blockedNow = false

      const outcome = await notifyUser(
        {
          botToken: env.get('TELEGRAM_BOT_TOKEN'),
          mock: env.get('MOCK_MODE') === 'true',
          async claim(key) {
            const { error } = await db.from('notification_log').insert({ dedupe_key: key, user_id: userId, kind: event.type })
            // 23505 = already claimed. Any other DB error: do not send (a duplicate is worse than a miss).
            return !error
          },
          async release(key) {
            await db.from('notification_log').delete().eq('dedupe_key', key)
          },
          // remember a 403 so the next message does not try again
          async send(o) {
            const r = await sendTelegramMessage(o)
            if (!r.ok && r.reason === 'blocked') blockedNow = true
            return r
          },
          log,
        },
        { chatId: Number(user.telegram_id), lang: resolveLang(user.language_code), enabled: user.notifications_enabled !== false && !blockedRecently },
        event,
        dedupeKey,
      )
      if (blockedNow) await db.from('users').update({ bot_blocked_at: new Date().toISOString() }).eq('id', userId)
      return outcome
    } catch {
      return 'error'
    }
  }
}
