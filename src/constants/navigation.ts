import { Home, LayoutGrid, ReceiptText, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'

export type TabId = 'home' | 'services' | 'orders' | 'wallet' | 'admin'

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

/** Appended to the tab bar only for admins (the server still enforces access on every call). */
export const ADMIN_NAV_ITEM: NavItem = { id: 'admin', label: 'Admin', icon: ShieldCheck }
