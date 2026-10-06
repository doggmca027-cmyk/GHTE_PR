/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  /** Public anon/publishable key. Safe for the browser; never put secrets in VITE_* vars. */
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** Absolute URL of the TON Connect manifest (default: <origin>/tonconnect-manifest.json). */
  readonly VITE_TONCONNECT_MANIFEST_URL?: string
  /** Telegram deep link to return to after wallet approval, e.g. https://t.me/your_bot/app */
  readonly VITE_TWA_RETURN_URL?: string
  /** "true" = offline mock backend (fake wallet, catalogue and orders). */
  readonly VITE_MOCK_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
