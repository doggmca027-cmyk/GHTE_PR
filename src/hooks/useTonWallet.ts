import { useCallback, useState } from 'react'
import { useTonAddress, useTonConnectUI, type SendTransactionRequest } from '@tonconnect/ui-react'
import type { TonTransactionRequest } from '@/lib/ton'
import { useAuth } from '@/context/AuthContext'

const MOCK_KEY = 'smm_mock_ton_wallet'
export const MOCK_WALLET_ADDRESS = 'UQDevMockTonkeeperWalletAddressXXXXXXXXXXXXXXXXXX'

function readMock(): boolean {
  try { return globalThis.localStorage.getItem(MOCK_KEY) === '1' } catch { return false }
}
function writeMock(on: boolean): void {
  try { on ? globalThis.localStorage.setItem(MOCK_KEY, '1') : globalThis.localStorage.removeItem(MOCK_KEY) } catch { /* best effort */ }
}

export interface TonWallet {
  connected: boolean
  /** User-friendly address of the connected wallet, or ''. */
  address: string
  isMock: boolean
  connect: () => void
  disconnect: () => Promise<void>
  /** Asks the wallet to sign and send. Resolves once the user approved. Never proves payment. */
  send: (request: TonTransactionRequest) => Promise<void>
}

/**
 * One wallet interface for both modes. Real mode drives TON Connect (Tonkeeper & co);
 * in dev mock mode "connecting" is a local flag so everything works without a wallet app.
 */
export function useTonWallet(): TonWallet {
  const { state } = useAuth()
  const isMock = state.status === 'authenticated' && state.session.isMock
  const [tonConnectUI] = useTonConnectUI()
  const realAddress = useTonAddress(true)
  const [mockConnected, setMockConnected] = useState(readMock)

  const connect = useCallback(() => {
    if (isMock) {
      writeMock(true)
      setMockConnected(true)
    } else {
      void tonConnectUI.openModal()
    }
  }, [isMock, tonConnectUI])

  const disconnect = useCallback(async () => {
    if (isMock) {
      writeMock(false)
      setMockConnected(false)
    } else {
      await tonConnectUI.disconnect()
    }
  }, [isMock, tonConnectUI])

  const send = useCallback(
    async (request: TonTransactionRequest) => {
      if (isMock) return
      // Same shape; TON Connect types the network as its CHAIN enum, whose values are these strings.
      await tonConnectUI.sendTransaction(request as unknown as SendTransactionRequest)
    },
    [isMock, tonConnectUI],
  )

  return isMock
    ? { connected: mockConnected, address: mockConnected ? MOCK_WALLET_ADDRESS : '', isMock, connect, disconnect, send }
    : { connected: realAddress !== '', address: realAddress, isMock, connect, disconnect, send }
}
