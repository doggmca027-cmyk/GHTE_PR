import { useEffect, useRef } from 'react'
import type { TelegramWidgetUser } from '@/services/api/web-auth'

export const WIDGET_SCRIPT = 'https://telegram.org/js/telegram-widget.js?22'

/**
 * The user Telegram hands back in the address after the widget's redirect (data-auth-url): id, auth_date and hash, plus the optional
 * names and photo. Null when the address does not carry a complete, well-formed one. The server checks the signature with the bot token.
 */
export function widgetUserFromUrl(search: string): TelegramWidgetUser | null {
  const q = new URLSearchParams(search)
  const id = Number(q.get('id'))
  const authDate = Number(q.get('auth_date'))
  const hash = q.get('hash') ?? ''
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(authDate) || authDate <= 0 || !/^[0-9a-f]{64}$/.test(hash)) return null
  const user: TelegramWidgetUser = { id, auth_date: authDate, hash }
  for (const k of ['first_name', 'last_name', 'username', 'photo_url'] as const) {
    const v = q.get(k)
    if (v) user[k] = v
  }
  return user
}

const WIDGET_PARAMS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']

/**
 * Telegram's own Login Widget (a button in an iframe from oauth.telegram.org). It works in REDIRECT mode: Telegram sends the browser back
 * to this page with the signed user in the address, which is read once here and removed from the address. (The callback mode makes the
 * widget run its "data-onauth" text as code, which the site's Content-Security-Policy rightly forbids: the button never appeared.)
 * The widget shows only on the domain set for the bot in @BotFather (/setdomain).
 */
export function TelegramLoginWidget({ bot, onAuth }: { bot: string; onAuth: (user: TelegramWidgetUser) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const callback = useRef(onAuth)
  callback.current = onAuth

  // back from Telegram: the signed user is in the address (taken once, then removed so a reload or a shared link never replays it)
  useEffect(() => {
    const user = widgetUserFromUrl(window.location.search)
    if (!user) return
    const url = new URL(window.location.href)
    for (const k of WIDGET_PARAMS) url.searchParams.delete(k)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    callback.current(user)
  }, [])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const script = document.createElement('script')
    script.src = WIDGET_SCRIPT
    script.async = true
    script.setAttribute('data-telegram-login', bot)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '14')
    script.setAttribute('data-request-access', 'write')
    script.setAttribute('data-auth-url', `${window.location.origin}${window.location.pathname}`)
    el.appendChild(script)
    return () => { el.innerHTML = '' }
  }, [bot])

  return <div ref={host} className="flex min-h-[44px] justify-center" data-testid="telegram-login-widget" />
}
