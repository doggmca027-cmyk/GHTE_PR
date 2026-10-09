import { Home, LayoutGrid, ReceiptText, Wallet, type LucideIcon } from 'lucide-react'
import { tr } from '@/i18n'

/** 'settings', 'support' and 'admin' are opened from the header buttons, not from the tab bar. */
export type TabId = 'home' | 'services' | 'orders' | 'wallet' | 'settings' | 'support' | 'admin'

export interface NavItem {
  id: TabId
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: tr('Home'), icon: Home },
  { id: 'services', label: tr('Services'), icon: LayoutGrid },
  { id: 'orders', label: tr('Orders'), icon: ReceiptText },
  { id: 'wallet', label: tr('Wallet'), icon: Wallet },
]
