// The service worker of the app (vite-plugin-pwa, Workbox): the app opens at once on a bad connection, and nothing it must not keep is kept.
//
//   PRECACHED (the shell): index.html, the entry bundle, the vendor chunks, the English texts, the CSS, the icon. Everything else (the other languages, the
//   tab chunks, the admin panel, TON Connect) is cached the first time it is used, CacheFirst: a file of /assets/ has a hash in its name, so it never changes.
//   NEVER CACHED: /api/* (NetworkOnly). The catalogue (/api/catalog, /api/catalog-version) is kept by Vercel's CDN per version of the catalogue and by the
//   app's own cache (lib/catalog-cache.ts) with the version it belongs to; a second copy in a service worker would show a stale catalogue under a NEW
//   version and defeat that. Supabase itself (another origin) and Telegram's script are not touched either.
//   NAVIGATIONS: offline, an address of the app opens the cached index.html; the static pages (terms, privacy) and anything with a file extension do not.
//   UPDATES: the new worker takes over at once (skipWaiting + clientsClaim) but never reloads a page by itself: an order being placed is not interrupted.

import type { VitePWAOptions } from 'vite-plugin-pwa'

/** The languages of the landing pages and the home pages (src/seo/pages.ts): their addresses open the app offline too. */
const LANG_PREFIX = '(?:[a-z]{2}\\/)?'

export const PWA_OPTIONS: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  // registered by src/lib/pwa.ts after the first paint, not by a script of its own
  injectRegister: false,
  includeAssets: [],
  manifest: {
    name: 'GRAM Hub',
    short_name: 'GRAM Hub',
    description: 'Social media promotion paid with TON. Works in Telegram and in the browser.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#EBF3FE',
    theme_color: '#EBF3FE',
    icons: [{ src: '/tonconnect-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' }],
  },
  workbox: {
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: true,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//, new RegExp(`^\\/${LANG_PREFIX}(?:terms|privacy)(?:\\.html)?\\/?$`), /\.[a-z0-9]+$/i, /^\/sw\.js$/],
    globPatterns: [
      'index.html',
      'assets/index-*.{js,css}',
      'assets/react-vendor-*.js',
      'assets/icons-*.js',
      'assets/utils-*.js',
      'assets/rolldown-runtime-*.js',
      'assets/en-*.js',
      'tonconnect-icon.png',
    ],
    runtimeCaching: [
      // the app's own hashed files: the first use keeps them for good (30 days, 150 files)
      {
        urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) => sameOrigin && url.pathname.startsWith('/assets/'),
        handler: 'CacheFirst',
        options: { cacheName: 'gh-assets', expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 30 }, cacheableResponse: { statuses: [200] } },
      },
      // the API and the catalogue proxy: the network only, never a copy of ours (see the head of this file)
      {
        urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) => sameOrigin && url.pathname.startsWith('/api/'),
        handler: 'NetworkOnly',
      },
      // the font of the app (Google Fonts): renewed in the background
      {
        urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,
        handler: 'StaleWhileRevalidate',
        options: { cacheName: 'gh-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }, cacheableResponse: { statuses: [0, 200] } },
      },
    ],
  },
  devOptions: { enabled: false },
}
