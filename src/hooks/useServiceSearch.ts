import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseServiceQuery } from '@/lib/service-search'
import { SERVICES_PAGE, searchServices } from '@/services/api/services'
import type { AuthSession } from '@/services/api/auth'
import type { ICatalogService } from '@/types/catalog'

/** How long typing must pause before the database is asked: one request per pause, not one per letter. */
export const SEARCH_DEBOUNCE_MS = 300

export interface ServiceSearch {
  /** Something is typed: the results replace the normal list. */
  active: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: ICatalogService[]
  more: boolean
  loadingMore: boolean
  loadMore: () => void
  retry: () => void
}

/**
 * Searches the services of `categoryIds` for `query` (words and/or a country). A newer search makes an older answer that arrives
 * late irrelevant; the list is loaded a page at a time like a category's.
 */
export function useServiceSearch(session: AuthSession, categoryIds: readonly string[], query: string): ServiceSearch {
  const terms = useMemo(() => parseServiceQuery(query), [query])
  const scope = categoryIds.join(',')
  const [state, setState] = useState<{ status: ServiceSearch['status']; items: ICatalogService[]; more: boolean; loadingMore: boolean }>({
    status: 'idle', items: [], more: false, loadingMore: false,
  })
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    const mine = ++latest.current
    if (terms.length === 0 || scope === '') { setState({ status: 'idle', items: [], more: false, loadingMore: false }); return }
    setState((s) => ({ ...s, status: 'loading', loadingMore: false }))
    const timer = setTimeout(() => {
      searchServices(session, scope.split(','), terms, 0, SERVICES_PAGE).then(
        (items) => { if (latest.current === mine) setState({ status: 'ready', items, more: items.length === SERVICES_PAGE, loadingMore: false }) },
        () => { if (latest.current === mine) setState({ status: 'error', items: [], more: false, loadingMore: false }) },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [terms, scope, attempt, session.token, session.isMock]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (state.status !== 'ready' || state.loadingMore || !state.more) return
    const mine = ++latest.current
    const offset = state.items.length
    setState((s) => ({ ...s, loadingMore: true }))
    searchServices(session, scope.split(','), terms, offset, SERVICES_PAGE).then(
      (items) => { if (latest.current === mine) setState((s) => ({ ...s, items: [...s.items, ...items], more: items.length === SERVICES_PAGE, loadingMore: false })) },
      () => { if (latest.current === mine) setState((s) => ({ ...s, loadingMore: false })) },
    )
  }, [state, session, scope, terms])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return { active: terms.length > 0, ...state, loadMore, retry }
}
