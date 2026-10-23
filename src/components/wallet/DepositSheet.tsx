// The top-up opened from an order whose total the balance does not cover: the deposit drawer over the order form, for the missing amount.
// The order form stays as it was under it, so after the payment the customer places the order without filling it in again.
// Lazy-loaded by OrderModal (TON Connect comes with it).
import { useTonWallet } from '@/hooks/useTonWallet'
import type { AuthSession } from '@/services/api/auth'
import { DepositModal } from './DepositModal'
import { TonProvider } from './TonProvider'

interface Props {
  session: AuthSession
  amountUsd: number
  onClose: () => void
}

function Sheet({ session, amountUsd, onClose }: Props) {
  const wallet = useTonWallet()
  // DepositModal puts the new balance into the session itself (applyWallet): the order form sees it at once
  return <DepositModal session={session} wallet={wallet} initialAmount={amountUsd} onClose={onClose} onCredited={() => {}} />
}

export default function DepositSheet(props: Props) {
  return (
    <TonProvider>
      <Sheet {...props} />
    </TonProvider>
  )
}
