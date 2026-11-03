import { useEffect, useRef, useState } from 'react'
import { cachedLoad, isFresh, peekCached } from '@/lib/catalog-cache'
import { fetchServiceBySku, type SkuHit } from '@/services/api/services'
import type { AuthSession } from '@/services/api/auth'

export type SkuLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'found'; hit: SkuHit }
  | { status: 'missing' }
  | { status: 'error' }

/** How long typing must pause before the article is looked up (a pasted article arrives whole, a typed one is complete only at its end). */
export const SKU_DEBOUNCE_MS = 150

type Settled = { sku: string } & ({ status: 'found'; hit: SkuHit } | { status: 'missing' } | { status: 'error' })

/**
 * Looks a card up by its article number across the whole catalogue: one exact-match request per article, kept in memory for a few minutes like the
 * rest of the catalogue (the same article asked again, or the screen left and re-entered, is answered at once). `sku` null: nothing is looked up.
 */
export function useSkuLookup(session: AuthSession, sku: string | null): SkuLookup & { retry: () => void } {
  const who = session.isMock ? 'mock' : 'public'
  const key = sku ? `sku:${who}:${sku}` : null
  const [settled, setSettled] = useState<Settled | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    const mine = ++latest.current
    if (!sku || !key) return
    const done = (hit: SkuHit | null) => {
      if (latest.current === mine) setSettled(hit ? { sku, status: 'found', hit } : { sku, status: 'missing' })
    }
    const known = peekCached<SkuHit | null>(key)
    if (known !== undefined && isFresh(key)) { done(known); return }
    const timer = setTimeout(() => {
      cachedLoad(key, () => fetchServiceBySku(session, sku)).then(done, () => {
        // what is in memory, even if stale, is better than an error
        if (latest.current === mine) setSettled(known !== undefined ? (known ? { sku, status: 'found', hit: known } : { sku, status: 'missing' }) : { sku, status: 'error' })
      })
    }, known === undefined ? SKU_DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  }, [sku, key, attempt, session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => { setSettled(null); setAttempt((n) => n + 1) }
  if (!sku || !key) return { status: 'idle', retry }
  // what is in memory is shown on the very render the article appears, without a frame of "loading"
  if (settled?.sku === sku) return { ...settled, retry }
  const known = peekCached<SkuHit | null>(key)
  if (known !== undefined) return { ...(known ? { status: 'found' as const, hit: known } : { status: 'missing' as const }), retry }
  return { status: 'loading', retry }
}
