// Client side of the product analytics: tell the server which screens and steps the customer went through (UI funnels).
// Built so that it cannot slow the interface down or leak anything:
//
//   * track() only pushes onto an array and returns: no await, no network, no layout. Sending happens later, in batches.
//   * ONE timer per batch window (default 4 s) and at most ONE request in flight; a burst of events is a single POST.
//   * the batch is sent in an idle moment (requestIdleCallback, falling back to a timer), and flushed with `keepalive` when the
//     app goes to the background, so the last screen is not lost
//   * every event is cleaned with the SAME allow-list the server uses (supabase/functions/_shared/analytics.ts): anything that
//     is not a listed event with listed, well-shaped properties is dropped HERE, before it can leave the phone
//   * failures are swallowed and the events dropped: analytics never retries in a loop, never throws and never shows an error
//   * nothing is sent in the dev mock mode or before the customer is signed in

import { cleanEvent, type CleanEvent } from '../../supabase/functions/_shared/analytics.ts'
import type { AuthSession } from '@/services/api/auth'

export const FLUSH_INTERVAL_MS = 4_000
export const MAX_QUEUE = 50
export const MAX_BATCH = 20
/** The same event repeated inside this window (a re-render, a double tap) is reported once. */
export const DEDUPE_MS = 2_000

export interface TrackerOptions {
  /** Sends one batch. Must resolve or reject; the tracker neither awaits it for anything but its own "in flight" flag. */
  send: (events: CleanEvent[], opts: { keepalive: boolean }) => Promise<unknown>
  flushIntervalMs?: number
  now?: () => number
  /** Runs `fn` when the browser is idle (or soon after). */
  whenIdle?: (fn: () => void) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const defaultIdle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback
  if (typeof ric === 'function') ric(fn, { timeout: 2_000 })
  else setTimeout(fn, 0)
}

export function createTracker(opts: TrackerOptions) {
  const interval = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS
  const now = opts.now ?? Date.now
  const idle = opts.whenIdle ?? defaultIdle
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let queue: CleanEvent[] = []
  let timer: unknown
  let inFlight = false
  let enabled = false
  const recent = new Map<string, number>()

  function send(keepalive: boolean) {
    if (!enabled || inFlight || queue.length === 0) return
    const batch = queue.slice(0, MAX_BATCH)
    queue = queue.slice(MAX_BATCH)
    inFlight = true
    let done: Promise<unknown>
    try {
      done = Promise.resolve(opts.send(batch, { keepalive }))
    } catch {
      done = Promise.resolve() // a throwing sender is the same as a failed request: the batch is dropped
    }
    void done.catch(() => {}).finally(() => {
      inFlight = false
      if (queue.length > 0) schedule() // more arrived while this one was in flight
    })
  }

  function schedule() {
    if (timer !== undefined || !enabled) return
    timer = setTimer(() => {
      timer = undefined
      idle(() => send(false))
    }, interval)
  }

  return {
    /** Turns sending on (signed in, real backend) or off. Turning it off also forgets what was queued. */
    setEnabled(value: boolean) {
      enabled = value
      if (!value) {
        queue = []
        recent.clear()
        if (timer !== undefined) clearTimer(timer)
        timer = undefined
      } else if (queue.length > 0) {
        schedule()
      }
    },

    /** Records an event. Synchronous, constant time, never throws. */
    track(name: string, properties?: Record<string, unknown>) {
      try {
        const e = cleanEvent({ name, properties })
        if (!e) return
        const t = now()
        const key = `${e.name}|${JSON.stringify(e.properties)}`
        const seen = recent.get(key)
        if (seen !== undefined && t - seen < DEDUPE_MS) return
        recent.set(key, t)
        if (recent.size > 100) for (const [k, v] of recent) if (t - v >= DEDUPE_MS) recent.delete(k)
        queue.push(e)
        if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE) // the oldest are the least useful
        schedule()
      } catch {
        /* analytics must never be able to break the app */
      }
    },

    /** Sends what is queued now (the app is being hidden): `keepalive` lets the request outlive the page. */
    flushNow() {
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      send(true)
    },

    /** For tests and diagnostics. */
    get pending() {
      return queue.length
    },
  }
}

// ---------------------------------------------------------------------------
// The app's tracker: wired to the signed-in session and to the track-event function
// ---------------------------------------------------------------------------
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const SEND_TIMEOUT_MS = 8_000

let token: string | null = null

async function post(events: CleanEvent[], { keepalive }: { keepalive: boolean }) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !token) return
  await fetch(`${SUPABASE_URL}/functions/v1/track-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: events.map((e) => ({ name: e.name, properties: e.properties })) }),
    keepalive,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
}

export const analytics = createTracker({ send: post })

/** Called when the signed-in session changes. Nothing is reported in the dev mock mode or while signed out. */
export function bindAnalytics(session: AuthSession | null) {
  token = session && !session.isMock ? session.token : null
  analytics.setEnabled(token !== null)
}

/** Shorthand for components: `track('orders_view')`. */
export const track = (name: string, properties?: Record<string, unknown>) => analytics.track(name, properties)

if (typeof document !== 'undefined') {
  // The app is going to the background: send what is left while the page can still do it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') analytics.flushNow()
  })
}
