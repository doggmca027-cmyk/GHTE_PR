import { useEffect } from 'react'
import { cn } from '@/lib/utils'

export interface ToastMessage {
  kind: 'ok' | 'error'
  text: string
}

/** A short notice pinned above the bottom navigation. Announced to screen readers, closes itself (errors stay longer). */
export function Toast({ message, onDismiss }: { message: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDismiss, message.kind === 'ok' ? 4_000 : 8_000)
    return () => clearTimeout(timer)
  }, [message, onDismiss])

  if (!message) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4">
      <p
        role={message.kind === 'error' ? 'alert' : 'status'}
        onClick={onDismiss}
        className={cn(
          'pointer-events-auto max-w-md rounded-2xl px-4 py-3 text-[13px] font-semibold shadow-card',
          message.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white',
        )}
      >
        {message.text}
      </p>
    </div>
  )
}
