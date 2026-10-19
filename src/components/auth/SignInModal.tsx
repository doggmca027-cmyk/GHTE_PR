import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useT } from '@/i18n'
import type { AuthSession } from '@/services/api/auth'
import { SignInPanel } from './WebSignIn'

/**
 * The website guest's sign-in, as a sheet over the page: Telegram's own Login Widget (the user confirms in Telegram, which shows the
 * device and the place of the attempt) and, when e-mail sign-in is on, the e-mail forms. The widget works in redirect mode: Telegram
 * sends the browser back with the signed user in the address, and App opens this sheet again so the widget finishes the sign-in.
 */
export function SignInModal({ onSignedIn, onClose }: { onSignedIn: (session: AuthSession) => void; onClose: () => void }) {
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center animate-fade-in sm:items-center" role="dialog" aria-modal="true" aria-labelledby="signin-title">
      <button type="button" aria-label={t('Close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div className="relative z-10 max-h-[100dvh] w-full max-w-sm space-y-4 overflow-y-auto animate-sheet-up rounded-t-[32px] bg-screen px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-[0_-12px_40px_rgb(0,136,204,0.14)] sm:rounded-[28px]">
        <div className="flex justify-end">
          <button type="button" onClick={onClose} aria-label={t('Close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-content-secondary active:scale-90">
            <X size={18} strokeWidth={2} />
          </button>
        </div>
        <SignInPanel onSignedIn={onSignedIn} />
      </div>
    </div>
  )
}
