// Registers the service worker (vite.pwa.ts) after the page has loaded: never before the first paint, never in development, never where the browser has no
// service workers. A failure changes nothing: the app works without the worker, only not offline. The new worker takes over by itself and never reloads a
// page (an order being placed is not interrupted): the next opening uses the new shell.

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || import.meta.env.DEV || !('serviceWorker' in navigator)) return
  const register = () => {
    import('virtual:pwa-register').then(({ registerSW }) => { registerSW({ immediate: true }) }).catch(() => { /* no worker, no offline: nothing else is lost */ })
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
