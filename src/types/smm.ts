import type { OrderStatus } from '../../supabase/functions/_shared/types.ts'

export type { OrderStatus }
export type ServiceCategory = 'instagram' | 'telegram' | 'tiktok' | 'youtube' | 'other'

export interface IService {
  id: string
  providerId: string
  name: string
  category: ServiceCategory
  /** Price per 1000 units, in USD */
  rate: number
  min: number
  max: number
  description?: string
}


export interface IOrder {
  id: string
  serviceId: string
  link: string
  quantity: number
  charge: number
  status: OrderStatus
  createdAt: string
  startCount?: number
  remains?: number
}

export interface IWallet {
  balance: number
  currency: string
}

export type TransactionType = 'deposit' | 'order' | 'refund'

export interface ITransaction {
  id: string
  type: TransactionType
  amount: number
  createdAt: string
  orderId?: string
}
