// Binds telegram-notify to Supabase (users + notification_log). Used by Edge Functions.
// Everything here is best effort: createNotifier()'s function NEVER throws or rejects.

import { notifyUser, resolveLang, type NotifyEvent, type NotifyOutcome } from './telegram-notify.ts'

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
        .select('telegram_id, language_code, notifications_enabled')
        .eq('id', userId)
        .maybeSingle()
      if (!user) return 'error'

      return await notifyUser(
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
          log,
        },
        { chatId: Number(user.telegram_id), lang: resolveLang(user.language_code), enabled: user.notifications_enabled !== false },
        event,
        dedupeKey,
      )
    } catch {
      return 'error'
    }
  }
}
