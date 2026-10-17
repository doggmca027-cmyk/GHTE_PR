import { useEffect, useRef } from 'react'
import type { TelegramWidgetUser } from '@/services/api/web-auth'

/** The global the widget calls back (the widget only takes a function name). */
export const WIDGET_CALLBACK = '__gramHubTelegramAuth'
export const WIDGET_SCRIPT = 'https://telegram.org/js/telegram-widget.js?22'

/**
 * Telegram's own Login Widget (a button in an iframe from oauth.telegram.org). It hands back the user signed by Telegram; the server
 * checks the signature with the bot token (web-auth TELEGRAM_WIDGET_LOGIN). It shows only on the domain set in @BotFather (/setdomain).
 */
export function TelegramLoginWidget({ bot, onAuth }: { bot: string; onAuth: (user: TelegramWidgetUser) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const callback = useRef(onAuth)
  callback.current = onAuth

  useEffect(() => {
    const el = host.current
    if (!el) return
    const w = window as unknown as Record<string, unknown>
    w[WIDGET_CALLBACK] = (user: TelegramWidgetUser) => callback.current(user)
    const script = document.createElement('script')
    script.src = WIDGET_SCRIPT
    script.async = true
    script.setAttribute('data-telegram-login', bot)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '14')
    script.setAttribute('data-request-access', 'write')
    script.setAttribute('data-onauth', `${WIDGET_CALLBACK}(user)`)
    el.appendChild(script)
    return () => {
      el.innerHTML = ''
      delete w[WIDGET_CALLBACK]
    }
  }, [bot])

  return <div ref={host} className="flex min-h-[44px] justify-center" data-testid="telegram-login-widget" />
}
