import { Send } from 'lucide-react'
import { useT } from '@/i18n'
import { haptic } from '@/lib/haptics'
import { useSignIn } from '@/context/SignInContext'

/** What a website guest sees on a personal tab (orders, wallet, support): why to sign in, and the button. */
export function GuestPrompt({ title, text }: { title: string; text: string }) {
  const t = useT()
  const signIn = useSignIn()
  return (
    <section className="mx-auto mt-6 max-w-sm space-y-3 rounded-3xl border border-blue-100/70 bg-surface p-6 text-center shadow-card" data-testid="guest-prompt">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-light text-brand"><Send size={22} strokeWidth={2} /></span>
      <h1 className="text-lg font-extrabold text-content-primary">{t(title)}</h1>
      <p className="text-sm text-content-secondary">{t(text)}</p>
      <button type="button" onClick={() => { haptic.tap(); signIn() }} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[15px] font-bold text-white active:scale-[0.98]">
        <Send size={16} strokeWidth={2} /> {t('Sign in with Telegram')}
      </button>
    </section>
  )
}
