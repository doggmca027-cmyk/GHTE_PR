import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { initLanguage } from './i18n'
import { initTelegram } from './lib/telegram'
import { initTheme } from './lib/theme'
import { WebApp } from './lib/webapp'
import './index.css'

initTelegram()
initTheme()

// TON Connect is not set up here: it is the heaviest library and only the wallet tab needs it (components/wallet/WalletRoute.tsx,
// lazy-loaded), so the first screen paints without it.

// The language is chosen before the first paint (the customer's own choice, else Telegram's, else the browser's), so the app never
// flashes English at someone who reads Russian. A failure leaves English.
void initLanguage(WebApp.initDataUnsafe?.user?.language_code).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  )
})
