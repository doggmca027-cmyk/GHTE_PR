import { ArrowDownToLine } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n'
import { formatMoneyAmount } from '@/lib/order-calc'
import type { IWallet } from '@/types'

export function BalanceCard({ wallet, onTopUp }: { wallet: IWallet; onTopUp: () => void }) {
  const t = useT()
  return (
    <section className="relative overflow-hidden rounded-[28px] border border-blue-100/70 bg-gradient-to-br from-white via-[#F2F8FF] to-[#D6EBFD] p-5 shadow-card">
      <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-brand/10 blur-2xl" />
      <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('Available balance')}</p>
      <p className="mt-1 text-4xl font-extrabold tracking-tight text-content-primary">{formatMoneyAmount(wallet.balance)}</p>
      <p className="mt-0.5 text-xs font-medium text-content-secondary">{wallet.currency}</p>
      <Button className="mt-5 h-12 w-full" onClick={onTopUp}>
        <ArrowDownToLine size={18} strokeWidth={2} /> {t('Top Up Balance')}
      </Button>
    </section>
  )
}
