// Keeping a request alive after its response has gone, so that the assistant's log can be written then.

/** The longest a request is kept alive for it: the log has its own timeout, this only makes sure a request is never held for good. */
export const HOLD_MAX_MS = 15_000

interface RequestContext {
  waitUntil?: (task: Promise<unknown>) => void
}

/** Vercel keeps the context of the request being served under this symbol (it is what the `@vercel/functions` package reads for `waitUntil`). */
const readVercelContext = (): RequestContext | undefined =>
  (globalThis as { [key: symbol]: { get?: () => RequestContext } | undefined })[Symbol.for('@vercel/request-context')]?.get?.()

/**
 * Takes a slot on the request's `waitUntil` and returns the function that releases it. `waitUntil` exists only inside a request, so the slot is taken
 * when the work is still ahead and released when it is done; in between the platform does not end the request, however long ago the response went.
 * The package itself is not used because its index pulls Node-only parts into an Edge bundle; this is the same lookup. Outside Vercel (a local run,
 * the tests) there is nothing to hold: the work just runs on, and the returned function does nothing.
 */
export function holdOpen(read: () => RequestContext | undefined = readVercelContext): () => void {
  const context = read()
  if (typeof context?.waitUntil !== 'function') return () => {}
  let release!: () => void
  context.waitUntil(new Promise<void>((resolve) => { release = resolve }))
  const timer = setTimeout(() => release(), HOLD_MAX_MS)
  return () => {
    clearTimeout(timer)
    release()
  }
}
