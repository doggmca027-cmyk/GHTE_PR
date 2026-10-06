import { useCallback, useEffect, useRef, useState } from 'react'

export interface LoaderState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

/** Runs an async loader on mount (and when `deps` change); keeps the previous data while reloading. */
export function useLoader<T>(fn: () => Promise<T>, deps: readonly unknown[] = []): LoaderState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const alive = useRef(true)

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = await fnRef.current()
      if (alive.current) setState({ data, error: null, loading: false })
    } catch (e) {
      if (alive.current) setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : 'Something went wrong.', loading: false }))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void reload()
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps])

  return { ...state, reload }
}
