// The Telegram Mini App object (`initData`, `ready()`, `HapticFeedback`, ...).
//
// It comes from Telegram's own script (<script src="https://telegram.org/js/telegram-web-app.js"> in index.html), which
// defines window.Telegram.WebApp from the launch parameters. We deliberately do NOT import it from the npm SDK:
// in a production bundle `import WebApp from '@twa-dev/sdk'` returned the CommonJS exports object ({ default: WebApp }),
// and even a bare side-effect import was tree-shaken away, so initData was always empty and the app said
// "Please open this app from Telegram" INSIDE Telegram. (tests/webapp-bundle.test.ts guards this.)
import type { default as SdkWebApp } from '@twa-dev/sdk'

export type TelegramWebApp = typeof SdkWebApp

const noop = () => {}

/** What the app uses, as no-ops: a plain browser (or a blocked telegram.org) must degrade to "not in Telegram", never crash. */
const OUTSIDE_TELEGRAM = {
  initData: '',
  ready: noop,
  expand: noop,
  setHeaderColor: noop,
  setBackgroundColor: noop,
  HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
} as unknown as TelegramWebApp

const fromWindow = (globalThis as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp

export const WebApp: TelegramWebApp = fromWindow ?? OUTSIDE_TELEGRAM
