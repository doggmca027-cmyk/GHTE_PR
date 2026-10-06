import { Layers, Send } from 'lucide-react'
import type { Platform } from '@/types/catalog'

interface Props {
  platform: Platform
  size?: number
  strokeWidth?: number
  className?: string
}

// lucide-react no longer ships brand logos, so these are minimal outline glyphs drawn to
// match lucide's 24px grid and stroke style.
export function PlatformIcon({ platform, size = 20, strokeWidth = 1.75, className }: Props) {
  if (platform === 'telegram') return <Send size={size} strokeWidth={strokeWidth} className={className} />

  const svg = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className, 'aria-hidden': true }

  switch (platform) {
    case 'instagram':
      return (
        <svg {...svg}>
          <rect x="3" y="3" width="18" height="18" rx="5.5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.3" cy="6.7" r="0.6" fill="currentColor" />
        </svg>
      )
    case 'tiktok':
      return (
        <svg {...svg}>
          <path d="M14 3v11.2a3.7 3.7 0 1 1-3.7-3.7" />
          <path d="M14 3c.3 2.6 2 4.4 4.7 4.7" />
        </svg>
      )
    case 'youtube':
      return (
        <svg {...svg}>
          <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
          <path d="M10 9.5v5l4.5-2.5z" />
        </svg>
      )
    default:
      return <Layers size={size} strokeWidth={strokeWidth} className={className} />
  }
}
