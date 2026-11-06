import { Suspense, StrictMode, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { initLanguage } from './i18n'
import { registerServiceWorker } from './lib/pwa'
import { initTelegram } from './lib/telegram'
import { initTheme } from './lib/theme'
import { WebApp } from './lib/webapp'
import { parseSeoPath } from './seo/pages'
import './index.css'

initTelegram()
initTheme()

// TON Connect is not set up here: it is the heaviest library and only the wallet tab needs it (components/wallet/WalletRoute.tsx,
// lazy-loaded), so the first screen paints without it.

// A public landing page (/es/buy-instagram-followers, /en/crypto-smm-panel; see src/seo/pages.ts): its own small chunk, drawn WITHOUT the app's shell and
// without signing in, so a visitor from a search costs the database nothing. The address of a language's home page (/ru/) opens the app in that language.
const seo = parseSeoPath(window.location.pathname)
const SeoLanding = lazy(() => import('./components/seo/SeoLanding'))

if (seo && seo.landing.type !== 'home') {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <SeoLanding route={seo} />
      </Suspense>
    </StrictMode>,
  )
} else {
  // The language is chosen before the first paint (the customer's own choice, else the one in the address, else Telegram's, else the browser's), so the app
  // never flashes English at someone who reads Russian. A failure leaves English.
  void initLanguage(seo?.lang ?? WebApp.initDataUnsafe?.user?.language_code).finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <AuthProvider>
          <App />
        </AuthProvider>
      </StrictMode>,
    )
  })
}

// the service worker (vite.pwa.ts): after the page has loaded, never in development
registerServiceWorker()
