// The bot behind the app, for the Telegram Login Widget on the website: VITE_TELEGRAM_BOT_USERNAME, or the bot of the Mini App link
// (VITE_TWA_RETURN_URL = https://t.me/<bot>[/<app>]). The widget only works on the domain set for that bot in @BotFather (/setdomain).

/** "<bot>" from https://t.me/<bot>[/<app>], or null. */
export function botFromLink(link: string | undefined): string | null {
  const m = /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})(?:\/[A-Za-z0-9_]+)?\/?$/.exec(link?.trim() ?? '')
  return m ? m[1] : null
}

export function telegramBotUsername(env: { VITE_TELEGRAM_BOT_USERNAME?: string; VITE_TWA_RETURN_URL?: string } = import.meta.env): string | null {
  const explicit = env.VITE_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '')
  if (explicit && /^[A-Za-z0-9_]{5,32}$/.test(explicit)) return explicit
  return botFromLink(env.VITE_TWA_RETURN_URL)
}
