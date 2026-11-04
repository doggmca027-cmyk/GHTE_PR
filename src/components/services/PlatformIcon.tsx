import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { platformColor, platformInitials } from '@/constants/platforms'
import { logoFailed, logoUrl, markLogoFailed, markLogoLoaded } from '@/lib/platform-logo'
import type { Platform } from '@/types/catalog'

interface Props {
  platform: Platform
  /** The platform's display name: its initials are shown for platforms without a drawn glyph. */
  name?: string
  size?: number
  strokeWidth?: number
  className?: string
}

// lucide-react no longer ships brand logos, so these are minimal outline glyphs drawn to
// match lucide's 24px grid and stroke style. Platforms without one show their initials.
export function PlatformIcon({ platform, name, size = 20, strokeWidth = 1.75, className }: Props) {
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
      return (
        <span aria-hidden="true" className={className} style={{ fontSize: Math.round(size * 0.62), lineHeight: 1, fontWeight: 800, letterSpacing: '-0.02em' }}>
          {platformInitials(name ?? platform.replace(/-/g, ' '))}
        </span>
      )
  }
}

/**
 * The platform's tile in the list. It starts as a coloured tile with the platform's initials; the brand logo is requested from the
 * SimpleIcons CDN (nothing is bundled) and replaces the initials only once it has actually loaded. If the request fails (offline,
 * blocked, no such brand: 404) or no logo exists for the platform, the tile simply stays. A failed logo is remembered for the session.
 */
export function PlatformBadge({ slug, name, size = 44 }: { slug: string; name: string; size?: number }) {
  const url = logoUrl(slug, name)
  // The white tile is shown only for an image that is really in this element: a logo that loaded before (a row mounted again, a list shown again) is
  // not taken on trust, because the new <img> may still be waiting for the network or have lost it, and a white tile with nothing in it is worse than
  // the initials. Until the element says it has the picture, the coloured tile stays.
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>(url === null || logoFailed(url) ? 'failed' : 'loading')
  const img = useRef<HTMLImageElement>(null)
  const retried = useRef(false)
  useEffect(() => {
    const el = img.current
    if (url !== null && el && el.complete && el.naturalWidth > 0) { markLogoLoaded(url); setStatus('loaded') } // from the cache before React listened
  }, [url])
  const loaded = status === 'loaded'
  return (
    <span
      aria-hidden="true"
      data-logo={status}
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-2xl font-extrabold text-white shadow-sm"
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.36), letterSpacing: '-0.02em',
        backgroundColor: loaded ? '#FFFFFF' : platformColor(slug), border: loaded ? '1px solid rgb(219 234 254 / 0.9)' : undefined,
      }}
    >
      {!loaded && platformInitials(name)}
      {url !== null && status !== 'failed' && (
        <img
          src={url}
          ref={img}
          alt=""
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => { markLogoLoaded(url); setStatus('loaded') }}
          onError={(e) => {
            // one more try (a dropped request in a mobile webview is common), then the tile with initials stays for the session
            if (!retried.current) { retried.current = true; const el = e.currentTarget; window.setTimeout(() => { el.src = `${url}?r=1` }, 1200); return }
            markLogoFailed(url)
            setStatus('failed')
          }}
          className={loaded ? 'h-[58%] w-[58%] object-contain' : 'absolute inset-0 h-full w-full opacity-0'}
        />
      )}
    </span>
  )
}
