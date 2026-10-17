// The wallet tab with TON Connect around it. TON Connect (~430 KB, the heaviest library of the app) is only needed to pay from a TON
// wallet, so it is loaded with this tab (App lazy-loads this module) instead of before the first screen. The library keeps ONE TonConnectUI
// per page, so leaving and reopening the tab neither loses the connected wallet nor connects twice.
import { useEffect } from 'react'
import { THEME, TonConnectUIProvider, useTonConnectUI } from '@tonconnect/ui-react'
import { useScheme } from '@/lib/theme'
import { WalletScreen, type DepositRequest } from './WalletScreen'
import type { AuthSession } from '@/services/api/auth'

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

interface Props {
  session: AuthSession
  depositRequest: DepositRequest | null
  onRequestHandled: () => void
}

export default function WalletRoute(props: Props) {
  const scheme = useScheme()
  return (
    <TonConnectUIProvider
      manifestUrl={manifestUrl}
      actionsConfiguration={twaReturnUrl ? { twaReturnUrl } : undefined}
      uiPreferences={{ theme: scheme === 'dark' ? THEME.DARK : THEME.LIGHT }}
    >
      <TonTheme />
      <WalletScreen {...props} />
    </TonConnectUIProvider>
  )
}
