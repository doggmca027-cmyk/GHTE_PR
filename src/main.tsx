import { StrictMode } from 'react'
import { TonConnectUIProvider } from '@tonconnect/ui-react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { initLanguage } from './i18n'
import { initTelegram } from './lib/telegram'
import { WebApp } from './lib/webapp'
import './index.css'

initTelegram()

// TON Connect fetches this manifest to show the wallet who is asking. It must be publicly reachable
// over HTTPS and its "url" must equal the deployed origin (see public/tonconnect-manifest.json).
const manifestUrl = import.meta.env.VITE_TONCONNECT_MANIFEST_URL || `${window.location.origin}/tonconnect-manifest.json`
// Where Telegram sends the user back after they approve in Tonkeeper, e.g. https://t.me/your_bot/app
const twaReturnUrl = import.meta.env.VITE_TWA_RETURN_URL as `${string}://${string}` | undefined

// The language is chosen before the first paint (the customer's own choice, else Telegram's, else the browser's), so the app never
// flashes English at someone who reads Russian. A failure leaves English.
void initLanguage(WebApp.initDataUnsafe?.user?.language_code).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <TonConnectUIProvider manifestUrl={manifestUrl} actionsConfiguration={twaReturnUrl ? { twaReturnUrl } : undefined}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </TonConnectUIProvider>
    </StrictMode>,
  )
})
