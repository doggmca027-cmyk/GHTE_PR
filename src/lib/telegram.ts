import { WebApp } from '@/lib/webapp'

/** Signal readiness to Telegram and expand the viewport. Safe outside Telegram. */
export function initTelegram(): void {
  try {
    WebApp.ready()
    WebApp.expand()
  } catch {
    /* running in a regular browser */
  }
}
