// TON Connect around whatever pays from a TON wallet: the wallet tab and the top-up opened from an order. TON Connect (~430 KB, the
// heaviest library of the app) is only loaded with those (both are lazy modules). The library keeps ONE TonConnectUI per page, so
// mounting the provider again neither loses the connected wallet nor connects twice.
import { useEffect, type ReactNode } from 'react'
import { THEME, TonConnectUIProvider, useTonConnectUI } from '@tonconnect/ui-react'
import { useScheme } from '@/lib/theme'

// TON Connect fetches this manifest to show the wallet who is asking. It must be publicly reachable over HTTPS and its "url" must equal
// the deployed origin (see public/tonconnect-manifest.json).
const manifestUrl = import.meta.env.VITE_TONCONNECT_MANIFEST_URL || `${window.location.origin}/tonconnect-manifest.json`
// Where Telegram sends the user back after they approve in Tonkeeper, e.g. https://t.me/your_bot/app
const twaReturnUrl = import.meta.env.VITE_TWA_RETURN_URL as `${string}://${string}` | undefined

/** Keeps the wallet dialog in the app's theme when it changes while the app is open. */
function TonTheme() {
  const [, setOptions] = useTonConnectUI()
  const scheme = useScheme()
  useEffect(() => { setOptions({ uiPreferences: { theme: scheme === 'dark' ? THEME.DARK : THEME.LIGHT } }) }, [scheme, setOptions])
  return null
}

export function TonProvider({ children }: { children: ReactNode }) {
  const scheme = useScheme()
  return (
    <TonConnectUIProvider
      manifestUrl={manifestUrl}
      actionsConfiguration={twaReturnUrl ? { twaReturnUrl } : undefined}
      uiPreferences={{ theme: scheme === 'dark' ? THEME.DARK : THEME.LIGHT }}
    >
      <TonTheme />
      {children}
    </TonConnectUIProvider>
  )
}
