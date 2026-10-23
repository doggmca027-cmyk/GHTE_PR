// The wallet tab with TON Connect around it (App lazy-loads this module, see TonProvider).
import { TonProvider } from './TonProvider'
import { WalletScreen, type DepositRequest } from './WalletScreen'
import type { AuthSession } from '@/services/api/auth'

interface Props {
  session: AuthSession
  depositRequest: DepositRequest | null
  onRequestHandled: () => void
}

export default function WalletRoute(props: Props) {
  return (
    <TonProvider>
      <WalletScreen {...props} />
    </TonProvider>
  )
}
