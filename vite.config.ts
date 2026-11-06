/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Splits third-party code into long-lived vendor chunks so that app changes do not invalidate
 * them in the browser cache, and so no single chunk blows past the size warning.
 *   ton-connect : @tonconnect/* and everything it pulls in (the heavy one)
 *   icons       : lucide-react
 *   react-vendor: react, react-dom, scheduler
 * The TON chunk is only needed once a wallet is used, but TonConnectUIProvider sits at the root,
 * so it is still requested at startup (in parallel with the others thanks to the split).
 */
function vendorChunk(rawId: string): string | undefined {
  const id = rawId.replace(/\\/g, '/')
  if (!id.includes('/node_modules/')) return undefined
  if (/\/node_modules\/(@tonconnect|@ton|tweetnacl|js-base64|solid-js|@solid-primitives|classnames|csstype)\b/.test(id)) return 'ton-connect'
  if (/\/node_modules\/lucide-react\//.test(id)) return 'icons'
  if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor'
  return undefined
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { host: true },
  test: {
    // the app reads the catalogue through the CDN proxy (/api/catalog) in production; the tests of the screens read the storefront directly and count
    // the requests, so the proxy is off for them (tests/catalog-proxy.test.ts and tests/catalog-version.test.ts test it on its own)
    env: { VITE_CATALOG_PROXY: 'off' },
    // the long lists draw only the cards near the screen, which needs a layout engine; jsdom has none (see the file)
    setupFiles: ['./tests/setup/virtuoso-plain.ts'],
    // On a developer machine: one test file at a time, in one worker. Several of the suites build a whole database (PGlite) per file, so a worker per
    // core ate all the memory and the processor. (Vitest 5 has no `poolOptions.threads`: `maxWorkers` is the limit, and `fileParallelism: false`
    // forces it to 1.) The CI of GitHub (CI=true) keeps Vitest's own default: it runs the suite in three shards, and a single worker would triple
    // the time of every shard.
    ...(process.env.CI ? {} : { maxWorkers: 1, fileParallelism: false }),
  },
  build: {
    // Production hygiene, stated explicitly so a future default change cannot silently alter it:
    // no source maps in the public bundle (they would publish the original TypeScript), and an
    // explicit 500 kB threshold so an oversized chunk is flagged in the build output.
    sourcemap: false,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
})
