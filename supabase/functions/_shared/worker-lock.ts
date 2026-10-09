// "Only one instance of this worker at a time", over HTTP.
//
// A scheduler that fires every minute will, whenever a run takes longer than a minute, start a second copy beside the first. For
// the order-status poll that doubles the calls to a provider that is already struggling. This module holds a LEASE in the
// database (worker_locks, see 20261111000100_resilience_and_alerts.sql): take it before working, free it afterwards; if the worker
// dies, the lease simply expires.
//
// Why not pg_try_advisory_lock: the Edge Functions reach Postgres through PostgREST, i.e. a pool of connections shared by every
// request. A session-level advisory lock would sit on whichever pooled connection ran the call and the later unlock would land on
// another one (the lock would leak until that connection is recycled); a transaction-level one ends with the very call that
// took it. A lease row is the same mutual exclusion without depending on which connection serves which request.

export interface LockRpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export type LockedRun<T> = { acquired: true; value: T } | { acquired: false }

/** How long a run may hold the lease. Longer than the platform's wall-clock limit, so a killed run frees itself soon after. */
export const DEFAULT_LEASE_SECONDS = 140

/**
 * Runs `work` only if the lease `name` can be taken. Returns { acquired: false } without running anything when another run holds it
 * (or when the lock cannot be checked: failing closed is right here, a duplicate poll costs more than a skipped minute).
 * The lease is always released afterwards, even if `work` throws; a failed release is harmless (the lease expires on its own).
 */
export async function withWorkerLock<T>(db: LockRpc, name: string, work: () => Promise<T>, ttlSeconds: number = DEFAULT_LEASE_SECONDS): Promise<LockedRun<T>> {
  let token: string | null = null
  try {
    const { data, error } = await db.rpc('try_acquire_worker_lock', { p_name: name, p_ttl_seconds: ttlSeconds })
    if (error || typeof data !== 'string') return { acquired: false }
    token = data
  } catch {
    return { acquired: false }
  }
  try {
    return { acquired: true, value: await work() }
  } finally {
    try {
      await db.rpc('release_worker_lock', { p_name: name, p_token: token })
    } catch { /* the lease expires by itself */ }
  }
}
