import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-brand px-6 text-sm font-bold text-white transition-colors hover:bg-brand-hover active:scale-[0.98]',
        className,
      )}
      {...props}
    />
  )
}
