/**
 * Back to the top of the screen: the window (the website scrolls the page) and every scrolling screen of the app (the Mini App scrolls
 * the <main> inside its phone frame, marked data-scroll-root). Called on every change of tab and of catalogue level, so a new screen
 * never opens scrolled down past its own content (Telegram's WebView then showed an empty screen until the next touch).
 */
export function resetScroll(): void {
  if (typeof window === 'undefined') return
  for (const el of document.querySelectorAll<HTMLElement>('[data-scroll-root]')) el.scrollTop = 0
  // jsdom (the tests) has no scrolling at all
  if (!navigator.userAgent.includes('jsdom')) {
    try {
      window.scrollTo(0, 0)
    } catch { /* an old WebView without scrollTo(x, y): the page itself does not scroll there */ }
  }
}
