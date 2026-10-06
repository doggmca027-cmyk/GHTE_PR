import { Home, LayoutGrid, ReceiptText, Wallet, type LucideIcon } from 'lucide-react'

/** 'settings' and 'admin' are opened from the header buttons, not from the tab bar. */
export type TabId = 'home' | 'services' | 'orders' | 'wallet' | 'settings' | 'admin'

export interface NavItem {
  id: TabId
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'services', label: 'Services', icon: LayoutGrid },
  { id: 'orders', label: 'Orders', icon: ReceiptText },
  { id: 'wallet', label: 'Wallet', icon: Wallet },
]
