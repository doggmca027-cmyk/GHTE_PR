import { Tag } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { QuoteState } from '@/types/quote'

interface Props {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  state: QuoteState
}

/** Promo code input. The verdict comes from the quote (the same engine that will charge the order). */
export function PromoField({ value, onChange, disabled, state }: Props) {
  const code = value.trim()
  const refused = state.kind === 'ready' ? state.promoError : null
  const accepted = code !== '' && state.kind === 'ready' && !state.promoError && state.quote.promo.applied
  return (
    <label className="mt-4 block">
      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-content-primary">
        <Tag size={16} strokeWidth={1.75} className="text-brand" /> Promo code <span className="text-xs font-medium text-content-muted">(optional)</span>
      </span>
      <input
        type="text"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={32}
        placeholder="SUMMER10"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32))}
        aria-invalid={Boolean(refused)}
        className={cn(
          'w-full rounded-2xl border bg-surface-sub px-4 py-3.5 text-[15px] font-medium uppercase text-content-primary outline-none transition-colors placeholder:normal-case placeholder:text-content-muted focus:bg-white disabled:opacity-60',
          refused ? 'border-rose-300 focus:border-rose-400' : accepted ? 'border-emerald-300' : 'border-blue-100/70 focus:border-brand',
        )}
      />
      {refused && <p role="alert" className="mt-1.5 text-xs font-medium text-rose-500">{refused}</p>}
      {accepted && <p role="status" className="mt-1.5 text-xs font-medium text-emerald-600">Promo code applied.</p>}
    </label>
  )
}
