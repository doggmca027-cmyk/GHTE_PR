import type { Platform } from '@/types/catalog'

export interface PlatformTab {
  id: Platform
  label: string
}

export const PLATFORM_TABS: PlatformTab[] = [
  { id: 'telegram', label: 'Telegram' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube', label: 'YouTube' },
]
