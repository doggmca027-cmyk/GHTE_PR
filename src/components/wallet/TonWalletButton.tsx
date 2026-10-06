import { Link2Off, Wallet } from 'lucide-react'
import { haptic } from '@/lib/haptics'
import { shortAddress } from '@/lib/ton'
import type { TonWallet } from '@/hooks/useTonWallet'

/** "Connect Tonkeeper" before connecting; a pill with the short address (tap to disconnect) after. */
export function TonWalletButton({ wallet }: { wallet: TonWallet }) {
  if (!wallet.connected) {
    return (
      <button
        type="button"
        onClick={() => { haptic.tap(); wallet.connect() }}
        className="flex h-11 items-center gap-2 rounded-full border border-brand/30 bg-white px-4 text-sm font-bold text-brand shadow-sm transition-all hover:bg-brand-light active:scale-95"
      >
        <Wallet size={18} strokeWidth={1.75} /> Connect Tonkeeper
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => { haptic.select(); void wallet.disconnect() }}
      aria-label="Disconnect wallet"
      title="Tap to disconnect"
      className="group flex h-11 items-center gap-2 rounded-full bg-brand-light px-4 text-sm font-bold text-brand-text transition-all active:scale-95"
    >
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      <span className="font-mono text-[13px]">{shortAddress(wallet.address)}</span>
      {wallet.isMock && <span className="rounded-full bg-white/80 px-1.5 text-[10px] font-semibold uppercase">dev</span>}
      <Link2Off size={14} strokeWidth={1.75} className="opacity-50 group-hover:opacity-100" />
    </button>
  )
}
