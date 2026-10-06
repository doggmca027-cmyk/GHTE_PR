import { WebApp } from '@/lib/webapp'

// Telegram.WebApp.HapticFeedback wrapper. Silent no-op outside Telegram / on unsupported clients.
function run(fn: (h: typeof WebApp.HapticFeedback) => void): void {
  if (!WebApp.initData) return
  try {
    fn(WebApp.HapticFeedback)
  } catch {
    /* haptics are best-effort */
  }
}

export const haptic = {
  /** Selecting a tab / chip / list item. */
  select: () => run((h) => h.selectionChanged()),
  /** Opening a sheet, pressing a primary button. */
  tap: () => run((h) => h.impactOccurred('light')),
  success: () => run((h) => h.notificationOccurred('success')),
  warning: () => run((h) => h.notificationOccurred('warning')),
  error: () => run((h) => h.notificationOccurred('error')),
}
